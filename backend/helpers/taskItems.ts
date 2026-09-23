import MarkdownIt from 'markdown-it'

export interface TaskItem {
  index: number
  text: string
  checked: boolean
  line: number
}

const md = new MarkdownIt({ html: true })

const MARKER = /^\[([ xX])\] /
const MARKER_ON_LINE = /^((?:\s*(?:>|[-+*]|\d+[.)]))*\s*)\[[ xX]\](?=\s)/

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Mirrors the frontend task-list plugin's rule, so an item's `index` is also its checkbox's
 * position in the rendered page. Code blocks never yield list-item tokens, so a `- [ ]` in one is
 * not an item.
 */
export function parseTaskItems(markdown: string): TaskItem[] {
  const tokens = md.parse(markdown, {})
  const items: TaskItem[] = []
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i]!
    if (
      token.type !== 'inline' ||
      tokens[i - 1]!.type !== 'paragraph_open' ||
      tokens[i - 2]!.type !== 'list_item_open' ||
      !token.map
    ) {
      continue
    }
    const marker = MARKER.exec(token.content)
    if (!marker) {
      continue
    }
    items.push({
      index: items.length,
      text: token.content.slice(4),
      checked: marker[1] !== ' ',
      line: token.map[0]
    })
  }
  return items
}

/**
 * Returns `null` when the item at `index` is gone or its text differs (whitespace collapsed): the
 * caller's view of the page is stale.
 */
export function setTaskItem(
  markdown: string,
  index: number,
  text: string,
  checked: boolean
): string | null {
  const before = parseTaskItems(markdown)
  const item = before[index]
  if (!item || normalize(item.text) !== normalize(text)) {
    return null
  }
  if (item.checked === checked) {
    return markdown
  }
  const lines = markdown.split('\n')
  const source = lines[item.line]
  const found = source === undefined ? null : MARKER_ON_LINE.exec(source)
  if (!found) {
    return null
  }
  const prefix = found[1]!
  lines[item.line] = `${prefix}[${checked ? 'x' : ' '}]${source!.slice(prefix.length + 3)}`
  const next = lines.join('\n')

  // -> Refuses a rewrite that moved anything but the one marker, rather than storing it.
  const after = parseTaskItems(next)
  const onlyThisChanged =
    after.length === before.length &&
    after.every((entry, position) => {
      const original = before[position]!
      return position === index
        ? entry.checked === checked && entry.text === original.text
        : entry.checked === original.checked && entry.text === original.text
    })
  return onlyThisChanged ? next : null
}
