import { z } from 'zod'

// Defaults and limits extracted from the existing degradation settings and routes.
export const settingsSchema = z.object({
  enabled: z.boolean(),
  model: z.enum(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']),
  reasoningEffort: z.enum(['low', 'medium', 'high']),
  intervalSeconds: z.number().int().min(30).max(86400),
  concurrency: z.number().int().min(1).max(50),
  queueLimit: z.number().int().min(0).max(500),
  firstTextTimeoutMs: z.number().int().min(1000).max(120000),
  totalTimeoutMs: z.number().int().min(1000).max(300000),
}).strict().refine(value => value.totalTimeoutMs >= value.firstTextTimeoutMs, {
  message: '完整响应超时不能小于首字超时', path: ['totalTimeoutMs'],
})

export type Settings = z.infer<typeof settingsSchema>
export const DEFAULT_SETTINGS: Settings = {
  enabled: false, model: 'gpt-6.1-sol', reasoningEffort: 'high',
  intervalSeconds: 300, concurrency: 2, queueLimit: 32,
  firstTextTimeoutMs: 60_000, totalTimeoutMs: 120_000,
}

export function assertCapacity(settings: Pick<Settings, 'concurrency' | 'queueLimit'>, count: number) {
  if (count > settings.concurrency + settings.queueLimit) {
    throw Object.assign(new Error(`已选择 ${count} 个账号；并发 ${settings.concurrency} + 等待 ${settings.queueLimit} 容量不足。等待上限至少需要 ${Math.max(0, count - settings.concurrency)}。`), { statusCode: 409 })
  }
}
