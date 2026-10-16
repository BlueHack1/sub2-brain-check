import assert from 'node:assert/strict'
import test from 'node:test'
import { MockAgent } from 'undici'
import { resolveCodexIdentity } from '../src/codex-identity.js'
import { mapAccountModel, normalizeCodexModel } from '../src/codex-model.js'
import { SUB2_DEFAULT_VERSION } from '../src/sub2-defaults.js'
import { Sub2Client } from '../src/upstream.js'

test('Codex version follows manual setting, synced version, then official default; UA stays paired', () => {
  const settings = { openai_codex_client_version: '0.201.0', openai_codex_client_version_synced: '0.200.7',
    openai_codex_user_agent: 'codex-tui/0.1.0 (Linux; x86_64)' }
  assert.deepEqual(resolveCodexIdentity(settings, 'codex_vscode/0.2.0 (Windows; x86_64)'), {
    version: '0.201.0', originator: 'codex_vscode', userAgent: 'codex_vscode/0.201.0 (Windows; x86_64)',
  })
  assert.equal(resolveCodexIdentity({ ...settings, openai_codex_client_version: '' }).version, '0.200.7')
  assert.equal(resolveCodexIdentity({ openai_codex_client_version: 'invalid\r\nheader' }).version, SUB2_DEFAULT_VERSION)
  assert.equal(resolveCodexIdentity({ openai_codex_client_version: '0.100.0' }).version, SUB2_DEFAULT_VERSION)
  assert.equal(resolveCodexIdentity({}).originator, 'codex-tui')
  assert.equal(resolveCodexIdentity(settings, 'Mozilla/5.0').userAgent, 'codex-tui/0.201.0 (Linux; x86_64)')
  assert.deepEqual(resolveCodexIdentity(settings, 'custom/0.1.0 (Linux; x86_64) term (Codex Desktop; 0.1.0)'), {
    version: '0.201.0', originator: 'Codex Desktop',
    userAgent: 'Codex Desktop/0.201.0 (Linux; x86_64) term (Codex Desktop; 0.201.0)',
  })
})

test('connected Sub2 settings are cached and re-read after refreshing accounts', async () => {
  const mock = new MockAgent(); mock.disableNetConnect()
  const pool = mock.get('https://sub2.test')
  pool.intercept({ path: '/api/v1/admin/settings', headers: { 'x-api-key': 'admin-secret' } })
    .reply(200, { code: 0, data: { openai_codex_client_version_synced: '0.200.7', unrelated_secret: 'never-return' } })
  pool.intercept({ path: '/api/v1/admin/accounts?page=1&page_size=100&sort_by=id&sort_order=asc' })
    .reply(200, { code: 0, data: { items: [] } })
  try {
    const client = new Sub2Client('https://sub2.test', 'admin-secret', mock)
    const signal = new AbortController().signal
    assert.equal((await client.codexIdentity(signal)).version, '0.200.7')
    assert.equal((await client.codexIdentity(signal)).version, '0.200.7')
    assert.equal(client.identityState()?.source, 'sub2-synced')
    assert.equal(JSON.stringify(client.identityState()).includes('never-return'), false)
    await client.listAccounts(signal)
    pool.intercept({ path: '/api/v1/admin/settings' }).reply(200, { code: 0, data: { openai_codex_client_version_synced: '0.201.2' } })
    assert.equal((await client.codexIdentity(signal)).version, '0.201.2')
    mock.assertNoPendingInterceptors()
  } finally { await mock.close() }
})

test('missing settings endpoint has a visible fallback and preserves last successful settings', async () => {
  const mock = new MockAgent(); mock.disableNetConnect()
  const pool = mock.get('https://sub2.test')
  pool.intercept({ path: '/api/v1/admin/settings' }).reply(404, { message: 'not available' })
  try {
    const client = new Sub2Client('https://sub2.test', 'admin-secret', mock)
    const signal = new AbortController().signal
    assert.equal((await client.codexIdentity(signal)).version, SUB2_DEFAULT_VERSION)
    assert.ok(client.identityState()?.warning)
    pool.intercept({ path: '/api/v1/admin/accounts?page=1&page_size=100&sort_by=id&sort_order=asc' })
      .reply(200, { code: 0, data: { items: [] } }).persist()
    await client.listAccounts(signal)
    pool.intercept({ path: '/api/v1/admin/settings' }).reply(200, { code: 0, data: { openai_codex_client_version: '0.202.0' } })
    await client.codexIdentity(signal)
    assert.equal(client.identityState()?.warning, null)
    await client.listAccounts(signal)
    pool.intercept({ path: '/api/v1/admin/settings' }).reply(503, { message: 'unavailable' })
    assert.equal((await client.codexIdentity(signal)).version, '0.202.0')
    assert.match(client.identityState()!.warning!, /上次设置/)
  } finally { await mock.close() }
})

test('cancelling one concurrent probe does not cancel the shared Sub2 settings read', async () => {
  const mock = new MockAgent(); mock.disableNetConnect()
  mock.get('https://sub2.test').intercept({ path: '/api/v1/admin/settings' })
    .reply(200, { code: 0, data: { openai_codex_client_version_synced: '0.202.1' } }).delay(40)
  try {
    const client = new Sub2Client('https://sub2.test', 'admin', mock)
    const cancelled = new AbortController()
    const first = client.codexIdentity(cancelled.signal)
    const other = client.codexIdentity(new AbortController().signal)
    cancelled.abort()
    await assert.rejects(first, { name: 'AbortError' })
    assert.equal((await other).version, '0.202.1')
    mock.assertNoPendingInterceptors()
  } finally { await mock.close() }
})

test('mapping uses exact or longest trailing wildcard; OAuth normalizes aliases and preserves unknown IDs', () => {
  const mapping = { 'gpt-*': 'general', 'gpt-6*': 'specific', 'gpt-6.1-sol': 'exact', 'gpt*sol': 'unsupported' }
  assert.equal(mapAccountModel(mapping, 'gpt-6.1-sol'), 'exact')
  assert.equal(mapAccountModel(mapping, 'gpt-6-sol'), 'specific')
  assert.equal(mapAccountModel({ 'gpt*sol': 'wrong' }, 'gpt-6-sol'), 'gpt-6-sol')
  for (const [input, expected] of [
    ['provider/GPT_6.1_SOL_high', 'gpt-6.1-sol'], ['gpt-6-sol-2026-10-01', 'gpt-6-sol'],
    ['gpt-5.3codexspark', 'gpt-5.3-codex-spark'], ['gpt-5.1-codex', 'gpt-5.3-codex'],
    ['gpt-6', 'gpt-6-astra'], ['gpt-6.1-sol-openai-compact', 'gpt-6.1-sol'],
    ['my-private-model', 'my-private-model'],
  ]) assert.equal(normalizeCodexModel(input!), expected)
})
