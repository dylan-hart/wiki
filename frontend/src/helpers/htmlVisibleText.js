import { stripClipboardHeader } from './htmlToMarkdown.js'

/**
 * The markdown editor's paste gate. Monaco's "copy with syntax highlighting" writes a `text/html`
 * payload alongside `text/plain` on every ordinary in-editor copy, indistinguishable at a glance
 * from a genuine rich paste -- and running one back through `htmlToMarkdown` corrupts it (stray
 * escaping, plus a blank line per source line, since turndown treats each `<div>` as a paragraph).
 *
 * The test is self-consistent rather than Monaco-version-coupled: reduce the HTML to its bare
 * visible text and compare it with the `text/plain` sibling. Monaco only colors the source, never
 * restructures it, so a same-editor round trip reduces to an identical pair, while a genuine rich
 * paste (link, image, list, emphasis, table) loses what a text reduction cannot carry and diverges.
 */

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL'
])

// -> Never part of the visible page, so their text would leak into the comparison as body text.
const SKIPPED_TAGS = new Set(['STYLE', 'SCRIPT'])

function walk(node, out) {
  if (node.nodeType === 3 /* Node.TEXT_NODE */) {
    out.push(node.textContent)
    return
  }
  if (node.nodeType !== 1 /* Node.ELEMENT_NODE */) {
    return
  }
  if (SKIPPED_TAGS.has(node.tagName)) {
    return
  }
  if (node.tagName === 'BR') {
    out.push('\n')
    return
  }
  const isBlock = BLOCK_TAGS.has(node.tagName)
  if (isBlock) {
    out.push('\n')
  }
  for (const child of node.childNodes) {
    walk(child, out)
  }
  if (isBlock) {
    out.push('\n')
  }
}

/**
 * A `\n` goes in at each block-element/`<br>` boundary so Monaco's one-`<div>`-per-line copy HTML
 * does not collapse into a single run-on line. The result is not whitespace-normalized.
 */
export function htmlToVisibleText(html) {
  if (!html || !html.trim()) {
    return ''
  }
  const doc = new DOMParser().parseFromString(stripClipboardHeader(html), 'text/html')
  const out = []
  walk(doc.body, out)
  return out.join('')
}

// -> `\u00A0` is in there deliberately: Monaco renders repeated indentation as `&nbsp;` runs, which
//    decode to real U+00A0. Left alone, indented code copied and pasted back into the SAME editor
//    would never match its `text/plain` sibling's ordinary spaces and would wrongly convert.
function normalizeVisibleText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00A0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/**
 * An `html` reducing to NO visible text (an image-only paste) never counts as a match, whatever
 * `text` is: a same-editor Monaco copy always carries its source as real text, so an empty
 * reduction means content this function cannot see, which must still go through the conversion.
 */
export function isSameVisibleText(html, text) {
  const visibleText = normalizeVisibleText(htmlToVisibleText(html))
  if (visibleText.length === 0) {
    return false
  }
  return visibleText === normalizeVisibleText(text ?? '')
}
