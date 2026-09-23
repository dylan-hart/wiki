import MarkdownIt, { type StateBlock, type Token } from 'markdown-it'

const COLON = ':'
const MIN_MARKERS = 2
const BLOCK_NAME = /^[a-zA-Z][\w-]*/

/**
 * The `::block-name{…}` … `::` container rule of the renderer's
 * `frontend/src/renderers/modules/markdown-it-blocks.js`, ported for structure alone: the name is
 * kept, props are not parsed. The two workspaces share no code, so this is kept in step with that
 * rule by hand -- the closing-line scan, fence skipping and same-length nesting below are its own.
 */
function wikiBlock(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean
): boolean {
  const start = state.bMarks[startLine]! + state.tShift[startLine]!
  const max = state.eMarks[startLine]!
  const indent = state.sCount[startLine]!

  if (state.src[start] !== COLON) {
    return false
  }
  let pos = start
  while (pos < max && state.src[pos] === COLON) pos++
  const markerCount = pos - start
  if (markerCount < MIN_MARKERS) {
    return false
  }
  const name = BLOCK_NAME.exec(state.src.slice(pos, max).trim())?.[0]
  if (!name) {
    return false
  }
  if (silent) {
    return true
  }

  let nextLine = startLine
  let autoClosed = false
  let nestingDepth = 0
  let fenceChar = ''
  let fenceLength = 0
  for (;;) {
    nextLine++
    if (nextLine >= endLine) {
      break
    }
    const lineStart = state.bMarks[nextLine]! + state.tShift[nextLine]!
    const lineMax = state.eMarks[nextLine]!
    if (lineStart < lineMax && state.sCount[nextLine]! < state.blkIndent) {
      break
    }
    const ch = state.src[lineStart]
    if (fenceChar) {
      if (ch === fenceChar) {
        let p = lineStart + 1
        while (p < lineMax && state.src[p] === fenceChar) p++
        if (p - lineStart >= fenceLength && state.skipSpaces(p) >= lineMax) {
          fenceChar = ''
        }
      }
      continue
    }
    if (ch === '`' || ch === '~') {
      let p = lineStart + 1
      while (p < lineMax && state.src[p] === ch) p++
      if (p - lineStart >= 3) {
        fenceChar = ch
        fenceLength = p - lineStart
        continue
      }
    }
    if (ch !== COLON) {
      continue
    }
    let p = lineStart
    while (p < lineMax && state.src[p] === COLON) p++
    if (p - lineStart !== markerCount) {
      continue
    }
    if (state.skipSpaces(p) < lineMax) {
      nestingDepth++
      continue
    }
    if (nestingDepth > 0) {
      nestingDepth--
      continue
    }
    autoClosed = true
    break
  }

  const oldParent = state.parentType
  const oldLineMax = state.lineMax
  const oldIndent = state.blkIndent
  state.parentType = 'wiki_block'
  state.lineMax = nextLine
  state.push('wiki_block_open', name, 1).map = [startLine, nextLine]
  state.blkIndent = indent
  state.md.block.tokenize(state, startLine + 1, nextLine)
  state.blkIndent = oldIndent
  state.push('wiki_block_close', name, -1).map = [startLine, nextLine]
  state.parentType = oldParent
  state.lineMax = oldLineMax
  state.line = nextLine + (autoClosed ? 1 : 0)
  return true
}

const md = new MarkdownIt({ html: true })
md.block.ruler.before('fence', 'wiki_block', wikiBlock, {
  alt: ['paragraph', 'reference', 'blockquote', 'list']
})

/** The first word of a fence's info string, as the renderer's `parseFenceInfo` reads it. */
function fenceLanguage(info: string): string {
  const trimmed = info.trim()
  const boundary = trimmed.search(/\s/)
  return md.utils.unescapeAll(boundary < 0 ? trimmed : trimmed.slice(0, boundary))
}

function closingIndex(tokens: Token[], open: number): number {
  const { level } = tokens[open]!
  for (let i = open + 1; i < tokens.length; i++) {
    if (tokens[i]!.type === 'wiki_block_close' && tokens[i]!.level === level) {
      return i
    }
  }
  return tokens.length
}

/**
 * Every whiteboard body in a markdown document, read off the same markdown-it parse the renderer
 * runs, so a fence the renderer finds -- inside a `> ` quote or a GitHub alert, in a list item --
 * is found here too, and a four-space-indented line of backticks is code, not a fence.
 *
 * A `::block-whiteboard` body is read the way the block reads it (`readWhiteboardSource`): every
 * code block inside it, joined by line breaks, whatever their language, or its text when it holds
 * none, then trimmed. A ```` ```whiteboard ```` fence outside any block is counted as well, the way
 * the server measures a `pre.codeblock-whiteboard` in a render.
 */
export function whiteboardBodiesInMarkdown(markdown: string): string[] {
  const tokens = md.parse(markdown, {})
  const bodies: string[] = []
  const read = new Set<number>()

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.type === 'wiki_block_open' && token.tag.toLowerCase() === 'block-whiteboard') {
      const fences: string[] = []
      const text: string[] = []
      const close = closingIndex(tokens, i)
      for (let j = i + 1; j < close; j++) {
        const inner = tokens[j]!
        if (inner.type === 'fence' || inner.type === 'code_block') {
          fences.push(inner.content)
          read.add(j)
        } else if (inner.type === 'inline' || inner.type === 'html_block') {
          text.push(inner.content)
        }
      }
      bodies.push((fences.length > 0 ? fences.join('\n') : text.join('\n')).trim())
    } else if (
      token.type === 'fence' &&
      !read.has(i) &&
      fenceLanguage(token.info) === 'whiteboard'
    ) {
      bodies.push(token.content.trim())
    }
  }
  return bodies
}
