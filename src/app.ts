import { randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import { ProxyAgent, type Dispatcher } from 'undici'
import { z } from 'zod'
import { Monitor } from './monitor.js'
import { settingsSchema } from './settings.js'
import { normalizeOrigin, safeMessage, Sub2Client } from './upstream.js'

interface Options {
  dataDirectory?: string
  secureCookie?: boolean
  proxyUrl?: string
  dispatcher?: Dispatcher
  logger?: boolean
}

export async function buildApp(options: Options = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024, requestTimeout: 60_000 })
  const proxy = options.proxyUrl ? new ProxyAgent(options.proxyUrl) : undefined
  const dispatcher = options.dispatcher ?? proxy
  const secureCookie = options.secureCookie ?? false
  let session: { token: string; monitor: Monitor } | undefined
  let loginTail: Promise<unknown> = Promise.resolve()
  const attempts = new Map<string, { count: number; resetAt: number }>()
  const cookieName = 'sub2_monitor_session'
  const cookieLifetime = 30 * 24 * 60 * 60
  const cookie = (token: string, seconds: number) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secureCookie ? '; Secure' : ''}`

  await app.register(helmet, { contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], connectSrc: ["'self'"], imgSrc: ["'self'"],
    upgradeInsecureRequests: null,
  } } })

  app.setErrorHandler((error, _request, reply) => {
    const invalid = error instanceof z.ZodError
    const status = invalid ? 400 : Number((error as { statusCode?: number }).statusCode) || 500
    const message = invalid ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')
      : session?.monitor.client.redact(error) ?? safeMessage(error)
    return reply.code(status >= 400 && status <= 599 ? status : 500).send({ message })
  })

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return
    reply.header('Cache-Control', 'no-store')
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) {
      const origin = request.headers.origin
      let matches = true
      try { if (origin) matches = new URL(origin).host === request.headers.host } catch { matches = false }
      if (request.headers['x-sub2-monitor'] !== '1' || !matches) return reply.code(403).send({ message: '请求来源验证失败' })
    }
    if (['/api/login', '/api/session', '/api/health'].includes(request.url.split('?')[0]!)) return
    if (!authenticated(request.headers.cookie)) return reply.code(401).send({ message: '请先使用 Sub2 管理员 Key 登录' })
  })

  function authenticated(rawCookie?: string) {
    const token = rawCookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
    if (!session || !token) return false
    const actual = Buffer.from(token), expected = Buffer.from(session.token)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false
    return true
  }

  app.get('/api/health', async () => ({ status: 'ok' }))
  app.get('/api/session', async request => ({ authenticated: authenticated(request.headers.cookie), origin: authenticated(request.headers.cookie) ? session!.monitor.client.origin : null }))
  app.post('/api/login', async (request, reply) => {
    const input = z.object({ origin: z.string().trim().min(1).max(2048), adminKey: z.string().trim().min(1).max(8192) }).strict().parse(request.body)
    const now = Date.now()
    for (const [ip, attempt] of attempts) if (attempt.resetAt <= now) attempts.delete(ip)
    const attempt = attempts.get(request.ip) ?? { count: 0, resetAt: now + 60_000 }
    attempts.set(request.ip, attempt)
    attempt.count += 1
    if (attempt.count > 10) return reply.code(429).send({ message: '登录尝试过于频繁，请一分钟后重试' })
    const operation = loginTail.catch(() => undefined).then(async () => {
      const client = new Sub2Client(normalizeOrigin(input.origin), input.adminKey, dispatcher)
      let monitor: Monitor
      try {
        const accounts = await client.listAccounts()
        if (session) {
          const previous = session
          session = undefined
          await previous.monitor.close()
        }
        // Read after closing the previous monitor so its final results are preserved.
        // A saved enabled setting resumes automatically after the new Key is accepted.
        monitor = await Monitor.create(client, accounts, options.dataDirectory ?? resolve('data'))
      } catch (error) {
        const message = client.redact(error)
        client.clear()
        throw Object.assign(new Error(message), { statusCode: (error as { statusCode?: number }).statusCode ?? 502 })
      }
      const token = randomBytes(32).toString('hex')
      session = { token, monitor }
      monitor.start()
      reply.header('Set-Cookie', cookie(token, cookieLifetime))
      return monitor.snapshot()
    })
    loginTail = operation
    return operation
  })
  app.post('/api/logout', async (_request, reply) => {
    const current = session
    session = undefined
    await current?.monitor.close()
    reply.header('Set-Cookie', cookie('', 0))
    return { ok: true }
  })
  app.get('/api/state', async () => session!.monitor.snapshot())
  app.post('/api/accounts/refresh', async () => session!.monitor.refreshAccounts())
  app.put('/api/accounts/selection', async request => {
    const input = z.object({ selectedAccountIds: z.array(z.number().int().positive()).max(550) }).strict().parse(request.body)
    return session!.monitor.saveSelection(input.selectedAccountIds)
  })
  app.put('/api/settings', async request => {
    const input = z.object({ settings: settingsSchema }).strict().parse(request.body)
    return session!.monitor.saveSettings(input.settings)
  })
  app.post('/api/monitor/start', async request => {
    const input = z.object({ settings: settingsSchema, selectedAccountIds: z.array(z.number().int().positive()).min(1).max(550) }).strict().parse(request.body)
    return session!.monitor.begin(input.settings, input.selectedAccountIds)
  })
  app.post('/api/checks', async (request, reply) => {
    const input = z.object({ accountId: z.number().int().positive().optional() }).strict().parse(request.body ?? {})
    const result = await session!.monitor.enqueue(input.accountId ? [input.accountId] : undefined)
    return reply.code(result.tasks.length ? 202 : 429).send(result)
  })

  await app.register(fastifyStatic, { root: fileURLToPath(new URL('../public/', import.meta.url)), prefix: '/' })
  app.addHook('onClose', async () => {
    await loginTail.catch(() => undefined)
    await session?.monitor.close()
    await proxy?.close()
  })
  return app
}
