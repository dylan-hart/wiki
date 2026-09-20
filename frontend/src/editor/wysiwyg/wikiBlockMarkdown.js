/**
 * The markdown half of `wikiBlockNode.js`, for the `::block-name{...}` … `::` syntax (and
 * `:::…:::`, for a block whose body nests one of its own). The same grammar the read view's
 * markdown-it block rule reads, ported onto marked's plain-string tokenizer contract rather than
 * shared with it: the two host parsers hand a rule entirely different state to scan.
 */

import { linesOutsideFences } from '@/helpers/markdownFences'

import { parseBlockProps, serializeBlockProps } from './wikiBlockAttrs'

export const WIKI_BLOCK_NODE_NAME = 'wikiBlock'

const OPEN_LINE = /^(:{2,})block-([a-z0-9-]+)[ \t]*(?:\{(.*)\})?[ \t]*$/

/**
 * `-1` when the source runs out first: an unclosed block still emits what there is, rather than
 * losing the block -- or everything after it -- outright.
 *
 * A marker run of the SAME length nested inside the body is tracked as nesting rather than misread
 * as this block's own close; a run of a DIFFERENT length belongs to a nested block at another fence
 * depth and is left for that block's own tokenizer call once `tokenize()` recurses into the body.
 *
 * @param {string[]} lines The full token source, split on `\n`; `lines[0]` is the opening line.
 * @param {number} markerCount How many colons opened this block.
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
    return lines.length // -> Stops `linesOutsideFences` walking any further.
  })
  return closeIndex
}

/**
 * A body ending in blank lines leaves `lexer.blockTokens()` a trailing empty paragraph token. Left
 * in, it round-trips back out as a literal `&nbsp;` paragraph the source never held.
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

    // -> `raw` must also carry the one trailing `\n` that separated the consumed lines from
    //    whatever follows, which joining a PREFIX of `lines` back together would otherwise drop.
    const raw =
      lines.slice(0, consumedThrough).join('\n') + (consumedThrough < lines.length ? '\n' : '')
    const body = lines.slice(1, bodyEndLine).join('\n')

    const contentTokens = trimTrailingEmptyParagraph(lexer.blockTokens(body))
    /*
      `blockTokens()` alone leaves a token's own text un-inline-parsed (no bold/italic/links
      resolved) -- only `Lexer#lex()`'s own top-level pass normally runs the inline stage.
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
 * One colon more than the longest fence any DIRECT child block needs for itself, so a child's own
 * closing line can never be mistaken for this one's. Computed bottom-up, since nesting depth is
 * whatever the editor's content holds rather than a fixed two-vs-three.
 *
 * @param {{ content?: Array<{type?: string}> }} node
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
