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

function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function measureWhiteboardBody(body) {
  const text = String(body ?? '').trim()
  const bytes = utf8ByteLength(text)
  if (!text) {
    return { bytes, strokes: 0, points: 0, valid: false }
  }
  const [header, ...lines] = text.split('\n')
  let strokes = 0
  let points = 0
  for (const line of lines) {
    if (line.trim() === '') {
      continue
    }
    strokes++
    const stroke = parseLine(line)
    if (isPlainObject(stroke) && Array.isArray(stroke.p)) {
      points += Math.floor(stroke.p.length / 3)
    }
  }
  return { bytes, strokes, points, valid: isPlainObject(parseLine(header)) }
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
