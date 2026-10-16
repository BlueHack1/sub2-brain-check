import assert from 'node:assert/strict'
import test from 'node:test'
import { MockAgent } from 'undici'
import { probeDegradation, endpointUrl } from '../src/probe.js'
import { DEFAULT_SETTINGS } from '../src/settings.js'
import { Sub2Client } from '../src/upstream.js'
import { assessDegradationCheckResponse } from '../src/assessment.js'
import type { TestEvent } from '../src/probe.js'
import { SUB2_DEFAULT_INSTRUCTIONS } from '../src/sub2-defaults.js'

const exportPath = '/api/v1/admin/accounts/data?ids=1&include_proxies=true'
const answers = Array.from({ length: 15 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}｜回答 ${i + 1}`).join('\n')

test('OAuth follows Codex upstream auth, headers and payload without using Sub2 test or refresh', async () => {
  const mock = new MockAgent(); mock.disableNetConnect()
  mock.get('https://sub2.test').intercept({ path: '/api/v1/admin/settings' }).reply(200,
    { code: 0, data: { openai_codex_client_version_synced: '0.200.7' } })
  mock.get('https://sub2.test').intercept({ path: exportPath, headers: { 'x-api-key': 'admin-secret' } })
    .reply(200, { code: 0, data: { accounts: [{ platform: 'openai', type: 'oauth', credentials: {
      access_token: 'oauth-secret', refresh_token: 'never-use-this', expires_at: 1,
      chatgpt_account_id: 'account-123', chatgpt_account_is_fedramp: true,
      base_url: 'https://ignored.test', user_agent: 'codex_vscode/0.100.0 (Windows; x86_64)',
      header_override_enabled: true, header_overrides: { 'x-custom-header': 'configured-value' },
    } }] } })
  let body: Record<string, unknown> = {}
  mock.get('https://chatgpt.com').intercept({ path: '/backend-api/codex/responses', method: 'POST', headers: {
    authorization: 'Bearer oauth-secret', 'chatgpt-account-id': 'account-123', 'x-openai-fedramp': 'true',
    'openai-beta': 'responses=experimental', originator: 'codex_vscode', version: '0.200.7',
    'user-agent': 'codex_vscode/0.200.7 (Windows; x86_64)',
  } }).reply(200, options => {
    assert.equal(JSON.stringify(options.headers).includes('x-custom-header'), false)
    body = JSON.parse(String(options.body))
    return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: answers })}\r\n\r\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output_text: answers } })}`
  })
  try {
    const events: TestEvent[] = []
    const result = await probeDegradation(new Sub2Client('https://sub2.test', 'admin-secret', mock), 1,
      DEFAULT_SETTINGS, new AbortController().signal, event => events.push(event))
    assert.equal(result.status, 'success', result.message)
    assert.equal(result.responseText, answers)
    assert.equal(body.store, false)
    assert.equal('max_output_tokens' in body, false)
    assert.equal(body.stream, true)
    assert.deepEqual(body.reasoning, { effort: 'high' })
    assert.match(JSON.stringify(body.input), /Q15/)
    assert.equal(body.instructions, SUB2_DEFAULT_INSTRUCTIONS)
    assert.deepEqual(events.map(event => event.type), ['test_start', 'content', 'test_complete'])
    assert.equal(events.at(-1)?.success, true)
    mock.assertNoPendingInterceptors()
  } finally { await mock.close() }
})

test('OAuth 401 is reported once; current credentials are re-read for the next detection, never refreshed', async () => {
  const mock = new MockAgent(); mock.disableNetConnect()
  let exports = 0, requests = 0
  mock.get('https://sub2.test').intercept({ path: exportPath }).reply(200, () => ({ code: 0, data: { accounts: [{
    platform: 'openai', type: 'oauth', credentials: { access_token: `oauth-token-${++exports}`, refresh_token: 'unused', expires_at: 1 },
  }] } })).times(2)
  mock.get('https://sub2.test').intercept({ path: '/api/v1/admin/settings' }).reply(200, { code: 0, data: {} })
  for (let number = 1; number <= 2; number++) {
    mock.get('https://chatgpt.com').intercept({ path: '/backend-api/codex/responses', method: 'POST',
      headers: { authorization: `Bearer oauth-token-${number}` } }).reply(401, () => {
      requests++; return { error: { message: `invalid oauth-token-${number}` } }
    })
  }
  try {
    const client = new Sub2Client('https://sub2.test', 'admin-secret', mock)
    for (let i = 1; i <= 2; i++) {
      const result = await probeDegradation(client, 1, DEFAULT_SETTINGS, new AbortController().signal)
      assert.equal(result.status, 'error')
      assert.equal(result.httpStatus, 401)
      assert.equal(result.message.includes(`oauth-token-${i}`), false)
      assert.equal(exports, i)
      assert.equal(requests, i)
    }
    mock.assertNoPendingInterceptors()
  } finally { await mock.close() }
})

test('API Responses uses Sub2 probe identity and filters protected account header overrides', async () => {
  const mock = new MockAgent(); mock.disableNetConnect()
  const pool = mock.get('https://sub2.test')
  pool.intercept({ path: exportPath }).reply(200, { code: 0, data: { accounts: [{
    platform: 'openai', type: 'apikey', credentials: { api_key: 'api-secret', base_url: 'https://provider.test/v1',
      header_override_enabled: true, header_overrides: {
        authorization: 'Bearer wrong', 'chatgpt-account-id': 'wrong-account', 'x-custom': ' custom-value ',
        'content-type': 'text/plain', 'bad header': 'bad', 'x-empty': ' ',
      }, model_mapping: { 'gpt-6.1-sol': 'provider-specific-model' },
    },
  }] } })
  pool.intercept({ path: '/api/v1/admin/settings' }).reply(200,
    { code: 0, data: { openai_codex_client_version: '0.201.0' } })
  mock.get('https://provider.test').intercept({ path: '/v1/responses', method: 'POST', headers: {
    authorization: 'Bearer api-secret', 'content-type': 'application/json',
    originator: 'codex-tui', version: '0.201.0', 'openai-beta': 'responses=experimental', 'x-custom': 'custom-value',
  } }).reply(200, options => {
    const headers = JSON.stringify(options.headers)
    assert.match(headers, /x-codex-window-id/)
    assert.equal(headers.includes('wrong-account'), false)
    const body = JSON.parse(String(options.body))
    assert.equal(body.model, 'provider-specific-model')
    assert.equal(body.instructions, SUB2_DEFAULT_INSTRUCTIONS)
    assert.equal('max_output_tokens' in body, false)
    return `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output_text: answers } })}\n\n`
  })
  try {
    const result = await probeDegradation(new Sub2Client('https://sub2.test', 'admin-secret', mock), 1,
      DEFAULT_SETTINGS, new AbortController().signal)
    assert.equal(result.status, 'success', result.message)
    mock.assertNoPendingInterceptors()
  } finally { await mock.close() }
})

test('Responses requires explicit completion and treats incomplete/error events as detection errors', async () => {
  const variants = [
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: answers })}\n\ndata: [DONE]\n\n`,
    `data: ${JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'server_is_overloaded' } } })}\n\n`,
    JSON.stringify({ output_text: answers }),
  ]
  for (const value of variants) {
    const mock = new MockAgent(); mock.disableNetConnect()
    mock.get('https://sub2.test').intercept({ path: '/api/v1/admin/settings' }).reply(200, { code: 0, data: {} })
    mock.get('https://sub2.test').intercept({ path: exportPath }).reply(200, { code: 0, data: { accounts: [{
      platform: 'openai', type: 'apikey', credentials: { api_key: 'upstream-secret', base_url: 'https://provider.test' },
    }] } })
    mock.get('https://provider.test').intercept({ path: '/v1/responses', method: 'POST' }).reply(200, value)
    try {
      const result = await probeDegradation(new Sub2Client('https://sub2.test', 'admin', mock), 1, DEFAULT_SETTINGS, new AbortController().signal)
      assert.equal(result.status, 'error', value)
      assert.equal(result.httpStatus, 200)
      mock.assertNoPendingInterceptors()
    } finally { await mock.close() }
  }
})

test('ambiguous portable credential exports fail instead of testing a different account', async () => {
  const mock = new MockAgent(); mock.disableNetConnect()
  mock.get('https://sub2.test').intercept({ path: exportPath }).reply(200, { code: 0, data: { accounts: [
    { platform: 'openai', type: 'apikey', credentials: { api_key: 'key-one' } },
    { platform: 'openai', type: 'apikey', credentials: { api_key: 'key-two' } },
  ] } })
  try {
    await assert.rejects(new Sub2Client('https://sub2.test', 'admin', mock).credential(1, new AbortController().signal), /唯一凭据/)
  } finally { await mock.close() }
})

test('Sub2 portable account exports without an ID or runtime status resolve credentials', async () => {
  const mock = new MockAgent(); mock.disableNetConnect()
  mock.get('https://sub2.test').intercept({ path: '/api/v1/admin/accounts/data?ids=1434&include_proxies=true' })
    .reply(200, { code: 0, data: { accounts: [{ name: 'exported channel', platform: 'openai', type: 'apikey',
      credentials: { api_key: 'exported-upstream-key', base_url: 'https://provider.test/v1' } }] } })
  try {
    const client = new Sub2Client('https://sub2.test', 'admin', mock)
    const credential = await client.credential(1434, new AbortController().signal)
    assert.equal(credential.key, 'exported-upstream-key')
    assert.equal(credential.platform, 'openai')
    assert.equal(credential.baseUrl, 'https://provider.test/v1')
  } finally { await mock.close() }
})

test('extracted assessment preserves the original missing/unclear-answer rule', () => {
  const lines = Array.from({ length: 15 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}｜${i === 6 ? '不清楚' : `回答 ${i + 1}`}`)
  assert.deepEqual(assessDegradationCheckResponse(lines.filter((_, i) => i !== 8).join('\n')),
    { status: 'degraded', answeredCount: 13, missingQuestions: [7, 9] })
  assert.equal(endpointUrl('https://provider.test/v1', '/v1/responses').href, 'https://provider.test/v1/responses')
  assert.equal(endpointUrl('https://provider.test/api', '/v1/chat/completions').pathname, '/api/v1/chat/completions')
})

test('OpenAI API key honors Chat Completions capability and configured request settings', async () => {
  const mock = new MockAgent(); mock.disableNetConnect()
  const account = { platform: 'openai', type: 'apikey', extra: { openai_responses_mode: 'force_chat_completions' }, credentials: { api_key: 'upstream-key', base_url: 'https://provider.test/v1' } }
  mock.get('https://sub2.test').intercept({ path: '/api/v1/admin/accounts/data?ids=1&include_proxies=true' })
    .reply(200, { code: 0, data: { accounts: [account] } })
  const provider = mock.get('https://provider.test')
  let body: Record<string, unknown> | undefined
  const answer = 'Q01｜回答\nQ02｜不清楚'
  provider.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    assert.equal(JSON.stringify(options.headers).includes('originator'), false)
    body = JSON.parse(String(options.body))
    return `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`
  })
  try {
    const client = new Sub2Client('https://sub2.test', 'admin', mock)
    const result = await probeDegradation(client, 1, { ...DEFAULT_SETTINGS, model: 'gpt-6-sol', reasoningEffort: 'low' }, new AbortController().signal)
    assert.equal(result.status, 'degraded', result.message)
    assert.equal(result.answeredCount, 1)
    assert.equal(result.responseText, answer)
    assert.equal(body?.model, 'gpt-6-sol')
    assert.equal(body?.reasoning_effort, 'low')
    assert.equal('max_tokens' in body!, false)
    mock.assertNoPendingInterceptors()
  } finally { await mock.close() }
})

test('first text timeout and total timeout abort slow requests independently', async () => {
  const mock = new MockAgent(); mock.disableNetConnect()
  mock.get('https://sub2.test').intercept({ path: '/api/v1/admin/settings' }).reply(200, { code: 0, data: {} })
  mock.get('https://sub2.test').intercept({ path: '/api/v1/admin/accounts/data?ids=1&include_proxies=true' })
    .reply(200, { code: 0, data: { accounts: [{ id: 1, platform: 'openai', type: 'apikey', status: 'active', credentials: { api_key: 'key', base_url: 'https://slow.test' } }] } }).persist()
  const provider = mock.get('https://slow.test')
  provider.intercept({ path: '/v1/responses', method: 'POST' }).reply(200, '{}').delay(200).persist()
  try {
    const client = new Sub2Client('https://sub2.test', 'admin', mock)
    const first = await probeDegradation(client, 1, { ...DEFAULT_SETTINGS, firstTextTimeoutMs: 20, totalTimeoutMs: 100 }, new AbortController().signal)
    assert.match(first.message, /首字超时/)
    const total = await probeDegradation(client, 1, { ...DEFAULT_SETTINGS, firstTextTimeoutMs: 200, totalTimeoutMs: 20 }, new AbortController().signal)
    assert.match(total.message, /总超时/)
  } finally { await mock.close() }
})
