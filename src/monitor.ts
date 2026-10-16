import { CheckQueue } from './queue.js'
import { assertCapacity, type Settings } from './settings.js'
import { Store, type StoredState } from './store.js'
import { probeDegradation } from './probe.js'
import { Sub2Client, type Account } from './upstream.js'

export class Monitor {
  private state: StoredState
  private queue: CheckQueue
  private timer?: ReturnType<typeof setInterval>
  private nextRunAt = 0
  private lastError: string | null = null
  private busy = false
  private closed = false
  private readonly controller = new AbortController()
  private tail: Promise<unknown> = Promise.resolve()

  private constructor(readonly client: Sub2Client, private accounts: Account[], private store: Store, state: StoredState) {
    this.state = state
    this.queue = new CheckQueue(state.settings.concurrency, state.settings.queueLimit, async (accountId, signal) => {
      const result = await probeDegradation(client, accountId, { ...this.state.settings }, signal)
      if (result.status === 'degraded') {
        try {
          await client.disableScheduling(accountId, signal)
          result.scheduling = { status: 'disabled', message: '已调用 Sub2 关闭账号调度' }
          const account = this.accounts.find(item => item.id === accountId)
          if (account) account.schedulable = false
        } catch (error) {
          result.scheduling = { status: 'error', message: `关闭调度失败：${client.redact(error)}` }
        }
        result.message += `；${result.scheduling.message}`
      }
      await this.exclusive(async () => {
        const next = { ...this.state, results: { ...this.state.results, [accountId]: result } }
        await this.store.save(next)
        this.state = next
      })
      return result
    })
  }

  static async create(client: Sub2Client, accounts: Account[], dataDirectory: string) {
    const store = new Store(dataDirectory, client.origin)
    const state = await store.read()
    state.selectedAccountIds = [...new Set(state.selectedAccountIds)].filter(id => accounts.some(item => item.id === id && item.eligible))
    assertCapacity(state.settings, state.selectedAccountIds.length)
    return new Monitor(client, accounts, store, state)
  }

  start() {
    this.timer = setInterval(() => void this.tick(), 1000)
    this.timer.unref()
    void this.tick()
  }

  private exclusive<T>(operation: () => Promise<T>) {
    const next = this.tail.catch(() => undefined).then(operation)
    this.tail = next
    return next
  }

  snapshot() {
    return { origin: this.client.origin, accounts: this.accounts, settings: this.state.settings, upstreamIdentity: this.client.identityState(),
      selectedAccountIds: this.state.selectedAccountIds, results: this.state.results,
      executor: this.queue.state(), scheduler: { running: this.busy,
        nextRunAt: this.state.settings.enabled && this.nextRunAt ? new Date(this.nextRunAt).toISOString() : null, lastError: this.lastError } }
  }

  async refreshAccounts() {
    const accounts = await this.client.listAccounts(this.controller.signal)
    await this.exclusive(async () => {
      if (this.closed) throw new Error('会话已结束')
      const selected = this.state.selectedAccountIds.filter(id => accounts.some(item => item.id === id && item.eligible))
      const validIds = new Set(accounts.map(account => String(account.id)))
      const results = Object.fromEntries(Object.entries(this.state.results).filter(([id]) => validIds.has(id)))
      const next = { ...this.state, selectedAccountIds: selected, results }
      await this.store.save(next)
      for (const id of this.state.selectedAccountIds) if (!selected.includes(id)) this.queue.cancel(id)
      this.state = next
      this.accounts = accounts
    })
    return this.snapshot()
  }

  saveSettings(settings: Settings) {
    return this.exclusive(() => this.persistConfiguration(settings, this.state.selectedAccountIds))
  }

  saveSelection(selectedAccountIds: number[]) {
    return this.exclusive(() => this.persistConfiguration(this.state.settings, selectedAccountIds))
  }

  async begin(settings: Settings, selectedAccountIds: number[]) {
    if (!selectedAccountIds.length) throw Object.assign(new Error('请至少选择一个检测账号'), { statusCode: 400 })
    await this.exclusive(() => this.persistConfiguration({ ...settings, enabled: true }, selectedAccountIds))
    await this.tick()
    return this.snapshot()
  }

  private async persistConfiguration(settings: Settings, selectedAccountIds: number[]) {
    if (this.closed) throw new Error('会话已结束')
    const selected = [...new Set(selectedAccountIds)]
    for (const id of selected) {
      if (!this.accounts.some(account => account.id === id && account.eligible)) {
        throw Object.assign(new Error(`账号 #${id} 不存在或不支持降智检测`), { statusCode: 400 })
      }
    }
    assertCapacity(settings, selected.length)
    const pending = this.queue.state()
    if (pending.active + pending.queued > Math.max(pending.active, settings.concurrency) + settings.queueLimit) {
      throw Object.assign(new Error('当前任务超过新队列容量，请等待任务完成后再缩小容量'), { statusCode: 409 })
    }
    const next = { ...this.state, settings, selectedAccountIds: selected }
    await this.store.save(next)
    for (const id of this.state.selectedAccountIds) {
      if (!selected.includes(id) || (this.state.settings.enabled && !settings.enabled)) this.queue.cancel(id)
    }
    this.state = next
    this.queue.configure(settings.concurrency, settings.queueLimit)
    this.nextRunAt = 0
    return this.snapshot()
  }

  enqueue(ids?: number[]) {
    return this.exclusive(async () => {
      if (this.closed) throw Object.assign(new Error('会话已结束'), { statusCode: 401 })
      const selected = ids ?? this.state.selectedAccountIds
      if (!selected.length) throw Object.assign(new Error('请先勾选账号并点击“保存账号选择”'), { statusCode: 400 })
      for (const id of selected) {
        if (!this.accounts.some(account => account.id === id && account.eligible)) {
          throw Object.assign(new Error(`账号 #${id} 不存在或不支持降智检测`), { statusCode: 400 })
        }
      }
      const tasks = [], rejected: { accountId: number; message: string }[] = []
      for (const id of selected) {
        try { tasks.push(this.queue.enqueue(id)) }
        catch (error) { rejected.push({ accountId: id, message: this.client.redact(error) }) }
      }
      return { tasks, rejected }
    })
  }

  private async tick() {
    if (this.closed || this.busy || !this.state.settings.enabled || Date.now() < this.nextRunAt) return
    this.busy = true
    this.nextRunAt = Date.now() + this.state.settings.intervalSeconds * 1000
    try {
      await this.refreshAccounts()
      if (this.closed || !this.state.settings.enabled) return
      const selected = this.state.selectedAccountIds
      const result = selected.length ? await this.enqueue(selected) : null
      this.lastError = result?.rejected.length ? `${result.rejected.length} 个任务因队列容量不足未入队` : null
    } catch (error) { this.lastError = this.client.redact(error) }
    finally { this.busy = false }
  }

  async close() {
    this.closed = true
    clearInterval(this.timer)
    this.controller.abort()
    await this.queue.close()
    await this.tail.catch(() => undefined)
    await this.store.flush()
    this.client.clear()
  }
}
