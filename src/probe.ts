import { randomUUID } from 'node:crypto'
import { validateHeaderName, validateHeaderValue } from 'node:http'
import { StringDecoder } from 'node:string_decoder'
import { request } from 'undici'
import { DEGRADATION_CHECK_PROMPT, assessDegradationCheckResponse } from './assessment.js'
import { extractCompletedFirstText, extractStreamingFirstText } from './first-text-parser.js'
import type { Settings } from './settings.js'
import type { CheckResult } from './store.js'
import { Sub2Client, type Credential } from './upstream.js'
import type { CodexIdentity } from './codex-identity.js'
import { mapAccountModel, normalizeCodexModel } from './codex-model.js'
import { SUB2_DEFAULT_INSTRUCTIONS, SUB2_BLOCKED_OVERRIDE_HEADERS } from './sub2-defaults.js'

export interface TestEvent {
  type: 'test_start' | 'content' | 'error' | 'test_complete'
  model?: string
  text?: string
  error?: string
  success?: boolean
}
export type TestEventListener = (event: TestEvent) => void

export function endpointUrl(baseUrl: string, endpoint: string) {
  const parsed = new URL(baseUrl)
  const relative = endpoint.replace(/^\/v1/, '')
  let path = parsed.pathname.replace(/\/+$/, '')
  if (!path.endsWith(endpoint) && !path.endsWith(relative)) {
    path = /\/v\d+(?:\.\d+)?(?:alpha|beta|preview)?$/i.test(path) ? path + relative : path + endpoint
  }
  parsed.pathname = path
  parsed.search = ''
  parsed.hash = ''
  return parsed
}

function requestBody(credential: Credential, model: string, effort: Settings['reasoningEffort']) {
  if (credential.protocol === 'chat_completions') return {
    model, messages: [{ role: 'user', content: DEGRADATION_CHECK_PROMPT }],
    reasoning_effort: effort, stream: true,
  }
  return {
    model, input: [{ role: 'user', content: [{ type: 'input_text', text: DEGRADATION_CHECK_PROMPT }] }],
    instructions: SUB2_DEFAULT_INSTRUCTIONS,
    reasoning: { effort }, stream: true,
    // ChatGPT Codex rejects max_output_tokens. Match the official OAuth payload.
    ...(credential.type === 'oauth' ? { store: false } : {}),
  }
}

function requestHeaders(credential: Credential, identity?: CodexIdentity) {
  const values: Record<string, string> = {
    accept: 'text/event-stream', authorization: `Bearer ${credential.key}`, 'content-type': 'application/json',
  }
  if (identity) {
    values['user-agent'] = identity.userAgent
    values.originator = identity.originator
    values.version = identity.version
    values['openai-beta'] = 'responses=experimental'
    if (credential.type === 'oauth') {
      if (credential.chatgptAccountId) values['chatgpt-account-id'] = credential.chatgptAccountId
      if (credential.fedramp) values['x-openai-fedramp'] = 'true'
    } else if (credential.protocol === 'responses') values['x-codex-window-id'] = randomUUID()
  }
  // Sub2 permits OpenAI header overrides only on API Key accounts and filters protected headers.
  if (credential.type === 'apikey' && credential.headerOverrideEnabled) {
    for (const [name, value] of Object.entries(credential.headerOverrides)) {
      const key = name.trim().toLowerCase()
      if (!key || key.length > 200 || SUB2_BLOCKED_OVERRIDE_HEADERS.includes(key) || typeof value !== 'string') continue
      const trimmed = value.trim()
      if (!trimmed || trimmed.length > 8192) continue
      try { validateHeaderName(key); validateHeaderValue(key, trimmed) } catch { continue }
      values[key] = trimmed
    }
  }
  return values
}

function parseJSON(value: string): Record<string, unknown> | null {
  try { const parsed: unknown = JSON.parse(value); return record(parsed) } catch { return null }
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function eventError(payload: Record<string, unknown> | null) {
  if (!payload) return ''
  const response = record(payload.response)
  const error = payload.error || response?.error
  if (error && typeof error === 'object') return String(record(error)?.message || '上游流返回错误')
  if (error) return String(error)
  if (['error', 'response.failed', 'response.incomplete'].includes(String(payload.type))
    || ['failed', 'incomplete', 'cancelled'].includes(String(response?.status || payload.status))) {
    return String(payload.message || record(response?.incomplete_details || payload.incomplete_details)?.reason || '上游响应未完整完成')
  }
  return ''
}

async function runProbe(client: Sub2Client, credential: Credential, settings: Settings, signal: AbortSignal,
  firstText: () => void, emit: TestEventListener, identity?: CodexIdentity): Promise<CheckResult> {
  const mapped = mapAccountModel(credential.modelMapping, settings.model)
  const model = credential.type === 'oauth' ? normalizeCodexModel(mapped) : mapped
  const protocol = credential.protocol
  emit({ type: 'test_start', model })
  const response = await request(endpointUrl(credential.baseUrl, protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions'), {
    method: 'POST', dispatcher: client.dispatcherFor(credential), signal,
    headersTimeout: settings.totalTimeoutMs, bodyTimeout: settings.totalTimeoutMs,
    headers: requestHeaders(credential, identity), body: JSON.stringify(requestBody(credential, model, settings.reasoningEffort)),
  })
  let text = '', finalText = ''
  try {
    const decoder = new StringDecoder('utf8')
    let raw = '', buffer = '', bytes = 0, complete = false, sse = false
    let dataLines: string[] = []
    const consume = (data: string) => {
      if (!data.trim()) return
      if (data.trim() === '[DONE]') {
        if (protocol === 'chat_completions') complete = true
        return
      }
      const payload = parseJSON(data)
      if (!payload) throw new Error('上游 SSE 包含无效 JSON')
      const error = eventError(payload)
      if (error) throw new Error(client.redact(error))
      const delta = extractStreamingFirstText(payload, protocol)
      const final = extractCompletedFirstText(payload, protocol)
      if (delta || final) firstText()
      if (delta) { text += delta; emit({ type: 'content', text: client.sanitizeText(delta) }) }
      if (final) finalText = final
      if (protocol === 'responses') {
        if (['response.completed', 'response.done'].includes(String(payload.type))) complete = true
      } else {
        const choices = Array.isArray(payload.choices) ? payload.choices : []
        const reason = record(choices[0])?.finish_reason
        if (reason === 'length' || reason === 'content_filter') throw new Error(`上游回答被截断（${reason}）`)
        if (reason != null) complete = true
      }
    }
    const flush = () => { if (dataLines.length) { const data = dataLines.join('\n'); dataLines = []; consume(data) } }
    const readLine = (line: string) => {
      line = line.replace(/\r$/, '')
      if (line === '') { flush(); return }
      if (line.startsWith('data:')) { sse = true; dataLines.push(line.slice(5).replace(/^ /, '')) }
    }
    for await (const chunk of response.body) {
      const part = Buffer.from(chunk)
      bytes += part.length
      if (bytes > 512 * 1024) throw new Error('降智检测响应超过 512 KB 限制')
      const value = decoder.write(part)
      raw += value
      if (response.statusCode < 200 || response.statusCode >= 300) continue
      buffer += value
      let newline = buffer.indexOf('\n')
      while (newline >= 0 && !complete) {
        readLine(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      if (complete) break
    }
    const tail = decoder.end(); raw += tail; buffer += tail
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const payload = parseJSON(raw)
      const detail = eventError(payload) || payload?.message || payload?.detail || raw
      return failure(`HTTP ${response.statusCode}：${client.redact(detail)}`, model, settings.reasoningEffort, response.statusCode)
    }
    if (!complete) {
      if (buffer.trim()) readLine(buffer)
      flush()
    }
    if (!sse) {
      const payload = parseJSON(raw)
      const error = eventError(payload)
      if (error) throw new Error(client.redact(error))
      finalText = extractCompletedFirstText(payload, protocol)
      if (finalText) firstText()
      if (protocol === 'responses') complete = (record(payload?.response)?.status || payload?.status) === 'completed'
      else {
        const choices = Array.isArray(payload?.choices) ? payload.choices : []
        const reason = record(choices[0])?.finish_reason
        complete = reason === 'stop'
      }
    }
    if (!complete) throw new Error('上游流未完整结束，未收到完成事件；本次不作降智判定')
    const responseText = client.sanitizeText(finalText || text)
    if (!responseText.trim()) throw new Error('上游已结束，但未返回文本回答')
    if (!text && finalText) emit({ type: 'content', text: responseText })
    const assessment = assessDegradationCheckResponse(responseText)
    return { ...assessment, responseText, model, reasoningEffort: settings.reasoningEffort,
      httpStatus: response.statusCode, checkedAt: new Date().toISOString(),
      message: assessment.status === 'success' ? '已完整回答 Q01-Q15'
        : `回答不完整，缺少 ${assessment.missingQuestions.map(id => `Q${String(id).padStart(2, '0')}`).join('、')}` }
  } catch (error) {
    if (signal.aborted) throw error
    return { ...failure(client.redact(error), model, settings.reasoningEffort, response.statusCode),
      responseText: client.sanitizeText(finalText || text) }
  } finally { response.body.destroy() }
}

export function failure(message: string, model: string | null = null, reasoningEffort: Settings['reasoningEffort'] | null = null, httpStatus: number | null = null): CheckResult {
  return { status: 'error', responseText: '', answeredCount: 0, missingQuestions: Array.from({ length: 15 }, (_, i) => i + 1),
    model, reasoningEffort, httpStatus, message, checkedAt: new Date().toISOString() }
}

export async function probeDegradation(client: Sub2Client, accountId: number, settings: Settings,
  externalSignal: AbortSignal, emit: TestEventListener = () => {}): Promise<CheckResult> {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, externalSignal])
  const deadline = setTimeout(() => controller.abort(), settings.totalTimeoutMs)
  let firstDeadline: ReturnType<typeof setTimeout> | undefined
  let firstTimedOut = false
  const markFirst = () => { clearTimeout(firstDeadline); firstDeadline = undefined }
  let result: CheckResult
  try {
    // Read the credentials managed by Sub2. Never refresh tokens or retry authorization.
    const credential = await client.credential(accountId, signal)
    if (!credential.key) throw new Error('Sub2 未提供 OAuth access_token，请在 Sub2 中检查账号后重新获取')
    const identity = credential.protocol === 'responses'
      ? await client.codexIdentity(signal, credential.type === 'oauth' ? credential.userAgent : '') : undefined
    firstDeadline = setTimeout(() => { firstTimedOut = true; controller.abort() }, settings.firstTextTimeoutMs)
    result = await runProbe(client, credential, settings, signal, markFirst, emit, identity)
  } catch (error) {
    if (externalSignal.aborted) throw new Error('检测已取消')
    result = failure(controller.signal.aborted
      ? firstTimedOut ? `降智检测首字超时（${settings.firstTextTimeoutMs} ms）` : `降智检测总超时（${settings.totalTimeoutMs} ms）`
      : client.redact(error), settings.model, settings.reasoningEffort)
  } finally { clearTimeout(deadline); clearTimeout(firstDeadline) }
  if (result.status === 'error') emit({ type: 'error', error: result.message })
  emit({ type: 'test_complete', success: result.status !== 'error' })
  return result
}
