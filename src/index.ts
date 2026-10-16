import 'dotenv/config'
import { resolve } from 'node:path'
import { buildApp } from './app.js'

const app = await buildApp({
  dataDirectory: resolve(process.env.DATA_DIR || 'data'),
  secureCookie: process.env.COOKIE_SECURE === 'true',
  proxyUrl: process.env.UPSTREAM_PROXY_URL || undefined,
  logger: true,
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().catch(() => { process.exitCode = 1 }) })
}
try {
  await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3100) })
} catch (error) {
  app.log.error(error)
  await app.close()
  process.exitCode = 1
}
