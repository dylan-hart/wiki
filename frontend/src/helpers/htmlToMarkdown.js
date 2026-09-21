import TurndownService from 'turndown'
import { tables, taskListItems } from '@joplin/turndown-plugin-gfm'

/**
 * Converts a clipboard `text/html` payload into markdown for the markdown editor's paste path, so
 * structure the source author relied on survives instead of being flattened to `text/plain`.
 *
 * Office-family clipboard HTML (OneNote, Word) has two quirks turndown's defaults do not cover:
 *
 * 1. It marks bold/italic/strikethrough/underline with an inline `style` attribute on a `<span>`
 *    rather than `<strong>`/`<em>`/`<s>`/`<u>`. The `presentational*` rules below read the style
 *    ATTRIBUTE, not `node.style`, which a non-browser parser may leave unpopulated.
 * 2. Its to-do lists are a plain `<ul>`/`<li>` with a Unicode ballot-box glyph (☐ U+2610,
 *    ☑ U+2611) as the item's first character rather than a semantic checkbox --
 *    `convertCheckboxGlyphs` rewrites those to GFM task-list syntax afterwards. A real
 *    `<input type="checkbox">` is already covered by `@joplin/turndown-plugin-gfm`'s
 *    `taskListItems`. That plugin's `strikethrough` rule is deliberately NOT used, in favour of
 *    this file's own: it emits single-tilde `~text~`, Pandoc's spelling, which this app's
 *    `markdown-it` renderer does not recognise at all.
 *
 * Images become a `![alt](pending-image:N)` placeholder plus an entry in the returned `images`
 * list: an HTML paste can carry a multi-megabyte `data:` URI, inlining it would dump the blob into
 * the page source, and dropping it loses the image. Uploading it is async while turndown's
 * `addRule` replacement is not, so resolving the placeholders is the caller's job.
 *
 * There is no "is this worth converting" gate here -- every non-empty payload is converted. That
 * gate belongs to the caller, which compares the HTML's visible text against the clipboard's
 * `text/plain` sibling (`helpers/htmlVisibleText.js#isSameVisibleText`) so a same-editor copy never
 * round-trips through turndown's escaping.
 */

function styleValue(node, property) {
  const style = (node.getAttribute && node.getAttribute('style')) || ''
  const match = style.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i'))
  return match ? match[1].trim().toLowerCase() : ''
}

const isPresentationalBold = (node) =>
  /^(bold|bolder|[6-9]00)/.test(styleValue(node, 'font-weight'))
const isPresentationalItalic = (node) => styleValue(node, 'font-style').startsWith('italic')
const isPresentationalStrike = (node) =>
  styleValue(node, 'text-decoration').includes('line-through')
const isPresentationalUnderline = (node) =>
  styleValue(node, 'text-decoration').includes('underline')
const hasContent = (content) => content.trim().length > 0
// -> Office gives whole paragraphs and bullets a uniform base font-size on their block container;
//    that is not the mid-paragraph change this rule is for, and wrapping it would inject a `<span>`
//    between a list marker and its text. `node.isBlock` is turndown's own flag, set before filters.
const isPresentationalFontSize = (node) => !node.isBlock && styleValue(node, 'font-size').length > 0

/*
  turndown's `addRule` API takes no per-call argument, and its parse is synchronous and
  non-reentrant, so a module-level variable is enough to hand each `<img>` firing back to the call
  that triggered it.
*/
let currentImageCollector = null

function collectPendingImage(node) {
  const src = ((node.getAttribute && node.getAttribute('src')) || '').trim()
  if (!src || !currentImageCollector) {
    return ''
  }
  // Word/OneNote auto-generate a multi-line OCR description as `alt`, which is not valid inside
  // inline markdown image syntax. Collapsing it here also keeps the placeholder byte-identical to
  // what a caller reconstructs from `alt`, which `normalize()`'s per-line trim would otherwise
  // desync.
  const rawAlt = (node.getAttribute && node.getAttribute('alt')) || ''
  const alt = rawAlt.replace(/\s+/g, ' ').trim()
  const token = `pending-image:${currentImageCollector.length}`
  currentImageCollector.push({ token, src, alt })
  return `![${alt}](${token})`
}

function buildTurndownService() {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined'
  })
  service.use([tables, taskListItems])

  // -> Their text content would otherwise leak into the markdown as stray body text.
  service.remove(['style', 'script'])

  service.addRule('presentationalStrong', {
    filter: (node) => !['STRONG', 'B'].includes(node.nodeName) && isPresentationalBold(node),
    replacement: (content) => (hasContent(content) ? `**${content}**` : content)
  })
  service.addRule('presentationalEm', {
    filter: (node) => !['EM', 'I'].includes(node.nodeName) && isPresentationalItalic(node),
    replacement: (content) => (hasContent(content) ? `_${content}_` : content)
  })
  service.addRule('strikethrough', {
    filter: (node) =>
      ['DEL', 'S', 'STRIKE'].includes(node.nodeName) || isPresentationalStrike(node),
    replacement: (content) => (hasContent(content) ? `~~${content}~~` : content)
  })
  // -> Markdown has no underline syntax, so `<u>` is the lossless fallback: a site with HTML
  //    rendering off shows it escaped rather than dropping the author's emphasis silently.
  service.addRule('presentationalUnderline', {
    filter: (node) => node.nodeName !== 'U' && isPresentationalUnderline(node),
    replacement: (content) => (hasContent(content) ? `<u>${content}</u>` : content)
  })
  service.addRule('underlineTag', {
    filter: 'u',
    replacement: (content) => (hasContent(content) ? `<u>${content}</u>` : content)
  })
  // -> Same lossless fallback as the `<u>` rule above. `font-size` (unlike `font-family`) is in
  //    the backend's general-author style allowlist, so this survives rendering for any author.
  service.addRule('presentationalFontSize', {
    filter: isPresentationalFontSize,
    replacement: (content, node) =>
      hasContent(content)
        ? `<span style="font-size: ${styleValue(node, 'font-size')}">${content}</span>`
        : content
  })
  // -> `service.remove('img')` would lose to turndown's built-in `img` rule: `remove()` only wins
  //    for a tag with no default rule (hence `style`/`script` above). Overriding one turndown
  //    already has an opinion on takes an `addRule`, which is checked ahead of the defaults.
  service.addRule('pendingImage', {
    filter: 'img',
    replacement: (content, node) => collectPendingImage(node)
  })

  return service
}

let turndownService = null
function getTurndownService() {
  turndownService ??= buildTurndownService()
  return turndownService
}

/*
  Office clipboard writes (the CF_HTML format) prepend a plain-text descriptor block of byte
  offsets ahead of the markup. Browsers strip it before handing `text/html` to the Clipboard API,
  but nothing in the spec guarantees that, so this is defensive: a payload still opening with a
  `Version:` line loses everything before its first `<`, which a CF_HTML header never contains.
*/
export function stripClipboardHeader(html) {
  return /^\s*Version:/i.test(html) ? html.replace(/^[\s\S]*?(?=<)/, '') : html
}

/*
  Office clipboard `text/html` is routinely a full `<html>...<body>` shell. Turndown wraps its
  input in an `<x-turndown>` element and parses THAT as a document, so a nested `<html>`/`<body>`
  pair has to be reconciled by the parser's tag-adoption rules -- which happy-dom, this project's
  test environment, resolves to an empty conversion. Cutting to the body content avoids relying on
  that reconciliation anywhere.
*/
function unwrapDocumentShell(html) {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  return body ? body[1] : html.replace(/<\/?html[^>]*>/gi, '')
}

/*
  Office-family HTML commonly expresses list depth with one `<ul>`/`<ol>` per level sitting as a
  SIBLING inside a common ancestor list rather than inside the `<li>` it belongs under, and no
  engine reparents it -- a `<ul>` directly inside a `<ul>` parses exactly as written. turndown's
  `listItem` rule indents the string it assembled from the `<li>`'s own children, so such a
  sub-list is invisible to it and comes out as an unindented sibling bullet run.

  Repairing the DOM first is what lets turndown's untouched default rules render it correctly. A
  well-formed sub-list is its `<li>`'s child and so has no preceding element sibling: a no-op here.
  Beware hand-written fixtures -- nobody types this shape, so only captured markup exercises it.
*/
function renestOrphanedSublists(root) {
  for (const list of root.querySelectorAll('ul, ol')) {
    const parent = list.parentNode
    const previous = list.previousElementSibling
    if (parent && ['UL', 'OL'].includes(parent.nodeName) && previous?.nodeName === 'LI') {
      previous.appendChild(list)
    }
  }
}

const UNCHECKED_GLYPH_RE = /^(\s*[-*+]\s+)[☐]️?\s?/gm
const CHECKED_GLYPH_RE = /^(\s*[-*+]\s+)[☑✓✔]️?\s?/gm

export function convertCheckboxGlyphs(markdown) {
  return markdown.replace(UNCHECKED_GLYPH_RE, '$1[ ] ').replace(CHECKED_GLYPH_RE, '$1[x] ')
}

function normalize(markdown) {
  return markdown
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * `images` is the ordered `{ token, src, alt }` list resolving the placeholders in `markdown`.
 * Each `token` is exactly the placeholder text embedded for that image, so a caller substitutes it
 * with a plain substring replace and never parses back out of the markdown.
 */
export function htmlToMarkdown(html) {
  if (!html || !html.trim()) {
    return { markdown: '', images: [] }
  }
  const normalizedHtml = unwrapDocumentShell(stripClipboardHeader(html))
  // -> Parsed here rather than handed to turndown as a string, so `renestOrphanedSublists` can
  //    repair the DOM before any rule sees it; turndown takes a pre-parsed element just as
  //    readily. The `<x-turndown>` wrapper mirrors what turndown's own string path builds, so a
  //    stray top-level `<head>`/`<body>` split a parser introduces does not matter here either.
  const doc = new DOMParser().parseFromString(
    `<x-turndown id="turndown-root">${normalizedHtml}</x-turndown>`,
    'text/html'
  )
  const root = doc.getElementById('turndown-root')
  renestOrphanedSublists(root)
  const images = []
  currentImageCollector = images
  let markdown
  try {
    markdown = getTurndownService().turndown(root)
  } finally {
    currentImageCollector = null
  }
  return { markdown: normalize(convertCheckboxGlyphs(markdown)), images }
}
