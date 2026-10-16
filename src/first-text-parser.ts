export type FirstTextProtocol = 'responses' | 'chat_completions'

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function firstChoice(payload: Record<string, unknown>) {
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  return record(choices[0])
}

function responseOutputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === 'string') return payload.output_text
  const output = Array.isArray(payload.output) ? payload.output : []
  const texts: string[] = []
  for (const rawItem of output) {
    const item = record(rawItem)
    const content = item && Array.isArray(item.content) ? item.content : []
    for (const rawPart of content) {
      const part = record(rawPart)
      if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
    }
  }
  return texts.join('')
}

export function extractStreamingFirstText(
  payload: unknown,
  protocol: FirstTextProtocol,
) {
  const value = record(payload)
  if (!value) return ''
  if (protocol === 'responses') {
    return value.type === 'response.output_text.delta' && typeof value.delta === 'string'
      ? value.delta
      : ''
  }
  const choice = firstChoice(value)
  const delta = record(choice?.delta)
  return typeof delta?.content === 'string' ? delta.content : ''
}

export function extractCompletedFirstText(
  payload: unknown,
  protocol: FirstTextProtocol,
) {
  const value = record(payload)
  if (!value) return ''
  if (protocol === 'responses') {
    const nestedResponse = record(value.response)
    return responseOutputText(nestedResponse ?? value)
  }
  const choice = firstChoice(value)
  const message = record(choice?.message)
  return typeof message?.content === 'string' ? message.content : ''
}
