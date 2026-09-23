export const NOTE_EXCERPT_MAX_LENGTH = 120

export function notesEnabledIn(config: Record<string, any> | null | undefined): boolean {
  return config?.features?.notes !== false
}

export function notesEnabled(siteId: string): boolean {
  const site = CARDINAL.sites?.[siteId]
  if (!site) {
    return false
  }
  return notesEnabledIn(site.config)
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/
const BLOCK_DIRECTIVE_RE = /^\s*::/
const HORIZONTAL_RULE_RE = /^\s*([-*_])(\s*\1){2,}\s*$/
const ESCAPED_PIPE = '\u0000'
const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

export function stripMarkdownLine(line: string): string {
  const isTableRow = /^\s*\|/.test(line)
  const text = line
    .replace(/\\\|/g, ESCAPED_PIPE)
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/^\s*>+\s?/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, '$1$2')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~=])/g, '$1')
    .replace(/&nbsp;/g, ' ')
  const flattened = isTableRow
    ? text
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0)
        .join(' · ')
    : text
  return flattened.replaceAll(ESCAPED_PIPE, '|').replace(/\s+/g, ' ').trim()
}

export function noteExcerpt(content: string | null | undefined): string {
  if (!content) {
    return ''
  }
  let fence: string | null = null
  for (const line of content.split(/\r?\n/)) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) {
        fence = null
      }
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!
      continue
    }
    if (
      BLOCK_DIRECTIVE_RE.test(line) ||
      HORIZONTAL_RULE_RE.test(line) ||
      TABLE_DIVIDER_RE.test(line)
    ) {
      continue
    }
    const text = stripMarkdownLine(line)
    if (text.length > 0) {
      return truncate(text, NOTE_EXCERPT_MAX_LENGTH)
    }
  }
  return ''
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) {
    return text
  }
  return (
    chars
      .slice(0, max - 1)
      .join('')
      .trimEnd() + '…'
  )
}
