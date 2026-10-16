import { SUB2_CODEX_MODEL_MAP, SUB2_CODEX_MODEL_PREFIXES } from './sub2-defaults.js'

// Port of Sub2's OpenAI account-test model mapping and Codex alias normalization.
export function mapAccountModel(mapping: Record<string, unknown>, model: string) {
  if (typeof mapping[model] === 'string') return mapping[model] as string
  const pattern = Object.keys(mapping).filter(key => key.endsWith('*')
    && model.startsWith(key.slice(0, -1)) && typeof mapping[key] === 'string')
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))[0]
  return pattern === undefined ? model : mapping[pattern] as string
}

function canonicalSpelling(model: string) {
  let value = model.trim().split('/').at(-1)!.trim().toLowerCase().replace(/_/g, '-')
    .replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^gpt5/, 'gpt-5')
  if (!value.startsWith('gpt-') && !value.includes('codex')) return ''
  for (const [from, to] of [
    ['gpt-5.4mini', 'gpt-5.4-mini'], ['gpt-5.4nano', 'gpt-5.4-nano'],
    ['gpt-5.3-codexspark', 'gpt-5.3-codex-spark'], ['gpt-5.3codexspark', 'gpt-5.3-codex-spark'],
    ['gpt-5.3codex', 'gpt-5.3-codex'],
  ]) value = value.replaceAll(from!, to!)
  return value
}

function knownSuffix(value: string) {
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value) || /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export function normalizeCodexModel(model: string) {
  const original = model.trim()
  if (!original) return 'gpt-5.4'
  if (original.toLowerCase().startsWith('gpt-image')) return original
  const segment = original.split('/').at(-1)!.trim()
  const normalized = canonicalSpelling(segment)
  if (normalized) {
    const direct = SUB2_CODEX_MODEL_MAP[normalized] || (normalized.endsWith('-openai-compact')
      ? SUB2_CODEX_MODEL_MAP[normalized.slice(0, -15)] : '')
    if (direct) return direct
    for (const base of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']) {
      const suffix = normalized.slice(base.length + 1)
      if (normalized.startsWith(base + '-') && ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'openai-compact',
        ...(base === 'gpt-6.1-sol' ? ['minimal'] : [])].includes(suffix)) return base
    }
    if (normalized === 'gpt-6' || normalized === 'gpt-6-astra') return 'gpt-6-astra'
    for (const base of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      if (normalized.includes(base)) return base
    }
    if (normalized === 'gpt-5.6') return 'gpt-5.6-sol'
    if (normalized.startsWith('gpt-5.6-')) {
      const suffix = normalized.slice('gpt-5.6-'.length)
      if (suffix === 'max' || knownSuffix(suffix)) return 'gpt-5.6-sol'
    } else {
      for (const base of ['gpt-5.5-pro', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4', 'gpt-5.2',
        'gpt-5.3-codex-spark', 'gpt-5.3-codex']) if (normalized.includes(base)) return base
      if (normalized.includes('gpt-5.3') || normalized.includes('codex')) return 'gpt-5.3-codex'
      if (normalized.includes('gpt-5')) return 'gpt-5.4'
    }
  }
  const key = normalized || segment.toLowerCase().split(/\s+/).join('-')
  if (SUB2_CODEX_MODEL_MAP[key]) return SUB2_CODEX_MODEL_MAP[key]!
  for (const [prefix, target] of SUB2_CODEX_MODEL_PREFIXES) {
    if (key === prefix || key.startsWith(prefix + '-') && knownSuffix(key.slice(prefix.length + 1))) return target
  }
  return original
}
