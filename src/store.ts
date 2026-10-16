import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from './settings.js'

export const resultSchema = z.object({
  status: z.enum(['success', 'degraded', 'error']), responseText: z.string(),
  answeredCount: z.number().int().min(0).max(15), missingQuestions: z.array(z.number().int().min(1).max(15)),
  model: z.string().nullable(), reasoningEffort: z.enum(['low', 'medium', 'high']).nullable(),
  httpStatus: z.number().nullable(), message: z.string(), checkedAt: z.string(),
  scheduling: z.object({ status: z.enum(['disabled', 'error']), message: z.string() }).optional(),
})
export type CheckResult = z.infer<typeof resultSchema>
const storedSchema = z.object({
  version: z.literal(1), settings: settingsSchema,
  selectedAccountIds: z.array(z.number().int().positive()).max(550),
  results: z.record(z.string(), resultSchema),
})
export interface StoredState {
  version: 1
  settings: Settings
  selectedAccountIds: number[]
  results: Record<string, CheckResult>
}

export class Store {
  private tail: Promise<void> = Promise.resolve()
  private readonly file: string
  constructor(private readonly directory: string, origin: string) {
    this.file = join(directory, `${createHash('sha256').update(origin).digest('hex')}.json`)
  }
  async read(): Promise<StoredState> {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8'))
      // Older extracted settings offered Grok. Preserve other settings when upgrading.
      if (state.settings?.model === 'grok-4.5') state.settings.model = DEFAULT_SETTINGS.model
      return storedSchema.parse(state)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('本地降智配置文件损坏或不可读，请检查 data 目录', { cause: error })
      return { version: 1, settings: { ...DEFAULT_SETTINGS }, selectedAccountIds: [], results: {} }
    }
  }
  save(state: StoredState) {
    const contents = JSON.stringify(state, null, 2)
    const operation = this.tail.catch(() => undefined).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, this.file)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
    })
    this.tail = operation
    return operation
  }
  async flush() { await this.tail }
}
