export const WHITEBOARD_MAX_BLOCK_BYTES = 262_144
export const WHITEBOARD_MAX_STROKES = 2_000
export const WHITEBOARD_MAX_POINTS = 50_000
export const WHITEBOARD_MAX_PAGE_BYTES = 1_048_576

export type WhiteboardCapKind = 'blockBytes' | 'strokes' | 'points' | 'pageBytes'

export interface WhiteboardCapViolation {
  kind: WhiteboardCapKind
  actual: number
  limit: number
}

export function whiteboardBodyBytes(body: string): number {
  return Buffer.byteLength(body.trim(), 'utf8')
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

export function countWhiteboardStrokes(body: string): { strokes: number; points: number } {
  const text = body.trim()
  if (!text) {
    return { strokes: 0, points: 0 }
  }
  let strokes = 0
  let points = 0
  for (const line of text.split('\n').slice(1)) {
    if (line.trim() === '') {
      continue
    }
    strokes++
    const stroke = parseLine(line)
    const p =
      typeof stroke === 'object' && stroke !== null && !Array.isArray(stroke)
        ? (stroke as { p?: unknown }).p
        : undefined
    if (Array.isArray(p)) {
      points += Math.floor(p.length / 3)
    }
  }
  return { strokes, points }
}

export function findWhiteboardCapViolation(bodies: string[]): WhiteboardCapViolation | null {
  let total = 0

  for (const body of bodies) {
    const { strokes, points } = countWhiteboardStrokes(body)
    if (strokes > WHITEBOARD_MAX_STROKES) {
      return { kind: 'strokes', actual: strokes, limit: WHITEBOARD_MAX_STROKES }
    }
    if (points > WHITEBOARD_MAX_POINTS) {
      return { kind: 'points', actual: points, limit: WHITEBOARD_MAX_POINTS }
    }
    const bytes = whiteboardBodyBytes(body)
    if (bytes > WHITEBOARD_MAX_BLOCK_BYTES) {
      return { kind: 'blockBytes', actual: bytes, limit: WHITEBOARD_MAX_BLOCK_BYTES }
    }
    total += bytes
  }

  if (total > WHITEBOARD_MAX_PAGE_BYTES) {
    return { kind: 'pageBytes', actual: total, limit: WHITEBOARD_MAX_PAGE_BYTES }
  }

  return null
}

export function describeWhiteboardCapViolation(violation: WhiteboardCapViolation): string {
  switch (violation.kind) {
    case 'blockBytes':
      return `A whiteboard on this page is ${violation.actual} bytes, over the ${violation.limit}-byte limit for one whiteboard. The page was not saved.`
    case 'pageBytes':
      return `The whiteboards on this page total ${violation.actual} bytes, over the ${violation.limit}-byte limit for one page. The page was not saved.`
    case 'strokes':
      return `A whiteboard on this page has ${violation.actual} strokes, over the limit of ${violation.limit}. The page was not saved.`
    case 'points':
      return `A whiteboard on this page has ${violation.actual} points, over the limit of ${violation.limit}. The page was not saved.`
  }
}
