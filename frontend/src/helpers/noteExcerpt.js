export const NOTE_EXCERPT_MAX = 120

function stripInline(raw) {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, '$1')
    .trim()
}

export function noteExcerpt(markdown) {
  let inFence = false
  for (const raw of (markdown ?? '').split('\n')) {
    const trimmed = raw.trim()
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence || /^(:{2,}|---+$|\|)/.test(trimmed)) {
      continue
    }
    const line = stripInline(raw)
    if (line) {
      return line.length > NOTE_EXCERPT_MAX ? line.slice(0, NOTE_EXCERPT_MAX) : line
    }
  }
  return ''
}
