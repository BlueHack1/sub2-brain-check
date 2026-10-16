import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockAgent } from 'undici'
import { buildApp } from '../src/app.js'
import { DEFAULT_SETTINGS } from '../src/settings.js'

const adminKey = 'test-admin-key-never-return'
const upstreamKey = 'test-upstream-key-never-return'
const rawAccount = { id: 1, name: '测试渠道', platform: 'openai', type: 'apikey', status: 'active', schedulable: true,
  credentials: { api_key: upstreamKey, base_url: 'https://provider.test/v1', model_mapping: { 'gpt-6.1-sol': 'mapped-model' } } }
const headers = { 'x-sub2-monitor': '1' }
const accountPath = '/api/v1/admin/accounts?page=1&page_size=100&sort_by=id&sort_order=asc'

test('login, configuration, real queue/probe flow, persistence and logout work without the parent project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sub2-monitor-'))
  const mock = new MockAgent()
  mock.disableNetConnect()
  const sub2 = mock.get('https://sub2.test')
  sub2.intercept({ path: accountPath, method: 'GET', headers: { 'x-api-key': adminKey } })
    .reply(200, { code: 0, data: { items: [rawAccount], pages: 1 } }).persist()
  sub2.intercept({ path: '/api/v1/admin/accounts/data?ids=1&include_proxies=true', method: 'GET', headers: { 'x-api-key': adminKey } })
    .reply(200, { code: 0, data: { accounts: [{ name: rawAccount.name, platform: rawAccount.platform, type: rawAccount.type, credentials: rawAccount.credentials }] } }).persist()
  const answers = Array.from({ length: 15 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}｜回答 ${i + 1}`).join('\n')
  let requestBody: Record<string, unknown> | undefined
  mock.get('https://provider.test').intercept({ path: '/v1/responses', method: 'POST', headers: { authorization: `Bearer ${upstreamKey}` } })
    .reply(200, options => {
      requestBody = JSON.parse(String(options.body))
      return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: answers })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output_text: answers } })}`
    }, { headers: { 'content-type': 'text/event-stream' } })
  const app = await buildApp({ dataDirectory: directory, dispatcher: mock })
  try {
    const page = await app.inject('/')
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Sub2/)
    assert.match(page.headers['content-security-policy']!, /script-src 'self'/)
    assert.equal((await app.inject('/api/state')).statusCode, 401)
    assert.equal((await app.inject({ url: '/api/login', method: 'POST', payload: { origin: 'https://sub2.test', adminKey } })).statusCode, 403)
    const login = await app.inject({ url: '/api/login', method: 'POST', headers, payload: { origin: 'https://sub2.test', adminKey } })
    assert.equal(login.statusCode, 200, login.body)
    assert.equal(login.body.includes(adminKey), false)
    assert.equal(login.body.includes(upstreamKey), false)
    assert.equal(login.json().accounts[0].eligible, true)
    assert.equal('credentials' in login.json().accounts[0], false)
    const cookie = String(login.headers['set-cookie']).split(';')[0]!
    const auth = { ...headers, cookie }
    assert.match(String(login.headers['set-cookie']), /HttpOnly/)
    assert.equal((await app.inject({ url: '/api/state', headers: { cookie: `${cookie}x` } })).statusCode, 401)
    assert.equal((await app.inject({ url: '/api/settings', method: 'PUT', headers: { ...auth, origin: 'https://evil.test' }, payload: {} })).statusCode, 403)
    const invalid = await app.inject({ url: '/api/settings', method: 'PUT', headers: auth,
      payload: { settings: { ...DEFAULT_SETTINGS, firstTextTimeoutMs: 2000, totalTimeoutMs: 1000 } } })
    assert.equal(invalid.statusCode, 400, invalid.body)
    const config = await app.inject({ url: '/api/settings', method: 'PUT', headers: auth,
      payload: { settings: { ...DEFAULT_SETTINGS, concurrency: 1, queueLimit: 0 } } })
    assert.equal(config.statusCode, 200, config.body)
    const selection = await app.inject({ url: '/api/accounts/selection', method: 'PUT', headers: auth,
      payload: { selectedAccountIds: [1] } })
    assert.equal(selection.statusCode, 200, selection.body)
    const run = await app.inject({ url: '/api/checks', method: 'POST', headers: auth, payload: {} })
    assert.equal(run.statusCode, 202, run.body)
    let snapshot = config.json()
    for (let i = 0; i < 200; i++) {
      snapshot = (await app.inject({ url: '/api/state', headers: { cookie } })).json()
      if (snapshot.results['1'] && snapshot.executor.active === 0) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(snapshot.results['1']?.status, 'success', JSON.stringify(snapshot))
    assert.equal(snapshot.results['1'].answeredCount, 15)
    assert.equal(snapshot.results['1'].responseText, answers)
    assert.equal(requestBody?.model, 'mapped-model')
    assert.deepEqual(requestBody?.reasoning, { effort: 'high' })
    assert.equal(snapshot.executor.tasks[0].status, 'completed')
    const files = await readdir(directory)
    assert.equal(files.length, 1)
    const stored = await readFile(join(directory, files[0]!), 'utf8')
    assert.equal(stored.includes(adminKey), false)
    assert.equal(stored.includes(upstreamKey), false)
    assert.deepEqual(JSON.parse(stored).selectedAccountIds, [1])
    assert.equal((await app.inject({ url: '/api/logout', method: 'POST', headers: auth, payload: {} })).statusCode, 200)
    assert.equal((await app.inject({ url: '/api/state', headers: { cookie } })).statusCode, 401)
    const relogin = await app.inject({ url: '/api/login', method: 'POST', headers, payload: { origin: 'https://sub2.test', adminKey } })
    assert.equal(relogin.statusCode, 200, relogin.body)
    assert.equal(relogin.json().results['1'].status, 'success')
    assert.deepEqual(relogin.json().selectedAccountIds, [1])
    assert.equal(relogin.json().executor.tasks.length, 0)
  } finally { await app.close(); await mock.close(); await rm(directory, { recursive: true, force: true }) }
})

test('invalid administrator key creates no session and error messages redact the key', async () => {
  const mock = new MockAgent(); mock.disableNetConnect()
  mock.get('https://sub2.test').intercept({ path: accountPath }).reply(401, { message: `Rejected ${adminKey}` })
  const app = await buildApp({ dispatcher: mock })
  try {
    const response = await app.inject({ url: '/api/login', method: 'POST', headers, payload: { origin: 'https://sub2.test', adminKey } })
    assert.equal(response.statusCode, 401)
    assert.equal(response.body.includes(adminKey), false)
    assert.equal((await app.inject('/api/session')).json().authenticated, false)
  } finally { await app.close(); await mock.close() }
})

test('account selection and settings save independently, reject invalid saves atomically, and survive login', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sub2-selection-'))
  const mock = new MockAgent(); mock.disableNetConnect()
  mock.get('https://sub2.test').intercept({ path: accountPath }).reply(200,
    { code: 0, data: { items: [rawAccount, { ...rawAccount, id: 2 }], pages: 1 } }).persist()
  const app = await buildApp({ dataDirectory: directory, dispatcher: mock })
  try {
    const login = await app.inject({ url: '/api/login', method: 'POST', headers, payload: { origin: 'https://sub2.test', adminKey } })
    const auth = { ...headers, cookie: String(login.headers['set-cookie']).split(';')[0]! }
    const selection = await app.inject({ url: '/api/accounts/selection', method: 'PUT', headers: auth,
      payload: { selectedAccountIds: [1, 1] } })
    assert.equal(selection.statusCode, 200, selection.body)
    assert.deepEqual(selection.json().selectedAccountIds, [1])
    assert.deepEqual(selection.json().settings, DEFAULT_SETTINGS)
    const settings = { ...DEFAULT_SETTINGS, reasoningEffort: 'medium', concurrency: 1, queueLimit: 0 }
    const updates = await Promise.all([
      app.inject({ url: '/api/settings', method: 'PUT', headers: auth, payload: { settings } }),
      app.inject({ url: '/api/accounts/selection', method: 'PUT', headers: auth, payload: { selectedAccountIds: [2] } }),
    ])
    for (const response of updates) assert.equal(response.statusCode, 200, response.body)
    const snapshot = (await app.inject({ url: '/api/state', headers: auth })).json()
    assert.deepEqual(snapshot.selectedAccountIds, [2])
    assert.deepEqual(snapshot.settings, settings)
    const overCapacity = await app.inject({ url: '/api/accounts/selection', method: 'PUT', headers: auth,
      payload: { selectedAccountIds: [1, 2] } })
    assert.equal(overCapacity.statusCode, 409)
    const unknown = await app.inject({ url: '/api/accounts/selection', method: 'PUT', headers: auth,
      payload: { selectedAccountIds: [99] } })
    assert.equal(unknown.statusCode, 400)
    const refresh = await app.inject({ url: '/api/accounts/refresh', method: 'POST', headers: auth, payload: {} })
    assert.deepEqual(refresh.json().selectedAccountIds, [2])
    const stored = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]!), 'utf8'))
    assert.deepEqual(stored.selectedAccountIds, [2])
    assert.deepEqual(stored.settings, settings)
    await app.inject({ url: '/api/logout', method: 'POST', headers: auth, payload: {} })
    const relogin = await app.inject({ url: '/api/login', method: 'POST', headers, payload: { origin: 'https://sub2.test', adminKey } })
    assert.deepEqual(relogin.json().selectedAccountIds, [2])
    assert.deepEqual(relogin.json().settings, settings)
    const cleared = await app.inject({ url: '/api/accounts/selection', method: 'PUT',
      headers: { ...headers, cookie: String(relogin.headers['set-cookie']).split(';')[0]! }, payload: { selectedAccountIds: [] } })
    assert.equal(cleared.statusCode, 200)
    assert.deepEqual(cleared.json().selectedAccountIds, [])
  } finally { await app.close(); await mock.close(); await rm(directory, { recursive: true, force: true }) }
})

test('save and start runs immediately with current settings; reconnect resumes saved scheduling', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sub2-scheduler-'))
  const mock = new MockAgent(); mock.disableNetConnect()
  const sub2 = mock.get('https://sub2.test')
  sub2.intercept({ path: accountPath }).reply(200, { code: 0, data: { items: [rawAccount], pages: 1 } }).persist()
  sub2.intercept({ path: '/api/v1/admin/accounts/data?ids=1&include_proxies=true' })
    .reply(200, { code: 0, data: { accounts: [rawAccount] } }).persist()
  let checks = 0
  let requestedModel = ''
  mock.get('https://provider.test').intercept({ path: '/v1/responses', method: 'POST' })
    .reply(200, options => { checks++; requestedModel = JSON.parse(String(options.body)).model; return { status: 'completed', output_text: Array.from({ length: 15 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}｜测试答案`).join('\n') } }).persist()
  let app = await buildApp({ dataDirectory: directory, dispatcher: mock })
  const login = async (expectedEnabled = false) => {
    const response = await app.inject({ url: '/api/login', method: 'POST', headers, payload: { origin: 'https://sub2.test', adminKey } })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().settings.enabled, expectedEnabled)
    assert.equal(response.json().executor.active, 0)
    return { ...headers, cookie: String(response.headers['set-cookie']).split(';')[0]! }
  }
  const waitForChecks = async (count: number) => {
    for (let i = 0; i < 150 && checks < count; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(checks, count)
  }
  try {
    const auth = await login()
    const empty = await app.inject({ url: '/api/monitor/start', method: 'POST', headers: auth,
      payload: { settings: DEFAULT_SETTINGS, selectedAccountIds: [] } })
    assert.equal(empty.statusCode, 400)
    const invalid = await app.inject({ url: '/api/monitor/start', method: 'POST', headers: auth,
      payload: { settings: DEFAULT_SETTINGS, selectedAccountIds: [99] } })
    assert.equal(invalid.statusCode, 400)
    assert.equal((await app.inject({ url: '/api/state', headers: auth })).json().settings.enabled, false)
    const settings = { ...DEFAULT_SETTINGS, model: 'gpt-6-astra', reasoningEffort: 'low', intervalSeconds: 30 }
    const response = await app.inject({ url: '/api/monitor/start', method: 'POST', headers: auth,
      payload: { settings, selectedAccountIds: [1] } })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().settings.enabled, true)
    assert.deepEqual(response.json().selectedAccountIds, [1])
    await waitForChecks(1)
    assert.equal(requestedModel, 'gpt-6-astra')
    // A disconnected browser has no cookie; this must not clear the running monitor.
    assert.equal((await app.inject('/api/state')).statusCode, 401)
    assert.equal((await app.inject({ url: '/api/state', headers: auth })).json().settings.enabled, true)
    await app.close()
    app = await buildApp({ dataDirectory: directory, dispatcher: mock })
    assert.equal((await app.inject('/api/session')).json().authenticated, false)
    const reconnectAuth = await login(true)
    assert.equal(checks, 1)
    await waitForChecks(2)
    assert.equal((await app.inject({ url: '/api/state', headers: reconnectAuth })).json().settings.enabled, true)
  } finally { await app.close(); await mock.close(); await rm(directory, { recursive: true, force: true }) }
})

test('background detection continues after 13 hours without page access until explicit key removal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sub2-background-'))
  const mock = new MockAgent(); mock.disableNetConnect()
  const pool = mock.get('https://sub2.test')
  pool.intercept({ path: accountPath }).reply(200, { code: 0, data: { items: [rawAccount] } }).persist()
  pool.intercept({ path: '/api/v1/admin/accounts/data?ids=1&include_proxies=true' })
    .reply(200, { code: 0, data: { accounts: [rawAccount] } }).persist()
  pool.intercept({ path: '/api/v1/admin/settings' }).reply(200, { code: 0, data: {} }).persist()
  let checks = 0
  mock.get('https://provider.test').intercept({ path: '/v1/responses', method: 'POST' }).reply(200, () => {
    checks++
    return { status: 'completed', output_text: Array.from({ length: 15 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}｜测试答案`).join('\n') }
  }).persist()
  const app = await buildApp({ dataDirectory: directory, dispatcher: mock })
  try {
    const login = await app.inject({ url: '/api/login', method: 'POST', headers, payload: { origin: 'https://sub2.test', adminKey } })
    const auth = { ...headers, cookie: String(login.headers['set-cookie']).split(';')[0]! }
    await app.inject({ url: '/api/monitor/start', method: 'POST', headers: auth,
      payload: { settings: { ...DEFAULT_SETTINGS, intervalSeconds: 30 }, selectedAccountIds: [1] } })
    for (let i = 0; i < 100 && checks < 1; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(checks, 1)
    const later = Date.now() + 13 * 60 * 60 * 1000
    t.mock.method(Date, 'now', () => later)
    // No frontend polling during this interval; the backend timer must launch the next round.
    for (let i = 0; i < 150 && checks < 2; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(checks, 2)
    assert.equal((await app.inject({ url: '/api/session', headers: auth })).json().authenticated, true)
    assert.equal((await app.inject({ url: '/api/state', headers: auth })).json().settings.enabled, true)
    const logout = await app.inject({ url: '/api/logout', method: 'POST', headers: auth, payload: {} })
    assert.equal(logout.statusCode, 200)
    assert.equal((await app.inject({ url: '/api/session', headers: auth })).json().authenticated, false)
    assert.equal((await app.inject({ url: '/api/state', headers: auth })).statusCode, 401)
  } finally { t.mock.restoreAll(); await app.close(); await mock.close(); await rm(directory, { recursive: true, force: true }) }
})
