import TurndownService from 'turndown'
import { tables, taskListItems } from 'turndown-plugin-gfm'

/**
 * Converts a clipboard `text/html` payload into markdown for the markdown editor's paste path
 * (OpenProject #2448, Feature #2417). `EditorMarkdown.vue`'s paste handler is the one caller: when
 * a paste carries `text/html`, this is what stands in for the browser's own plain-text paste, so
 * structure a webpage/Word/OneNote/etc. author relied on (headings, lists, links, emphasis, tables)
 * survives as real markdown instead of being flattened to whatever `text/plain` happened to be.
 *
 * OneNote is the feature's named validation case, and its clipboard HTML has two quirks turndown's
 * defaults do not cover on their own:
 *
 * 1. It marks bold/italic/strikethrough/underline with an inline `style` attribute on a `<span>`
 *    (or the odd `<div>`) rather than `<strong>`/`<em>`/`<s>`/`<u>` -- the same convention Word and
 *    most Office-family paste HTML uses. `presentational*` rules below detect the style property
 *    directly (not `node.style`, which a non-browser parser -- e.g. under `npm run test` -- may not
 *    populate) so they fire whichever parser turndown ends up using.
 * 2. Its to-do lists render as a plain `<ul>`/`<li>` with a Unicode ballot-box glyph
 *    (☐ U+2610 unchecked, ☑ U+2611 checked) as the item's own first character, not a semantic
 *    checkbox -- `convertCheckboxGlyphs` rewrites those lines to GFM task-list syntax afterwards.
 *    A real `<input type="checkbox">`, which other sources (and older OneNote captures) do send, is
 *    already handled by `turndown-plugin-gfm`'s own `taskListItems` rule and needs nothing extra
 *    here. Its `strikethrough` rule is deliberately NOT used, in favour of this file's own (below):
 *    it emits single-tilde `~text~`, which is Pandoc's strikethrough spelling, not GFM's -- and this
 *    app's renderer (`markdown-it`, whose own strikethrough support is a CommonMark/GFM `~~text~~`
 *    core rule) does not recognise it at all.
 *
 * Two more decisions worth calling out:
 *
 * - **Images are dropped, not converted.** An HTML paste can carry an inline image as a `data:`
 *   URI (a screenshot pasted into OneNote/Word, then copied out, commonly does) worth megabytes of
 *   base64 -- turning that into a markdown `![]()` would dump the whole blob into the page source.
 *   Image-paste-to-asset-upload is Feature #2417's *other* child (#2449); until that lands, the
 *   correct behavior here is to leave the image out rather than inline an unreadable blob.
 * - **No "is this worth converting" gate.** Every non-empty `text/html` payload is converted, with
 *   no attempt to detect "this is really just plain text with an incidental HTML wrapper" and skip
 *   conversion for it. Escaping markdown-significant characters in plain prose (turndown's
 *   `\*`/`\_`/`` \` `` escaping) is the accepted cost of reliable HTML→markdown conversion elsewhere
 *   too -- see turndown's own documentation -- and a richness heuristic would be guesswork this
 *   ticket's scope (OneNote/web/Office paste) does not call for.
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
  // -> GFM strikethrough (`~~text~~`), covering both the real tags AND the OneNote/Office
  //    presentational-style spelling in one rule -- see the module doc comment on why
  //    `turndown-plugin-gfm`'s own `strikethrough` rule is not used here.
  service.addRule('strikethrough', {
    filter: (node) =>
      ['DEL', 'S', 'STRIKE'].includes(node.nodeName) || isPresentationalStrike(node),
    replacement: (content) => (hasContent(content) ? `~~${content}~~` : content)
  })
  // -> Markdown has no native underline syntax; `<u>` is the CommonMark-legal, lossless fallback
  //    every other emphasis kind above has a real marker for. A site with HTML rendering disabled
  //    shows it escaped literally rather than silently dropping the author's emphasis.
  service.addRule('presentationalUnderline', {
    filter: (node) => node.nodeName !== 'U' && isPresentationalUnderline(node),
    replacement: (content) => (hasContent(content) ? `<u>${content}</u>` : content)
  })
  service.addRule('underlineTag', {
    filter: 'u',
    replacement: (content) => (hasContent(content) ? `<u>${content}</u>` : content)
  })
  // -> See "Images are dropped, not converted" above. `img` has a built-in turndown rule, so
  //    `service.remove('img')` would never win against it -- `remove()` only wins for a tag with NO
  //    default rule to begin with (which is why it works for `style`/`script` above); overriding a
  //    tag turndown already has an opinion on takes a real `addRule`, checked before the defaults.
  service.addRule('dropImages', {
    filter: 'img',
    replacement: () => ''
  })

  return service
}

let turndownService = null
function getTurndownService() {
  turndownService ??= buildTurndownService()
  return turndownService
}

/*
  Office/OneNote clipboard writes (the CF_HTML format) prepend a plain-text descriptor block --
  Version/StartHTML/EndHTML/StartFragment/EndFragment byte offsets -- ahead of the actual markup.
  Every browser observed strips this before handing `text/html` to the Clipboard API, but nothing
  in the spec guarantees it, so this is a defensive strip: a payload that still opens with a
  `Version:` line has everything before its first `<` cut, which a CF_HTML header never contains.
*/
function stripClipboardHeader(html) {
  return /^\s*Version:/i.test(html) ? html.replace(/^[\s\S]*?(?=<)/, '') : html
}

/*
  What survives the strip above is still commonly a full `<html>...<body>...</body></html>` shell --
  real clipboard `text/html` from an Office-family paste routinely looks exactly like that, with the
  actual content sitting between `<!--StartFragment-->`/`<!--EndFragment-->` markers inside the
  body. Turndown parses its input by wrapping it in its own `<x-turndown>` element and parsing THAT
  as a full document, so a second, nested `<html>`/`<body>` pair in the input has to be reconciled by
  the parser's tag-adoption rules -- and not every DOMParser implementation does that the same way a
  browser does (verified: it silently produces an empty conversion under happy-dom, this project's
  own test environment). Cutting straight to the body content sidesteps relying on that reconciliation
  at all, in tests and in whichever browser the editor actually runs in alike.
*/
function unwrapDocumentShell(html) {
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)
  return body ? body[1] : html.replace(/<\/?html[^>]*>/gi, '')
}

const UNCHECKED_GLYPH_RE = /^(\s*[-*+]\s+)[☐]️?\s?/gm
const CHECKED_GLYPH_RE = /^(\s*[-*+]\s+)[☑✓✔]️?\s?/gm

function convertCheckboxGlyphs(markdown) {
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
 * `html` -> markdown, or `''` for a blank/whitespace-only payload.
 */
export function htmlToMarkdown(html) {
  if (!html || !html.trim()) {
    return ''
  }
  const normalizedHtml = unwrapDocumentShell(stripClipboardHeader(html))
  const markdown = getTurndownService().turndown(normalizedHtml)
  return normalize(convertCheckboxGlyphs(markdown))
}
