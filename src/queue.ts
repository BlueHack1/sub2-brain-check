import { randomUUID } from 'node:crypto'
import type { CheckResult } from './store.js'

export interface Task {
  taskId: string
  accountId: number
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
  result?: CheckResult
  error?: string
}

// Extracted from degradation-check-service: bounded FIFO, per-account deduplication.
export class CheckQueue {
  private waiting: Task[] = []
  private readonly pending = new Map<number, Task>()
  private readonly history = new Map<string, Task>()
  private readonly controllers = new Map<string, AbortController>()
  private active = 0
  private dropped = 0
  private stopped = false
  constructor(
    private concurrency: number,
    private queueLimit: number,
    private readonly run: (accountId: number, signal: AbortSignal) => Promise<CheckResult>,
  ) {}

  enqueue(accountId: number): Task {
    if (this.stopped) throw Object.assign(new Error('检测队列已停止'), { statusCode: 409 })
    const existing = this.pending.get(accountId)
    if (existing) return existing
    if (this.active >= this.concurrency && this.waiting.length >= this.queueLimit) {
      this.dropped += 1
      throw Object.assign(new Error(`降智检测等待队列已满（最多 ${this.queueLimit} 个）`), { statusCode: 429 })
    }
    const task: Task = {
      taskId: randomUUID(), accountId, status: 'queued', queuedAt: new Date().toISOString(),
      startedAt: null, finishedAt: null,
    }
    this.pending.set(accountId, task)
    this.history.set(task.taskId, task)
    this.waiting.push(task)
    this.trim()
    this.pump()
    return task
  }

  private pump() {
    while (!this.stopped && this.active < this.concurrency && this.waiting.length) {
      const task = this.waiting.shift()!
      const controller = new AbortController()
      task.status = 'running'
      task.startedAt = new Date().toISOString()
      this.active += 1
      this.controllers.set(task.taskId, controller)
      void Promise.resolve().then(() => this.run(task.accountId, controller.signal)).then(result => {
        task.status = 'completed'
        task.result = result
      }).catch((error: unknown) => {
        task.status = controller.signal.aborted ? 'cancelled' : 'failed'
        task.error = error instanceof Error ? error.message : String(error)
      }).finally(() => {
        task.finishedAt = new Date().toISOString()
        this.active -= 1
        this.controllers.delete(task.taskId)
        this.pending.delete(task.accountId)
        this.pump()
      })
    }
  }

  cancel(accountId: number) {
    const task = this.pending.get(accountId)
    if (!task || task.status !== 'queued') return false
    this.waiting = this.waiting.filter(item => item !== task)
    task.status = 'cancelled'
    task.error = '账号降智检测已关闭，等待任务已取消'
    task.finishedAt = new Date().toISOString()
    this.pending.delete(accountId)
    return true
  }

  configure(concurrency: number, queueLimit: number) {
    if (this.pending.size > Math.max(this.active, concurrency) + queueLimit) {
      throw Object.assign(new Error('当前队列中的任务超出新容量，请等待任务完成后重试'), { statusCode: 409 })
    }
    this.concurrency = concurrency
    this.queueLimit = queueLimit
    this.pump()
  }

  private trim() {
    const finished = [...this.history.values()].filter(task => task.finishedAt)
    for (let i = 0; i < finished.length; i += 1) {
      const task = finished[i]!
      if (i < finished.length - 200 || Date.parse(task.finishedAt!) < Date.now() - 600_000) this.history.delete(task.taskId)
    }
  }

  state() {
    this.trim()
    return { active: this.active, queued: this.waiting.length, concurrency: this.concurrency,
      queueLimit: this.queueLimit, dropped: this.dropped, tasks: [...this.history.values()].reverse() }
  }

  async close() {
    this.stopped = true
    for (const task of [...this.waiting]) this.cancel(task.accountId)
    for (const controller of this.controllers.values()) controller.abort()
    while (this.active) await new Promise(resolve => setTimeout(resolve, 10))
  }
}
