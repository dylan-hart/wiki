export const AUTO_TAG_THRESHOLD = 0.15
export const AUTO_TAG_MAX_TAGS = 3

export interface AutoTagInput {
  title: string
  text: string | string[]
  existingTags: string[]
}

export interface AutoTagOptions {
  threshold?: number
  maxTags?: number
}

const STOPWORDS = new Set(
  (
    'a about above after again all also an and any are as at be because been before being both but ' +
    'by can could did do does each every for from had has have how if in into is it its just may ' +
    'more most must no not of off on once only or other our out over own per same should so some ' +
    'such than that the their them then there these they this those through to too under until up ' +
    'us use used using was we were what when where which while who will with within without would ' +
    'you your'
  ).split(' ')
)

function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) {
    return `${token.slice(0, -3)}y`
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1)
  }
  return token
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
    .map(stem)
}

export function tagTokens(tag: string): string[] {
  return tokenize(tag.replace(/[-_]/g, ' '))
}

export function deriveAutoTags(input: AutoTagInput, options: AutoTagOptions = {}): string[] {
  const threshold = options.threshold ?? AUTO_TAG_THRESHOLD
  const maxTags = options.maxTags ?? AUTO_TAG_MAX_TAGS
  if (input.existingTags.length === 0 || !(maxTags >= 1)) {
    return []
  }

  const body = Array.isArray(input.text) ? input.text : [input.text]
  const counts = new Map<string, number>()
  let top = 0
  for (const token of tokenize([input.title, input.title, ...body].join(' '))) {
    const count = (counts.get(token) ?? 0) + 1
    counts.set(token, count)
    if (count > top) {
      top = count
    }
  }
  if (top === 0) {
    return []
  }

  const scored: [string, number][] = []
  for (const tag of new Set(input.existingTags)) {
    const parts = tagTokens(tag)
    if (parts.length === 0) {
      continue
    }
    const total = parts.reduce((sum, part) => sum + (counts.get(part) ?? 0) / top, 0)
    const score = total / parts.length
    if (score > 0 && score >= threshold) {
      scored.push([tag, score])
    }
  }

  return scored
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.floor(maxTags))
    .map(([tag]) => tag)
}
