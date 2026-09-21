export const RESERVED_TWO_SEGMENT_PREFIXES = ['a', 'i'] as const

export const RESERVED_TWO_SEGMENT_URL_ROUTES: readonly RegExp[] = RESERVED_TWO_SEGMENT_PREFIXES.map(
  (prefix) => new RegExp(`^/${prefix}/[^/]+$`)
)

export function reservedTwoSegmentPrefix(pagePath: string): string | null {
  const [first, second, ...rest] = pagePath.split('/')
  if (!second || rest.length > 0) {
    return null
  }
  return RESERVED_TWO_SEGMENT_PREFIXES.find((prefix) => prefix === first) ?? null
}
