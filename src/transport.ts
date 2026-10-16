import { Agent, ProxyAgent, buildConnector, type Dispatcher } from 'undici'
import { SocksClient } from 'socks'

export interface ExportedProxy {
  proxy_key: string
  protocol: string
  host: string
  port: number
  username?: string
  password?: string
}

export class AccountTransports {
  private agents = new Map<string, Dispatcher>()

  forProxy(proxy?: ExportedProxy): Dispatcher | undefined {
    if (!proxy) return undefined
    const key = JSON.stringify(proxy)
    const existing = this.agents.get(key)
    if (existing) return existing
    const protocol = String(proxy.protocol).toLowerCase().replace(/:$/, '')
    const port = Number(proxy.port)
    if (!proxy.host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('账号代理的地址或端口无效')
    let agent: Dispatcher
    if (['http', 'https'].includes(protocol)) {
      const host = proxy.host.includes(':') ? `[${proxy.host.replace(/^\[|\]$/g, '')}]` : proxy.host
      agent = new ProxyAgent({ uri: `${protocol}://${host}:${port}`,
        ...(proxy.username || proxy.password ? { token: `Basic ${Buffer.from(`${proxy.username || ''}:${proxy.password || ''}`).toString('base64')}` } : {}) })
    } else if (['socks5', 'socks5h', 'socks4', 'socks4a'].includes(protocol)) {
      const connector = buildConnector({ timeout: 10_000 })
      agent = new Agent({ connect(options, callback) {
        void SocksClient.createConnection({
          command: 'connect', timeout: 10_000,
          proxy: { host: proxy.host, port, type: protocol.startsWith('socks4') ? 4 : 5,
            userId: proxy.username, password: proxy.password },
          destination: { host: options.hostname.replace(/^\[|\]$/g, ''), port: Number(options.port) || (options.protocol === 'https:' ? 443 : 80) },
        }).then(({ socket }) => {
          if (options.protocol === 'https:') connector({ ...options, httpSocket: socket }, callback)
          else callback(null, socket)
        }).catch(() => callback(new Error('无法连接账号的 SOCKS 代理'), null))
      } })
    } else throw new Error(`暂不支持账号代理协议 ${protocol}`)
    this.agents.set(key, agent)
    return agent
  }

  clear() {
    for (const agent of this.agents.values()) void agent.destroy().catch(() => undefined)
    this.agents.clear()
  }
}
