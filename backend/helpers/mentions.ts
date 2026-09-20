const MENTION_CHAR = /[A-Za-z0-9._-]/

const MENTION_TOKEN = /(?<![A-Za-z0-9._-])@([A-Za-z0-9._-]+)/g

const MAX_TOKEN_LENGTH = 64

export const MAX_MENTION_CANDIDATES = 100

function trailingVariants(token: string): string[] {
  const variants: string[] = []
  let current = token.toLowerCase()
  while (current !== '') {
    variants.push(current)
    const last = current[current.length - 1]
    if (last === '.' || last === '_' || last === '-') {
      current = current.slice(0, -1)
    } else {
      break
    }
  }
  return variants
}

export function isMentionChar(char: string | undefined): boolean {
  return char !== undefined && MENTION_CHAR.test(char)
}

export function extractMentionCandidates(content: string): string[] {
  const seen = new Set<string>()
  for (const match of content.matchAll(MENTION_TOKEN)) {
    if (match[1].length > MAX_TOKEN_LENGTH) {
      continue
    }
    for (const variant of trailingVariants(match[1])) {
      seen.add(variant)
      if (seen.size >= MAX_MENTION_CANDIDATES) {
        return [...seen]
      }
    }
  }
  return [...seen]
}

export function matchMention(
  token: string,
  resolved: ReadonlyMap<string, string>
): { length: number; handle: string } | null {
  if (token.length > MAX_TOKEN_LENGTH) {
    return null
  }
  for (const variant of trailingVariants(token)) {
    const handle = resolved.get(variant)
    if (handle !== undefined) {
      return { length: variant.length, handle }
    }
  }
  return null
}
