/**
 * The markdown half of `wikiBlockNode.js`: a marked.js block tokenizer plus the `parseMarkdown` /
 * `renderMarkdown` pair `@tiptap/markdown`'s `MarkdownManager` calls off it, for the
 * `::block-name{...}` … `::` (and `:::…:::`, for a block whose body nests one of its own) syntax
 * `renderers/modules/markdown-it-blocks.js#wikiBlock()` already reads for the read view and
 * `helpers/blocks.js#blockMarkdown()` already writes for the plain-text editor's picker.
 *
 * The scanning logic below is a port of that same read-view rule (`wikiBlock()`) onto marked's
 * plain-string tokenizer contract, in place of markdown-it's line-indexed block-rule `state` --
 * same two passes (find the opening line's name/props, then walk forward for the matching close,
 * skipping fenced code and tracking same-length nesting), different host parser.
 */

import { linesOutsideFences } from '@/helpers/markdownFences'

import { parseBlockProps, serializeBlockProps } from './wikiBlockAttrs'

export const WIKI_BLOCK_NODE_NAME = 'wikiBlock'

/** A block's opening line, alone: `::block-name`, with its attributes if it was given any. */
const OPEN_LINE = /^(:{2,})block-([a-z0-9-]+)[ \t]*(?:\{(.*)\})?[ \t]*$/

/**
 * The line, strictly among `lines.slice(1)`, that closes this block -- or `-1` if the source runs
 * out first, the same "still emit what there is" fallback `wikiBlock()` takes for a block a page's
 * author left unclosed, rather than losing the block (or everything after it) outright.
 *
 * A marker run of the SAME length nested inside the body -- another block written by hand at this
 * exact fence depth, rather than the one MDC's own writer would give it -- is tracked as nesting
 * rather than misread as this block's own close; a run of a DIFFERENT length belongs to a nested
 * block at another fence depth and is left alone here, for that block's own tokenizer call to find
 * once `tokenize()` below recurses into the body.
 *
 * @param {string[]} lines The full token source, split on `\n`; `lines[0]` is the opening line.
 * @param {number} markerCount How many colons opened this block.
 * @returns {number}
 */
function findClosingLine(lines, markerCount) {
  let nestingDepth = 0
  let closeIndex = -1
  linesOutsideFences(lines, (line, index) => {
    if (index === 0) {
      // -> The opening line itself starts with the same colons -- never its own close.
      return undefined
    }
    const markerMatch = /^:+/.exec(line)
    if (!markerMatch || markerMatch[0].length !== markerCount) {
      return undefined
    }
    if (line.slice(markerCount).trim()) {
      // -> Trailing content after the marker run -- a same-length block opening, not a bare close.
      nestingDepth++
      return undefined
    }
    if (nestingDepth > 0) {
      nestingDepth--
      return undefined
    }
    closeIndex = index
    return lines.length // -> Found it; stop `linesOutsideFences` from walking any further.
  })
  return closeIndex
}

/**
 * Strips a trailing empty paragraph token `lexer.blockTokens()` leaves for a body ending in blank
 * lines -- the same cleanup `@tiptap/core`'s own `createBlockMarkdownSpec()` does for its Pandoc-
 * style blocks. Left in, it round-trips back out as a literal `&nbsp;` paragraph that was never
 * actually there (`@tiptap/extension-paragraph`'s own empty-paragraph placeholder), which is not
 * render-equal to the source that never held one.
 *
 * @param {Array<object>} tokens
 * @returns {Array<object>}
 */
function trimTrailingEmptyParagraph(tokens) {
  const trimmed = [...tokens]
  while (trimmed.length > 0) {
    const last = trimmed.at(-1)
    if (last.type === 'paragraph' && !(last.text ?? '').trim()) {
      trimmed.pop()
      continue
    }
    break
  }
  return trimmed
}

/**
 * marked.js block-level tokenizer for a wiki block, registered on the node in `wikiBlockNode.js`
 * (`Node.create({ markdownTokenizer: wikiBlockMarkdownTokenizer, … })`, read by
 * `@tiptap/markdown`'s `MarkdownManager#registerExtension()`).
 */
export const wikiBlockMarkdownTokenizer = {
  name: WIKI_BLOCK_NODE_NAME,
  level: 'block',
  start(src) {
    const match = /^:{2,}block-[a-z0-9-]+/m.exec(src)
    return match ? match.index : -1
  },
  tokenize(src, _tokens, lexer) {
    const firstBreak = src.indexOf('\n')
    const firstLine = firstBreak === -1 ? src : src.slice(0, firstBreak)
    const open = OPEN_LINE.exec(firstLine)
    if (!open) {
      return undefined
    }

    const markerCount = open[1].length
    const lines = src.split('\n')
    const closeIndex = findClosingLine(lines, markerCount)
    const bodyEndLine = closeIndex === -1 ? lines.length : closeIndex
    const consumedThrough = closeIndex === -1 ? lines.length : closeIndex + 1

    // -> `lines.join('\n')` losslessly reconstructs whatever `src.split('\n')` was given, so `raw`
    //    is built the same way -- plus the one trailing `\n` that separated the consumed lines from
    //    whatever follows, which slicing a PREFIX of `lines` back together would otherwise drop.
    const raw =
      lines.slice(0, consumedThrough).join('\n') + (consumedThrough < lines.length ? '\n' : '')
    const body = lines.slice(1, bodyEndLine).join('\n')

    const contentTokens = trimTrailingEmptyParagraph(lexer.blockTokens(body))
    /*
      `blockTokens()` alone leaves a token's own text un-inline-parsed (no bold/italic/links
      resolved) -- only `Lexer#lex()`'s own top-level pass normally runs the inline stage, and
      `blockTokens()` is called here instead of that. The same follow-up
      `@tiptap/core`'s `createBlockMarkdownSpec()` does for its own nested block content.
    */
    for (const token of contentTokens) {
      if (token.text && (!token.tokens || token.tokens.length === 0)) {
        token.tokens = lexer.inlineTokens(token.text)
      }
    }

    return {
      type: WIKI_BLOCK_NODE_NAME,
      raw,
      block: open[2],
      props: parseBlockProps(open[3]),
      tokens: contentTokens
    }
  }
}

/** @type {(token: object, h: import('@tiptap/core').MarkdownParseHelpers) => object} */
export function parseWikiBlockMarkdown(token, h) {
  return h.createNode(
    WIKI_BLOCK_NODE_NAME,
    { block: token.block, props: token.props },
    h.parseChildren(token.tokens || [])
  )
}

/**
 * How many colons this block's own opener/closer needs: one more than the longest fence any DIRECT
 * child block needs for itself, so that child's own closing line can never be mistaken for this
 * one's -- `helpers/blocks.js#blockMarkdown()`'s own two-vs-three-colon rule
 * (`/^::/m.test(block.template) ? ':::' : '::'`), generalised to whatever nesting depth the editor's
 * own content actually holds, computed bottom-up rather than assumed from one level.
 *
 * @param {{ content?: Array<{type?: string}> }} node
 * @returns {number}
 */
function fenceLengthFor(node) {
  const nestedLengths = (node.content ?? [])
    .filter((child) => child.type === WIKI_BLOCK_NODE_NAME)
    .map((child) => fenceLengthFor(child))
  return nestedLengths.length > 0 ? Math.max(...nestedLengths) + 1 : 2
}

/** @type {(node: object, h: import('@tiptap/core').MarkdownRendererHelpers) => string} */
export function renderWikiBlockMarkdown(node, h) {
  const fence = ':'.repeat(fenceLengthFor(node))
  const propsText = serializeBlockProps(node.attrs?.props)
  const suffix = propsText ? `{${propsText}}` : ''
  const body = h.renderChildren(node.content || [], '\n\n')
  return `${fence}block-${node.attrs?.block}${suffix}\n${body}\n${fence}`
}
