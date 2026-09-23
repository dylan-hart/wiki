export const WHITEBOARD_MAX_BLOCK_BYTES = 262144
export const WHITEBOARD_MAX_STROKES = 2000
export const WHITEBOARD_MAX_POINTS = 50000
export const WHITEBOARD_MAX_PAGE_BYTES = 1048576

const encoder = new TextEncoder()

export function utf8ByteLength(text) {
  return encoder.encode(text).length
}

export function whiteboardBodyBytes(body) {
  return utf8ByteLength(String(body ?? '').trim())
}

export function measureWhiteboardBody(body) {
  const bytes = whiteboardBodyBytes(body)
  let parsed
  try {
    parsed = JSON.parse(String(body ?? '').trim())
  } catch {
    return { bytes, strokes: 0, points: 0, valid: false }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.s)) {
    return { bytes, strokes: 0, points: 0, valid: false }
  }
  let points = 0
  for (const stroke of parsed.s) {
    if (stroke && Array.isArray(stroke.p)) {
      points += Math.floor(stroke.p.length / 3)
    }
  }
  return { bytes, strokes: parsed.s.length, points, valid: true }
}

export function whiteboardBodyRefusal(body) {
  const { bytes, strokes, points, valid } = measureWhiteboardBody(body)
  if (strokes > WHITEBOARD_MAX_STROKES) {
    return 'strokes'
  }
  if (points > WHITEBOARD_MAX_POINTS) {
    return 'points'
  }
  if (bytes > WHITEBOARD_MAX_BLOCK_BYTES) {
    return 'blockBytes'
  }
  if (!valid) {
    return 'invalid'
  }
  return null
}
