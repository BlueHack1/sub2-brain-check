import { request, type Dispatcher } from 'undici'
import type { FirstTextProtocol } from './first-text-parser.js'
import { AccountTransports, type ExportedProxy } from './transport.js'
import { resolveCodexIdentity, normalizeVersion } from './codex-identity.js'

export interface Account {
  id: number
  name: string
  platform: string
  type: string
  status: string
  schedulable: boolean
  eligible: boolean
  unsupportedReason: string | null
}
export interface Credential {
  key: string
  baseUrl: string
  platform: string
  type: 'apikey' | 'oauth'
  protocol: FirstTextProtocol
  chatgptAccountId: string
  fedramp: boolean
  userAgent: string
  proxy?: ExportedProxy
  modelMapping: Record<string, unknown>
  headerOverrides: Record<string, unknown>
  headerOverrideEnabled: boolean
}
type RawAccount = Record<string, unknown>

export function safeMessage(value: unknown, secrets: string[] = []) {
  let message = value instanceof Error ? value.message : String(value || '')
  for (const secret of secrets) if (secret) message = message.split(secret).join('***')
  return message.replace(/\b(?:sk|xai)-[A-Za-z0-9_-]{12,}/gi, 'key-***')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer ***').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 2000)
}

export function normalizeOrigin(value: string) {
  let url: URL
  try { url = new URL(value.trim()) }
  catch { throw Object.assign(new Error('请输入有效的 Sub2 站点地址，例如 https://sub2.example.com'), { statusCode: 400 }) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw Object.assign(new Error('请输入 Sub2 站点地址，例如 https://sub2.example.com，不含路径或账号密码'), { statusCode: 400 })
  }
  return url.origin
}

export function publicAccount(raw: RawAccount): Account {
  const platform = String(raw.platform || '').trim().toLowerCase()
  const type = String(raw.type || '').trim().toLowerCase()
  const status = String(raw.status || '')
  const credentials = asRecord(raw.credentials)
  const unsupportedReason = platform !== 'openai' ? '仅支持 OpenAI 账号'
    : !['apikey', 'oauth'].includes(type) ? `暂不支持 ${type || '未知'} 凭据类型`
    : raw.parent_account_id != null ? '影子账号请使用持有凭据的父账号检测'
    : String(credentials.auth_mode || '').toLowerCase() === 'agent_identity' ? 'Agent Identity 使用请求签名，暂不支持直接 Token 检测' : null
  return { id: Number(raw.id), name: String(raw.name || `账号 #${raw.id}`),
    platform, type, status, schedulable: raw.schedulable === true,
    eligible: unsupportedReason === null, unsupportedReason }
}

export class Sub2Client {
  private readonly secrets = new Set<string>()
  private readonly transports = new AccountTransports()
  private identitySettings?: { values: Record<string, unknown>; expires: number }
  private identityRequest?: Promise<Record<string, unknown>>
  private identityWarning: string | null = null
  private readonly identityController = new AbortController()
  constructor(readonly origin: string, private adminKey: string, readonly dispatcher?: Dispatcher) {}

  redact(value: unknown) {
    return safeMessage(value, [this.adminKey, ...this.secrets])
  }

  sanitizeText(value: string) {
    let text = value
    for (const secret of [this.adminKey, ...this.secrets]) if (secret) text = text.split(secret).join('***')
    return text
  }

  private rememberSecrets(value: unknown, name = '') {
    if (typeof value === 'string' && /key|token|password|secret/i.test(name) && value.length > 2) this.secrets.add(value)
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) this.rememberSecrets(item, key)
    }
  }

  async admin<T>(path: string, signal?: AbortSignal, body?: Record<string, unknown>): Promise<T> {
    const response = await request(new URL(path, this.origin), {
      method: body === undefined ? 'GET' : 'POST', dispatcher: this.dispatcher,
      headersTimeout: 30_000, bodyTimeout: 30_000,
      signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
      headers: { accept: 'application/json', 'x-api-key': this.adminKey, 'x-admin-ui-request': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    try {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > 10 * 1024 * 1024) throw new Error('Sub2 响应超过 10 MB 限制')
        chunks.push(buffer)
      }
      let payload: Record<string, unknown>
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new Error(`Sub2 没有返回有效 JSON（HTTP ${response.statusCode}）`) }
      if (response.statusCode < 200 || response.statusCode >= 300 || (payload.code !== undefined && payload.code !== 0)) {
        const statusCode = [401, 403].includes(response.statusCode) ? response.statusCode : 502
        throw Object.assign(new Error(this.redact(payload.message || payload.detail || `Sub2 HTTP ${response.statusCode}`)), { statusCode })
      }
      return (payload.code !== undefined ? payload.data : payload) as T
    } finally { response.body.destroy() }
  }

  async listAccounts(signal?: AbortSignal) {
    if (this.identitySettings) this.identitySettings.expires = 0
    const accounts: Account[] = []
    for (let page = 1; page <= 100; page += 1) {
      const data = await this.admin<{ items: RawAccount[]; pages?: number; total?: number }>(
        `/api/v1/admin/accounts?page=${page}&page_size=100&sort_by=id&sort_order=asc`, signal)
      if (!data || !Array.isArray(data.items)) throw new Error('Sub2 账号管理列表响应格式不正确')
      const mapped = data.items.map(publicAccount)
      if (mapped.some(item => !Number.isSafeInteger(item.id) || item.id < 1)) throw new Error('Sub2 返回了无效账号 ID')
      accounts.push(...mapped.filter(account => account.platform === 'openai'))
      const pages = Number(data.pages) || (data.total ? Math.ceil(data.total / 100) : null)
      if ((pages !== null && page >= pages) || data.items.length < 100) return accounts
    }
    throw new Error('账号数量超过 100 页限制，请先缩小 Sub2 账号规模')
  }

  async credential(accountId: number, signal: AbortSignal): Promise<Credential> {
    const data = await this.admin<{ accounts?: RawAccount[]; proxies?: ExportedProxy[] }>(
      `/api/v1/admin/accounts/data?ids=${accountId}&include_proxies=true`, signal)
    this.rememberSecrets(data)
    const accounts = Array.isArray(data?.accounts) ? data.accounts : []
    // Official DataAccount is a portable export and intentionally has no ID/status.
    // The single-ID query is the association; never use an arbitrary batch item.
    const account = accounts.find(item => Number(item.id) === accountId)
      ?? (accounts.length === 1 && accounts[0]!.id == null ? accounts[0] : undefined)
    if (!account) throw new Error(`Sub2 未返回账号 #${accountId} 的唯一凭据；影子账号需选择其父账号检测`)
    const info = publicAccount(account)
    if (!info.eligible) throw new Error(info.unsupportedReason!)
    const credentials = asRecord(account.credentials)
    const type = info.type as Credential['type']
    const key = String(credentials[type === 'oauth' ? 'access_token' : 'api_key'] || '').trim()
    if (!key && type === 'apikey') throw new Error('管理员接口没有返回该上游账号的 API Key')
    const extra = asRecord(account.extra)
    const protocol: FirstTextProtocol = type === 'oauth' ? 'responses'
      : extra.openai_responses_mode === 'force_chat_completions' ? 'chat_completions'
      : extra.openai_responses_mode === 'force_responses' ? 'responses'
      : extra.openai_responses_supported === false ? 'chat_completions' : 'responses'
    const baseUrl = type === 'oauth' && info.platform === 'openai'
      ? 'https://chatgpt.com/backend-api/codex/responses'
      : String(credentials.base_url || '').trim() || 'https://api.openai.com'
    let valid = false
    try { const url = new URL(baseUrl); valid = url.protocol === 'https:' && !url.username && !url.password } catch { /* validate below */ }
    if (!valid) throw new Error('管理员接口没有返回有效的 HTTPS base_url')
    const proxyKey = account.proxy_key
    const proxy = proxyKey ? data.proxies?.find(item => item.proxy_key === proxyKey) : undefined
    if (proxyKey && !proxy && !this.dispatcher) throw new Error('账号绑定了代理，但 Sub2 未导出对应代理配置')
    const value: Credential = { key, baseUrl, platform: info.platform, type, protocol,
      chatgptAccountId: String(credentials.chatgpt_account_id || '').trim(), fedramp: fedrampFlag(credentials.chatgpt_account_is_fedramp),
      userAgent: String(credentials.user_agent || ''), proxy,
      modelMapping: asRecord(credentials.model_mapping), headerOverrides: asRecord(credentials.header_overrides),
      headerOverrideEnabled: credentials.header_override_enabled === true }
    return value
  }

  dispatcherFor(credential: Credential) {
    // An explicit local proxy/test dispatcher overrides account network settings.
    return this.dispatcher ?? this.transports.forProxy(credential.proxy)
  }

  async codexIdentity(signal: AbortSignal, accountUA = '') {
    signal.throwIfAborted()
    if (!this.identitySettings || this.identitySettings.expires <= Date.now()) {
      if (!this.identityRequest) {
        // A cancelled probe must not cancel this shared settings read for other probes.
        this.identityRequest = this.admin<Record<string, unknown>>('/api/v1/admin/settings',
          AbortSignal.any([this.identityController.signal, AbortSignal.timeout(5_000)])).then(raw => {
          // Retain only identity fields; settings can contain unrelated sensitive values.
          const values = Object.fromEntries(['openai_codex_client_version', 'openai_codex_client_version_synced',
            'openai_codex_user_agent'].map(key => [key, typeof raw?.[key] === 'string' ? raw[key] : '']))
          this.identitySettings = { values, expires: Date.now() + 60_000 }
          this.identityWarning = null
          return values
        }).catch(error => {
          if (this.identityController.signal.aborted) throw error
          const values = this.identitySettings?.values || {}
          this.identitySettings = { values, expires: Date.now() + 10_000 }
          this.identityWarning = `读取 Sub2 客户端设置失败，使用${Object.keys(values).length ? '上次设置' : '官方内置默认值'}：${this.redact(error)}`
          return values
        }).finally(() => { this.identityRequest = undefined })
      }
      await abortable(this.identityRequest, signal)
    }
    signal.throwIfAborted()
    return resolveCodexIdentity(this.identitySettings!.values, accountUA)
  }

  identityState() {
    const values = this.identitySettings?.values
    if (!values) return null
    const identity = resolveCodexIdentity(values)
    const manual = normalizeVersion(values.openai_codex_client_version)
    const synced = normalizeVersion(values.openai_codex_client_version_synced)
    const source = manual && manual === identity.version ? 'sub2-setting'
      : !manual && synced && synced === identity.version ? 'sub2-synced' : 'sub2-default'
    return { ...identity, source, warning: this.identityWarning }
  }

  async disableScheduling(accountId: number, signal: AbortSignal) {
    const result = await this.admin<RawAccount>(`/api/v1/admin/accounts/${accountId}/schedulable`, signal, { schedulable: false })
    if (Number(result?.id) !== accountId || result.schedulable !== false) {
      throw new Error('Sub2 未确认该账号的调度已关闭，请检查账号状态')
    }
  }

  clear() {
    this.identityController.abort()
    this.adminKey = ''; this.secrets.clear(); this.transports.clear(); this.identitySettings = undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function fedrampFlag(value: unknown) {
  return value === true || typeof value === 'number' && value !== 0
    || typeof value === 'string' && ['1', 't', 'T', 'true', 'TRUE', 'True'].includes(value.trim())
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
