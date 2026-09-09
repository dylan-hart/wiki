import { stripClipboardHeader } from './htmlToMarkdown.js'

/**
 * `EditorMarkdown.vue`'s paste handler's gate for OpenProject #2834: Monaco's own "copy with syntax
 * highlighting" writes a `text/html` payload (per-token `<span style="color:...">` runs, one `<div>`
 * per source line) alongside `text/plain` on every ordinary in-editor copy/cut, indistinguishable at
 * a glance from a genuine external rich-content paste (a webpage selection, Word/OneNote) --
 * `helpers/htmlToMarkdown.js` was written for the latter and unconditionally converted both, which is
 * what corrupted a same-editor copy/paste (stray escaping, a blank line inserted between every
 * original line, since turndown treats each `<div>` as its own paragraph).
 *
 * The distinction this module draws is self-consistent rather than Monaco-version-coupled: reduce
 * the `text/html` payload to its own bare visible text -- tags gone, entities decoded, whitespace
 * normalized -- and compare it against the clipboard's `text/plain` sibling. Monaco never restructures
 * the source when it copies it, only colors it, so a same-editor round trip's two clipboard entries
 * are identical once reduced this way; a genuine rich paste (a link, an image, a list, real emphasis,
 * a table) almost always diverges once reduced to visible text, since none of that survives a bare
 * text reduction the same way it survives an HTML→markdown conversion. `isSameVisibleText` is the
 * caller-facing answer; `htmlToVisibleText` is exported alongside it purely so the reduction itself
 * can be tested in isolation.
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

// -> Their text content is never part of the rendered/visible page and would otherwise leak into the
//    comparison as stray body text -- the same reason `htmlToMarkdown.js#buildTurndownService` calls
//    `service.remove(['style', 'script'])`.
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
 * `html` -> its bare visible text: tags stripped, entities decoded (both come for free from
 * `DOMParser` + `Node#textContent`), with a `\n` inserted at each block-element/`<br>` boundary so
 * Monaco's one-`<div>`-per-line copy HTML doesn't collapse into a single run-on line. Not itself
 * normalized -- see `isSameVisibleText`, the one caller that needs a comparable form.
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

// -> `\u00A0` (non-breaking space) is included deliberately: Monaco's copy-with-syntax-highlighting
//    renders leading/repeated indentation as `&nbsp;` runs so it survives being pasted into a plain
//    text field elsewhere, which `DOMParser`/`textContent` decodes to real U+00A0 characters -- left
//    alone, indented code copied and pasted back into the SAME editor would never match its own
//    `text/plain` sibling (which uses ordinary spaces) and would wrongly keep converting.
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
 * True when `html`'s reduced visible text is the same, once whitespace-normalized, as `text` (the
 * clipboard's own `text/plain`) -- see the module doc comment above for what that is standing in for.
 *
 * An `html` that reduces to NO visible text at all -- an image-only paste (OpenProject #2504) is the
 * real one; `htmlToMarkdown`'s own `<img>` handling is what actually renders it -- never counts as a
 * match, regardless of `text`: a same-editor Monaco copy always carries its source as real text, so
 * an empty reduction only ever means `html` has non-text content this function cannot see, which
 * must keep going through the full conversion rather than being silently dropped as "no-op".
 */
export function isSameVisibleText(html, text) {
  const visibleText = normalizeVisibleText(htmlToVisibleText(html))
  if (visibleText.length === 0) {
    return false
  }
  return visibleText === normalizeVisibleText(text ?? '')
}
