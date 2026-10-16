import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Script, createContext } from 'node:vm'
import { DEFAULT_SETTINGS } from '../src/settings.js'

class Element {
  value = ''; textContent = ''; className = ''; checked = false; disabled = false; hidden = false
  children: Element[] = []
  listeners = new Map<string, Function[]>()
  fields = new Map<string, Element>()
  elements = { namedItem: (name: string) => this.fields.get(name)! }
  append(...items: Element[]) { this.children.push(...items) }
  replaceChildren() { this.children = [] }
  setAttribute() {}
  close() {}
  showModal() {}
  reportValidity() { return true }
  addEventListener(name: string, handler: Function) { this.listeners.set(name, [...this.listeners.get(name) || [], handler]) }
  async fire(name: string) {
    for (const handler of this.listeners.get(name) || []) await handler({ target: this, currentTarget: this, preventDefault() {} })
  }
}

function snapshot(ids: number[] = [1]) {
  return { origin: 'https://sub2.test', selectedAccountIds: ids, settings: { ...DEFAULT_SETTINGS },
    accounts: [1, 2].map(id => ({ id, name: `account-${id}`, eligible: true, platform: 'openai', type: 'oauth' })),
    results: {}, executor: { tasks: [], active: 0, queued: 0, concurrency: 2, queueLimit: 32, dropped: 0 },
    scheduler: { running: false, nextRunAt: null, lastError: null } }
}

async function setup(connected = true) {
  const elements = new Map<string, Element>()
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)! }
  for (const [name, value] of Object.entries(DEFAULT_SETTINGS)) {
    const input = new Element()
    if (name === 'enabled') input.checked = Boolean(value)
    else input.value = String(value)
    get('settings-form').fields.set(name, input)
  }
  let request: (path: string, options: any) => Promise<any> = async () => ({ authenticated: false })
  const context = createContext({
    document: { getElementById: get, createElement: () => new Element() }, Node: Element,
    fetch: async (path: string, options: any) => ({ ok: true, json: async () => request(path, options) }),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  })
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  const ui = await new Script(`(async () => { ${source}\nreturn { applyState, poll }; })()`).runInContext(context)
  if (connected) ui.applyState(snapshot(), true)
  return { get, ui, onRequest(handler: typeof request) { request = handler } }
}

test('selection counts include hidden accounts and saving preserves edits made during the request', async () => {
  const { get, onRequest } = await setup()
  assert.equal(get('selected-count').textContent, '已选 1 个 / 已保存 1 个')
  get('search').value = 'account-2'
  get('select-all').checked = true
  await get('select-all').fire('change')
  assert.equal(get('selected-count').textContent, '已选 2 个 / 已保存 1 个')
  assert.match(get('account-count').textContent, /列表中已选 1 个/)
  let finish!: (value: unknown) => void
  onRequest(async (path, options) => {
    assert.equal(path, '/api/accounts/selection')
    assert.deepEqual(JSON.parse(options.body), { selectedAccountIds: [1, 2] })
    return new Promise(resolve => { finish = resolve })
  })
  const saving = get('save-selection').fire('click')
  get('search').value = 'account-1'
  get('select-all').checked = false
  await get('select-all').fire('change')
  const interval = get('settings-form').fields.get('intervalSeconds')!
  interval.value = '600'
  await get('settings-form').fire('input')
  finish(snapshot([1, 2]))
  await saving
  assert.equal(get('selected-count').textContent, '已选 1 个 / 已保存 2 个')
  assert.equal(get('selection-status').textContent, '账号选择未保存')
  assert.equal(get('save-selection').disabled, false)
  assert.equal(interval.value, '600')
  onRequest(async (path, options) => {
    assert.equal(path, '/api/accounts/selection')
    assert.deepEqual(JSON.parse(options.body), { selectedAccountIds: [2] })
    return snapshot([2])
  })
  await get('save-selection').fire('click')
  assert.equal(get('selected-count').textContent, '已选 1 个 / 已保存 1 个')
  assert.equal(get('selection-status').textContent, '账号选择已保存')
  assert.equal(get('save-selection').disabled, true)
  assert.equal(interval.value, '600')
  assert.equal(get('unsaved').hidden, false)
})

test('a poll started before saving cannot restore the old saved selection', async () => {
  const { get, ui, onRequest } = await setup()
  let finishPoll!: (value: unknown) => void
  onRequest(async path => {
    if (path === '/api/state') return new Promise(resolve => { finishPoll = resolve })
    return snapshot([1, 2])
  })
  const polling = ui.poll()
  get('select-all').checked = true
  await get('select-all').fire('change')
  await get('save-selection').fire('click')
  finishPoll(snapshot([1]))
  await polling
  assert.equal(get('selected-count').textContent, '已选 2 个 / 已保存 2 个')
  assert.equal(get('selection-status').textContent, '账号选择已保存')
})

test('single page connects without losing settings, then saves current selection and starts', async () => {
  const { get, onRequest } = await setup(false)
  assert.equal(get('start-monitor').disabled, true)
  get('origin').value = 'https://sub2.test'
  get('admin-key').value = 'input-admin-key'
  const fields = get('settings-form').fields
  fields.get('intervalSeconds')!.value = '600'
  await get('settings-form').fire('input')
  onRequest(async (path, options) => {
    assert.equal(path, '/api/login')
    assert.deepEqual(JSON.parse(options.body), { origin: 'https://sub2.test', adminKey: 'input-admin-key' })
    return snapshot()
  })
  await get('login-form').fire('submit')
  assert.equal(get('admin-key').value, '')
  assert.equal(get('admin-key').disabled, true)
  assert.equal(get('origin').disabled, true)
  assert.equal(get('workspace').hidden, false)
  assert.equal(fields.get('intervalSeconds')!.value, '600')
  get('select-all').checked = true
  await get('select-all').fire('change')
  onRequest(async (path, options) => {
    assert.equal(path, '/api/monitor/start')
    const body = JSON.parse(options.body)
    assert.deepEqual(body.selectedAccountIds, [1, 2])
    assert.equal(body.settings.intervalSeconds, 600)
    assert.equal(body.settings.enabled, true)
    assert.equal('adminKey' in body, false)
    return { ...snapshot([1, 2]), settings: body.settings }
  })
  await get('start-monitor').fire('click')
  assert.equal(get('selected-count').textContent, '已选 2 个 / 已保存 2 个')
  assert.match(get('connection-status').textContent, /后台定时检测已开启/)
  onRequest(async path => {
    assert.equal(path, '/api/logout')
    return { ok: true }
  })
  await get('logout').fire('click')
  assert.equal(get('workspace').hidden, false)
  assert.equal(get('origin').disabled, false)
  assert.equal(get('admin-key').disabled, false)
  assert.equal(get('logout').hidden, true)
  assert.equal(get('start-monitor').disabled, true)
})
