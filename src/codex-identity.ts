import { SUB2_DEFAULT_ORIGINATOR, SUB2_DEFAULT_VERSION, SUB2_UA_SUFFIX } from './sub2-defaults.js'

export interface CodexIdentity {
  userAgent: string
  originator: string
  version: string
}

const officialClients = new Set([
  'codex_cli_rs', 'codex-tui', 'codex_vscode', 'codex_vscode_copilot', 'codex_app',
  'codex_chatgpt_desktop', 'codex_atlas', 'codex_exec', 'codex_sdk_ts',
])

export function normalizeVersion(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length <= 64 && /^[0-9]+(?:\.[0-9]+){1,3}(?:-[0-9A-Za-z.]+)?$/.test(text) ? text : ''
}

function officialOriginator(value: string) {
  if (!value || value.length > 64 || /[^\x20-\x7e]/.test(value)) return ''
  const lower = value.toLowerCase()
  return officialClients.has(lower) ? lower : lower.startsWith('codex ') ? value : ''
}

function trailer(value: string) {
  const open = value.lastIndexOf('('), close = value.indexOf(')', open + 1)
  if (open < 0 || close < 0) return null
  const inner = value.slice(open + 1, close)
  const name = inner.split(';')[0]!.trim()
  return { open, close, inner, name }
}

function pair(userAgent: string) {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(userAgent)) return null
  const ua = userAgent.trim(), slash = ua.indexOf('/')
  if (slash <= 0) return null
  const leading = officialOriginator(ua.slice(0, slash).trim())
  const tail = trailer(ua)
  const originator = leading || (tail && !tail.name.includes('/') ? officialOriginator(tail.name) : '')
  return originator ? { originator, userAgent: originator + ua.slice(slash) } : null
}

function rebuildVersion(userAgent: string, version: string) {
  const slash = userAgent.indexOf('/'), rest = userAgent.slice(slash + 1)
  if (slash <= 0 || !rest.trim()) return ''
  const space = rest.indexOf(' ')
  let ua = userAgent.slice(0, slash) + '/' + version + (space >= 0 ? rest.slice(space) : '')
  const tail = trailer(ua)
  if (tail && tail.inner.includes(';') && officialOriginator(tail.name)) {
    ua = ua.slice(0, tail.open + 1) + `${tail.name}; ${version}` + ua.slice(tail.close)
  }
  return ua
}

function isBelowMinimum(version: string) {
  const parts = version.split('-')[0]!.split('.').map(Number)
  const minimum = [0, 144, 0]
  for (let i = 0; i < 3; i++) {
    if ((parts[i] || 0) !== minimum[i]) return (parts[i] || 0) < minimum[i]!
  }
  return version.includes('-')
}

// Mirrors Sub2's canonical UA -> paired account UA -> shared version resolution.
export function resolveCodexIdentity(settings: Record<string, unknown>, accountUA = ''): CodexIdentity {
  let version = normalizeVersion(settings.openai_codex_client_version)
    || normalizeVersion(settings.openai_codex_client_version_synced) || SUB2_DEFAULT_VERSION
  if (isBelowMinimum(version)) version = SUB2_DEFAULT_VERSION
  const defaultUA = `${SUB2_DEFAULT_ORIGINATOR}/${version}${SUB2_UA_SUFFIX}`
  const globalPair = pair(typeof settings.openai_codex_user_agent === 'string' ? settings.openai_codex_user_agent : '')
  const canonicalUA = globalPair ? rebuildVersion(globalPair.userAgent, version) || defaultUA : defaultUA
  const selected = pair(accountUA) || pair(canonicalUA)!
  const userAgent = rebuildVersion(selected.userAgent, version)
    || canonicalUA
  return { userAgent, originator: pair(userAgent)!.originator, version }
}
