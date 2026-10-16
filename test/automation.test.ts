import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockAgent } from 'undici'
import { Monitor } from '../src/monitor.js'
import { Sub2Client } from '../src/upstream.js'

const account = { id: 7, name: 'OpenAI account', platform: 'openai', type: 'apikey', status: 'active', schedulable: true }
const answers = Array.from({ length: 15 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}｜回答`).join('\n')
const cases = [
  { name: 'degraded answer disables scheduling', text: 'Q01｜不清楚', completed: true, http: 200, actionHTTP: 200, expected: 'degraded', action: 'disabled' },
  { name: 'failed disable remains visible alongside the degraded result', text: 'Q01｜不清楚', completed: true, http: 200, actionHTTP: 403, expected: 'degraded', action: 'error' },
  { name: 'an unconfirmed disable response is an action error', text: 'Q01｜不清楚', completed: true, http: 200, actionHTTP: 200, unconfirmed: true, expected: 'degraded', action: 'error' },
  { name: 'a complete passing answer leaves scheduling alone', text: answers, completed: true, http: 200, actionHTTP: 0, expected: 'success', action: undefined },
  { name: 'upstream authentication failure leaves scheduling alone', text: '', completed: false, http: 401, actionHTTP: 0, expected: 'error', action: undefined },
  { name: 'a truncated stream leaves scheduling alone', text: 'Q01｜回答', completed: false, http: 200, actionHTTP: 0, expected: 'error', action: undefined },
]

for (const scenario of cases) test(scenario.name, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sub2-action-'))
  const mock = new MockAgent(); mock.disableNetConnect()
  const sub2 = mock.get('https://sub2.test')
  sub2.intercept({ path: '/api/v1/admin/accounts?page=1&page_size=100&sort_by=id&sort_order=asc' })
    .reply(200, { code: 0, data: { items: [account, { ...account, id: 8, platform: 'grok' }], pages: 1 } })
  sub2.intercept({ path: '/api/v1/admin/accounts/data?ids=7&include_proxies=true' })
    .reply(200, { code: 0, data: { accounts: [{ platform: 'openai', type: 'apikey', credentials: {
      api_key: 'upstream-secret', base_url: 'https://provider.test',
    } }] } })
  let writes = 0
  // Observe *any* attempted write, including forbidden refresh or test calls.
  sub2.intercept({ path: /./, method: 'POST', headers: { 'x-api-key': 'admin-secret' } }).reply(scenario.actionHTTP || 500, options => {
    writes++
    assert.equal(options.path, '/api/v1/admin/accounts/7/schedulable')
    assert.deepEqual(JSON.parse(String(options.body)), { schedulable: false })
    return scenario.actionHTTP === 200 ? { code: 0, data: { id: 7, schedulable: Boolean(scenario.unconfirmed) } }
      : { code: 403, message: 'permission denied admin-secret' }
  }).persist()
  const body = scenario.http === 200
    ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: scenario.text })}\n\n`
      + (scenario.completed ? `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n` : '')
    : JSON.stringify({ error: { message: 'Unauthorized' } })
  mock.get('https://provider.test').intercept({ path: '/v1/responses', method: 'POST' }).reply(scenario.http, body)
  const client = new Sub2Client('https://sub2.test', 'admin-secret', mock)
  const accounts = await client.listAccounts()
  const monitor = await Monitor.create(client, accounts, directory)
  try {
    assert.equal(accounts.length, 1)
    await assert.rejects(monitor.enqueue([8]), /不支持/)
    await monitor.enqueue([7])
    for (let i = 0; i < 200 && monitor.snapshot().executor.active; i++) await new Promise(resolve => setTimeout(resolve, 5))
    const state = monitor.snapshot(), result = state.results['7']!
    assert.ok(result, JSON.stringify(state))
    assert.equal(result.status, scenario.expected, result.message)
    assert.equal(result.scheduling?.status, scenario.action)
    assert.equal(writes, scenario.expected === 'degraded' ? 1 : 0)
    assert.equal(state.accounts[0]?.schedulable, scenario.action !== 'disabled')
    if (scenario.action === 'error') assert.match(result.message, /关闭调度失败/)
    const files = await readdir(directory)
    const stored = await readFile(join(directory, files[0]!), 'utf8')
    assert.equal(stored.includes('admin-secret'), false)
    assert.equal(stored.includes('upstream-secret'), false)
    assert.equal(JSON.parse(stored).results['7'].scheduling?.status, scenario.action)
  } finally { await monitor.close(); await mock.close(); await rm(directory, { recursive: true, force: true }) }
})
