import { getStroke } from 'perfect-freehand'

import { MAX_BLOCK_BYTES, MAX_POINTS, MAX_STROKES } from './limits.js'

export const FORMAT_VERSION = 2
export const DEFAULT_WIDTH = 800
export const DEFAULT_HEIGHT = 450
export const MIN_SIDE = 16
export const MAX_SIDE = 4096
export const DEFAULT_COLOR = '#1f2937'
export const DEFAULT_SIZE = 6
export const MIN_SIZE = 1
export const MAX_SIZE = 64
export const PRESSURE_SCALE = 100

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

const STROKE_OPTIONS = {
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false
}

const encoder = new TextEncoder()

export function utf8Length(text) {
  return encoder.encode(text).length
}

export function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(Math.max(value, min), max)
}

export function safeColor(value) {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : DEFAULT_COLOR
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function emptyBoard() {
  return { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT, s: [] }
}

function parseLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function strokeLinesOf(text) {
  return text
    .split('\n')
    .slice(1)
    .filter((line) => line.trim() !== '')
}

function pointsOf(raw) {
  return isPlainObject(raw) && Array.isArray(raw.p) ? Math.floor(raw.p.length / 3) : 0
}

export function measureBody(source) {
  const text = (source ?? '').trim()
  const lines = text ? strokeLinesOf(text) : []
  let points = 0
  for (const line of lines) {
    points += pointsOf(parseLine(line))
  }
  return { bytes: utf8Length(text), strokes: lines.length, points }
}

export function exceedsCap({ bytes, strokes, points }) {
  return bytes > MAX_BLOCK_BYTES || strokes > MAX_STROKES || points > MAX_POINTS
}

function normalizeStroke(raw, w, h) {
  const triples = Math.floor(raw.p.length / 3)
  const p = Array.from({ length: triples * 3 })
  for (let i = 0; i < triples; i++) {
    const at = i * 3
    p[at] = Math.round(clampNumber(raw.p[at], 0, w, 0))
    p[at + 1] = Math.round(clampNumber(raw.p[at + 1], 0, h, 0))
    p[at + 2] = Math.round(clampNumber(raw.p[at + 2], 0, PRESSURE_SCALE, PRESSURE_SCALE / 2))
  }
  return {
    c: safeColor(raw.c),
    z: Math.round(clampNumber(raw.z, MIN_SIZE, MAX_SIZE, DEFAULT_SIZE)),
    p
  }
}

export function parseBoard(source) {
  const text = (source ?? '').trim()
  if (!text) {
    return { board: emptyBoard(), dropped: 0 }
  }
  if (utf8Length(text) > MAX_BLOCK_BYTES) {
    return { error: 'tooLarge' }
  }

  const header = parseLine(text.split('\n', 1)[0])
  if (!isPlainObject(header) || header.v === undefined) {
    return { error: 'invalid' }
  }
  if (header.v !== FORMAT_VERSION) {
    return { error: 'version', version: String(header.v).slice(0, 32) }
  }

  const strokeLines = strokeLinesOf(text)
  if (strokeLines.length > MAX_STROKES) {
    return { error: 'tooLarge' }
  }

  const rawStrokes = []
  let points = 0
  for (const line of strokeLines) {
    const raw = parseLine(line)
    if (isPlainObject(raw) && Array.isArray(raw.p)) {
      rawStrokes.push(raw)
      points += pointsOf(raw)
    }
  }
  if (points > MAX_POINTS) {
    return { error: 'tooLarge' }
  }

  const w = Math.round(clampNumber(header.w, MIN_SIDE, MAX_SIDE, DEFAULT_WIDTH))
  const h = Math.round(clampNumber(header.h, MIN_SIDE, MAX_SIDE, DEFAULT_HEIGHT))
  return {
    board: { w, h, s: rawStrokes.map((raw) => normalizeStroke(raw, w, h)) },
    dropped: strokeLines.length - rawStrokes.length
  }
}

export function serializeStroke({ c, z, p }) {
  return JSON.stringify({ c, z, p })
}

export function serializeBoard(board) {
  return [
    JSON.stringify({ v: FORMAT_VERSION, w: board.w, h: board.h }),
    ...board.s.map(serializeStroke)
  ].join('\n')
}

export function appendStroke(source, stroke) {
  return `${source}\n${serializeStroke(stroke)}`
}

function fmt(n) {
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0'
}

export function outlineToPath(outline) {
  const len = outline.length
  if (len < 2) {
    return ''
  }
  if (len < 4) {
    return `M${outline.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L')} Z`
  }
  const mid = (a, b) => (a + b) / 2
  let [a, b] = outline
  const c = outline[2]
  let d = `M${fmt(a[0])},${fmt(a[1])} Q${fmt(b[0])},${fmt(b[1])} ${fmt(mid(b[0], c[0]))},${fmt(mid(b[1], c[1]))} T`
  for (let i = 2; i < len - 1; i++) {
    a = outline[i]
    b = outline[i + 1]
    d += `${fmt(mid(a[0], b[0]))},${fmt(mid(a[1], b[1]))} `
  }
  return `${d}Z`
}

export function strokePath(stroke, { last = true } = {}) {
  const input = []
  for (let i = 0; i + 2 < stroke.p.length; i += 3) {
    input.push([stroke.p[i], stroke.p[i + 1], stroke.p[i + 2] / PRESSURE_SCALE])
  }
  if (input.length === 0) {
    return ''
  }
  return outlineToPath(getStroke(input, { ...STROKE_OPTIONS, size: stroke.z, last }))
}
