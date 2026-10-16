const $ = id => document.getElementById(id)
const form = $('settings-form')
const names = ['enabled', 'model', 'reasoningEffort', 'intervalSeconds', 'concurrency', 'queueLimit', 'firstTextTimeoutMs', 'totalTimeoutMs']
const labels = { success: '通过', degraded: '疑似降智', error: '检测异常', queued: '等待中', running: '检测中', completed: '已完成', failed: '执行失败', cancelled: '已取消' }
let state = null
let selected = new Set()
let pendingUpdates = 0
let stateEpoch = 0
let polling = false
let interval
let noticeTimer
let authVersion = 0
let connectionSettingsEdited = false

function notify(message, error = false) {
  $('notice').textContent = message
  $('notice').className = error ? 'error' : ''
  $('notice').hidden = false
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { $('notice').hidden = true }, error ? 10000 : 4500)
}

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { 'x-sub2-monitor': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const value = await response.json()
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') showLogin()
    throw new Error(value.message || `请求失败（${response.status}）`)
  }
  return value
}

function showLogin() {
  authVersion += 1
  clearInterval(interval)
  state = null
  selected = new Set()
  $('workspace').hidden = false
  $('logout').hidden = true
  $('origin').disabled = false
  $('admin-key').disabled = false
  $('admin-key').placeholder = '输入 Sub2 管理员 API Key'
  $('login-button').disabled = false
  $('login-button').textContent = '获取账号'
  $('connection-status').textContent = '尚未连接'
  $('connected-origin').textContent = '填写连接信息，获取账号后保存并开始检测。'
  $('upstream-client').textContent = ''
  $('admin-key').value = ''
  $('account-rows').replaceChildren()
  $('queue-rows').replaceChildren()
  $('result-dialog').close()
  $('result-content').textContent = ''
  form.elements.namedItem('enabled').checked = false
  connectionSettingsEdited = false
  renderSummary()
}

function applyState(value, reset = false) {
  const keepSelection = !reset && selectionChanged()
  const keepSettings = !reset && settingsChanged()
  state = value
  const eligible = new Set(value.accounts.filter(account => account.eligible).map(account => account.id))
  selected = new Set((keepSelection ? [...selected] : value.selectedAccountIds).filter(id => eligible.has(id)))
  if (!keepSettings) {
    for (const name of names) {
      const input = form.elements.namedItem(name)
      if (name === 'enabled') input.checked = value.settings[name]
      else input.value = String(value.settings[name])
    }
  }
  $('workspace').hidden = false
  $('logout').hidden = false
  $('origin').value = value.origin
  $('origin').disabled = true
  $('admin-key').disabled = true
  $('admin-key').placeholder = 'Key 已保存在后端内存中'
  $('login-button').disabled = true
  $('login-button').textContent = '已连接'
  $('connection-status').textContent = value.settings.enabled ? '已连接 · 后台定时检测已开启' : '已连接 · 等待开始检测'
  render()
}

function readSettings() {
  return Object.fromEntries(names.map(name => {
    const input = form.elements.namedItem(name)
    return [name, name === 'enabled' ? input.checked : ['model', 'reasoningEffort'].includes(name) ? input.value : Number(input.value)]
  }))
}
function settingsChanged() {
  if (!state) return false
  const current = readSettings()
  return names.some(name => current[name] !== state.settings[name])
}
function selectionChanged() {
  return Boolean(state && (selected.size !== state.selectedAccountIds.length || state.selectedAccountIds.some(id => !selected.has(id))))
}
function markDirty() { if (!state) connectionSettingsEdited = true; renderSummary() }

async function updateState(path, method, body) {
  const version = authVersion
  pendingUpdates += 1
  stateEpoch += 1
  renderSummary()
  try {
    const value = await api(path, method, body)
    if (version !== authVersion || !state) return null
    applyState(value)
    return value
  } finally {
    pendingUpdates -= 1
    stateEpoch += 1
    renderSummary()
  }
}
function time(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—' }
function badge(status, label) { const el = document.createElement('span'); el.className = `badge ${status}`; el.textContent = label || labels[status] || status; return el }
function cell(row, text) { const el = document.createElement('td'); if (text instanceof Node) el.append(text); else el.textContent = text; row.append(el); return el }
function empty(body, columns, label) { const row = document.createElement('tr'); const td = cell(row, label); td.colSpan = columns; td.className = 'empty'; body.append(row) }
function button(label, handler, disabled = false) { const el = document.createElement('button'); el.className = 'secondary'; el.textContent = label; el.disabled = disabled; el.addEventListener('click', handler); return el }

function renderSummary() {
  if (!state) {
    for (const id of ['start-monitor', 'save-selection', 'save-settings', 'refresh-accounts', 'run-selected', 'select-all']) $(id).disabled = true
    $('selected-count').textContent = '已选 0 个 / 已保存 0 个'
    $('selection-status').textContent = '请先填写地址和 Key 获取账号'
    $('account-count').textContent = '尚未获取账号'
    $('unsaved').hidden = true
    $('running-count').textContent = '0 / 0'
    $('queued-count').textContent = '0 / 0'
    $('dropped-count').textContent = '0'
    $('next-run').textContent = '未开始'
    $('scheduler-error').hidden = true
    return
  }
  const selectionDirty = selectionChanged(), settingsDirty = settingsChanged()
  $('unsaved').hidden = !settingsDirty
  $('selected-count').textContent = `已选 ${selected.size} 个 / 已保存 ${state.selectedAccountIds.length} 个`
  $('selection-status').textContent = selectionDirty ? '账号选择未保存' : '账号选择已保存'
  $('selection-status').className = selectionDirty ? 'badge warn' : 'muted'
  $('save-selection').disabled = pendingUpdates > 0 || !selectionDirty
  $('save-settings').disabled = pendingUpdates > 0 || !settingsDirty
  $('refresh-accounts').disabled = pendingUpdates > 0
  $('start-monitor').disabled = pendingUpdates > 0 || !selected.size
  $('start-monitor').textContent = pendingUpdates ? '正在保存…' : '保存并开始检测'
  $('logout').disabled = pendingUpdates > 0
  $('run-selected').disabled = pendingUpdates > 0 || selectionDirty || settingsDirty || !state.selectedAccountIds.length
  $('run-selected').textContent = `立即检测已保存的 ${state.selectedAccountIds.length} 个账号`
}

function render() {
  if (!state) return
  $('connected-origin').textContent = state.origin
  const identity = state.upstreamIdentity
  const source = { 'sub2-setting': 'Sub2 面板设置', 'sub2-synced': 'Sub2 自动同步', 'sub2-default': '官方内置默认值' }
  $('upstream-client').textContent = identity
    ? `默认请求客户端：${identity.originator} / ${identity.version}（${source[identity.source]}）${identity.warning ? ` · ${identity.warning}` : ''}`
    : '请求客户端版本将在检测时从 Sub2 读取'
  const executor = state.executor
  $('running-count').textContent = `${executor.active} / ${executor.concurrency}`
  $('queued-count').textContent = `${executor.queued} / ${executor.queueLimit}`
  $('dropped-count').textContent = executor.dropped
  $('next-run').textContent = state.settings.enabled ? state.scheduler.running ? '正在调度' : time(state.scheduler.nextRunAt) : '已暂停'
  $('scheduler-error').hidden = !state.scheduler.lastError
  $('scheduler-error').textContent = state.scheduler.lastError || ''
  renderSummary()
  renderAccounts()
  renderQueue()
}

function filteredAccounts() {
  const search = $('search').value.trim().toLowerCase()
  return state.accounts.filter(account => (!search || `${account.name} ${account.id}`.toLowerCase().includes(search))
    && (!$('eligible-only').checked || account.eligible))
}

function renderAccounts() {
  if (!state) return
  const rows = $('account-rows')
  rows.replaceChildren()
  const accounts = filteredAccounts()
  $('account-count').textContent = `共 ${state.accounts.length} 个账号 · 当前显示 ${accounts.length} 个 · 列表中已选 ${accounts.filter(account => selected.has(account.id)).length} 个`
  const eligible = accounts.filter(account => account.eligible)
  const checked = eligible.filter(account => selected.has(account.id)).length
  $('select-all').checked = eligible.length > 0 && checked === eligible.length
  $('select-all').indeterminate = checked > 0 && checked < eligible.length
  $('select-all').disabled = !eligible.length
  for (const account of accounts) {
    const row = document.createElement('tr')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'; checkbox.checked = selected.has(account.id); checkbox.disabled = !account.eligible
    checkbox.setAttribute('aria-label', `选择账号 ${account.name}`)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(account.id); else selected.delete(account.id)
      markDirty(); renderAccounts()
    })
    cell(row, checkbox)
    const name = cell(row, account.name)
    const id = document.createElement('small'); id.textContent = `#${account.id}`; name.append(id)
    cell(row, `${account.platform} / ${account.type}`)
    cell(row, `${account.status} · ${account.schedulable ? '可调度' : '未调度'}`)
    const task = state.executor.tasks.find(task => task.accountId === account.id && ['queued', 'running'].includes(task.status))
    const result = state.results[String(account.id)]
    const status = task?.status || result?.status || ''
    const resultCell = cell(row, status ? badge(status) : account.eligible ? '尚未检测' : '不支持')
    if (account.unsupportedReason) resultCell.title = account.unsupportedReason
    if (result && !task) { const count = document.createElement('small'); count.textContent = `${result.answeredCount} / 15`; resultCell.append(count) }
    cell(row, time(result?.checkedAt))
    const actions = cell(row, '')
    actions.append(button('检测', event => doCheck(account.id, event.currentTarget), !account.eligible || Boolean(task)))
    actions.append(button('详情', () => showResult(account, result), !result))
    rows.append(row)
  }
  if (!accounts.length) empty(rows, 7, '暂无符合条件的账号')
}

function renderQueue() {
  const rows = $('queue-rows'); rows.replaceChildren()
  const names = new Map(state.accounts.map(account => [account.id, account.name]))
  for (const task of state.executor.tasks) {
    const row = document.createElement('tr')
    cell(row, names.get(task.accountId) || `#${task.accountId}`)
    cell(row, badge(task.status))
    cell(row, time(task.queuedAt)); cell(row, time(task.startedAt)); cell(row, time(task.finishedAt))
    const detail = task.error || task.result?.message || '—'
    const td = cell(row, detail.length > 80 ? `${detail.slice(0, 80)}…` : detail); td.title = detail
    rows.append(row)
  }
  if (!state.executor.tasks.length) empty(rows, 6, '暂无检测任务，在账号区保存选择后点击立即检测，或开启定时检测')
}

function showResult(account, result) {
  $('result-title').textContent = `${account.name} · ${labels[result.status]}`
  $('result-content').textContent = [
    `检测时间：${time(result.checkedAt)}`, `模型：${result.model || '—'} / ${result.reasoningEffort || '—'}`,
    `已回答：${result.answeredCount} / 15`, `HTTP：${result.httpStatus || '—'}`,
    `说明：${result.message}`, '', '完整回复：', result.responseText || '（无回复）',
  ].join('\n')
  $('result-dialog').showModal()
}

async function poll() {
  if (polling || pendingUpdates || !state) return
  const version = authVersion
  const epoch = stateEpoch
  polling = true
  try { const value = await api('/state'); if (version === authVersion && epoch === stateEpoch && state) applyState(value) }
  catch (error) { notify(error.message, true) }
  finally { polling = false }
}

function startPolling() { clearInterval(interval); interval = setInterval(poll, 2000) }
async function doCheck(accountId, trigger) {
  if (trigger) trigger.disabled = true
  try {
    const result = await api('/checks', 'POST', accountId ? { accountId } : {})
    notify(result.rejected.length ? `已入队 ${result.tasks.length} 个，${result.rejected.length} 个未入队：${result.rejected[0].message}` : `已提交 ${result.tasks.length} 个检测任务`, result.rejected.length > 0)
    await poll()
  } catch (error) { notify(error.message, true) }
  finally { if (trigger) trigger.disabled = false; renderSummary() }
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (pendingUpdates || state) return
  pendingUpdates += 1
  stateEpoch += 1
  const button = $('login-button'); button.disabled = true; button.textContent = '正在连接…'
  try {
    const value = await api('/login', 'POST', { origin: $('origin').value.trim(), adminKey: $('admin-key').value.trim() })
    const draft = connectionSettingsEdited ? readSettings() : null
    $('admin-key').value = ''; authVersion += 1; applyState(value, true); startPolling(); notify('连接成功，已获取账号列表')
    if (draft) {
      for (const name of names) {
        const input = form.elements.namedItem(name)
        if (name === 'enabled') input.checked = draft[name]
        else input.value = String(draft[name])
      }
    }
  } catch (error) { $('admin-key').value = ''; notify(error.message, true) }
  finally { pendingUpdates -= 1; stateEpoch += 1; button.disabled = Boolean(state); button.textContent = state ? '已连接' : '获取账号'; renderSummary() }
})

$('logout').addEventListener('click', async () => {
  const button = $('logout'); button.disabled = true
  try { await api('/logout', 'POST', {}); showLogin(); notify('检测已停止，后端 Key 已清除') }
  catch (error) { notify(error.message, true) }
  finally { button.disabled = false }
})

form.addEventListener('input', markDirty)
form.addEventListener('change', markDirty)
form.addEventListener('submit', async event => {
  event.preventDefault()
  if (pendingUpdates || !state) return
  const settings = readSettings()
  try {
    const value = await updateState('/settings', 'PUT', { settings })
    if (value) notify(`检测设置已保存${settingsChanged() ? '，仍有未保存的设置修改' : value.settings.enabled ? '，后台将按已保存账号周期检测' : '，定时检测已暂停'}`)
  } catch (error) { notify(error.message, true) }
})

$('start-monitor').addEventListener('click', async () => {
  if (pendingUpdates || !state || !selected.size || !form.reportValidity()) return
  form.elements.namedItem('enabled').checked = true
  try {
    const value = await updateState('/monitor/start', 'POST', { settings: readSettings(), selectedAccountIds: [...selected] })
    if (value) notify(value.scheduler.lastError ? `设置已保存，首轮启动异常：${value.scheduler.lastError}`
      : `已保存并开始检测 ${value.selectedAccountIds.length} 个账号，关闭网页后后台继续运行`, Boolean(value.scheduler.lastError))
  } catch (error) { notify(error.message, true) }
})

$('save-selection').addEventListener('click', async () => {
  if (pendingUpdates) return
  try {
    const value = await updateState('/accounts/selection', 'PUT', { selectedAccountIds: [...selected] })
    if (value) notify(`已保存 ${value.selectedAccountIds.length} 个账号${selectionChanged() ? '，仍有未保存的选择修改' : ''}`)
  } catch (error) { notify(error.message, true) }
})

$('refresh-accounts').addEventListener('click', async () => {
  if (pendingUpdates) return
  try {
    const value = await updateState('/accounts/refresh', 'POST', {})
    if (value) notify('账号列表已更新，已保留可检测账号的勾选')
  } catch (error) { notify(error.message, true) }
})
$('run-selected').addEventListener('click', event => doCheck(undefined, event.currentTarget))
$('search').addEventListener('input', renderAccounts)
$('eligible-only').addEventListener('change', renderAccounts)
$('select-all').addEventListener('change', event => {
  if (!state) return
  for (const account of filteredAccounts()) if (account.eligible) {
    if (event.target.checked) selected.add(account.id); else selected.delete(account.id)
  }
  markDirty(); renderAccounts()
})
$('close-result').addEventListener('click', () => $('result-dialog').close())

renderSummary()
try {
  const session = await api('/session')
  if (session.authenticated) { applyState(await api('/state'), true); startPolling() }
} catch (error) { notify(error.message, true) }
