/**
 * The `::block-name{prop="value"}` container and `[text]{.class}` / `[text](url){.class}` inline
 * syntax this wiki authors. `frontend/src/helpers/blocks.js#blockMarkdown()` is the editor's own
 * writer for the block form -- the nesting convention (a longer run of colons around an inner block,
 * matched here by literal run length) is shared with it and has to stay in step.
 *
 * All three rules share `parseProps`, whose `key="value"` pairs carry no escaping, matching
 * `blockAttributes()`'s own "a `"` in a value becomes a `'`" rule.
 */

const PROP_BOUNDARY = /[\s.#}]/

/**
 * Parses a `{...}` prop list: shorthand `.class` / `#id` (repeatable; `class` values accumulate via
 * `attrJoin`), or `key`, `key=value`, `key="value"`, `key='value'`.
 *
 * @returns {{props: [string, string][], end: number}|null} `end` is the index just past the closing
 *   `}`; `null` when this is not a well-formed prop list (no matching `}`, or a quoted value never
 *   closes), and the caller then leaves the text literal.
 */
function parseProps(src, start) {
  if (src[start] !== '{') {
    return null
  }
  let i = start + 1
  const props = []
  while (i < src.length && src[i] !== '}') {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++
      continue
    }
    if (ch === '.' || ch === '#') {
      const key = ch === '.' ? 'class' : 'id'
      i++
      const valueStart = i
      while (i < src.length && !PROP_BOUNDARY.test(src[i])) i++
      if (i === valueStart) {
        return null
      }
      props.push([key, src.slice(valueStart, i)])
      continue
    }
    const keyStart = i
    while (i < src.length && src[i] !== '=' && !PROP_BOUNDARY.test(src[i])) i++
    if (i === keyStart) {
      return null
    }
    const key = src.slice(keyStart, i)
    if (src[i] === '=') {
      i++
      const quote = src[i]
      if (quote === '"' || quote === "'") {
        i++
        const valueStart = i
        while (i < src.length && src[i] !== quote) i++
        if (src[i] !== quote) {
          return null
        }
        props.push([key, src.slice(valueStart, i)])
        i++
      } else {
        const valueStart = i
        while (i < src.length && !PROP_BOUNDARY.test(src[i])) i++
        props.push([key, src.slice(valueStart, i)])
      }
    } else {
      props.push([key, 'true'])
    }
  }
  if (src[i] !== '}') {
    return null
  }
  return { props, end: i + 1 }
}

function applyProps(token, props) {
  for (const [key, value] of props) {
    if (key === 'class') {
      token.attrJoin('class', value)
    } else {
      token.attrSet(key, value)
    }
  }
}

/**
 * The opening line's own name and props, the text right after the colon markers. Whitespace between
 * the name and `{` is tolerated: the editor's own writer never emits it, but a hand-authored line
 * might.
 *
 * @returns {{name: string, props: [string, string][]}|null} `null` if `text` doesn't open with a
 *   valid block name.
 */
function parseBlockOpen(text) {
  const trimmed = text.trim()
  const nameMatch = trimmed.match(/^[a-zA-Z][\w-]*/)
  if (!nameMatch) {
    return null
  }
  const name = nameMatch[0]
  const remaining = trimmed.slice(name.length).trim()
  let props = []
  if (remaining[0] === '{') {
    const parsed = parseProps(remaining, 0)
    if (parsed) {
      props = parsed.props
    }
  }
  return { name, props }
}

const MARKER = ':'
const MIN_MARKERS = 2

/**
 * `::block-name{...}` … `::`, recursively tokenizing the body as ordinary markdown. Registered
 * `before('fence', …)` with an `alt` list, so a block can interrupt a paragraph/blockquote/list the
 * way any other block-level construct does.
 */
function wikiBlock(state, startLine, endLine, silent) {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  const indent = state.sCount[startLine]

  if (state.src[start] !== MARKER) {
    return false
  }

  let pos = start
  while (pos < max && state.src[pos] === MARKER) pos++
  const markerCount = pos - start
  if (markerCount < MIN_MARKERS) {
    return false
  }

  const markup = state.src.slice(start, pos)
  const parsed = parseBlockOpen(state.src.slice(pos, max))
  if (!parsed) {
    return false
  }

  if (silent) {
    return true
  }

  // -> Scan forward for the line closing this block: a run of exactly `markerCount` colons and
  //    nothing else. A run of a different length belongs to a nested block and is skipped untouched,
  //    getting its own turn once `block.tokenize` recurses into the body. `nestingDepth` tracks only
  //    a same-length run carrying trailing content (another opener at this depth); a bare run closes
  //    that inner opener, or this block once the depth stack is empty. A fenced code block is
  //    skipped marker-blind, so a `::` typed as text inside a fence cannot close the block.
  let nextLine = startLine
  let autoClosed = false
  let nestingDepth = 0
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0

  for (;;) {
    nextLine++
    if (nextLine >= endLine) {
      break
    }

    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine]
    const lineMax = state.eMarks[nextLine]

    if (lineStart < lineMax && state.sCount[nextLine] < state.blkIndent) {
      break
    }

    const ch = state.src[lineStart]

    if (inFence) {
      if (ch === fenceChar) {
        let p = lineStart + 1
        while (p < lineMax && state.src[p] === fenceChar) p++
        if (p - lineStart >= fenceLen && state.skipSpaces(p) >= lineMax) {
          inFence = false
        }
      }
      continue
    }

    if (ch === '`' || ch === '~') {
      let p = lineStart + 1
      while (p < lineMax && state.src[p] === ch) p++
      if (p - lineStart >= 3) {
        inFence = true
        fenceChar = ch
        fenceLen = p - lineStart
        continue
      }
    }

    if (ch !== MARKER) {
      continue
    }

    let p2 = lineStart
    while (p2 < lineMax && state.src[p2] === MARKER) p2++
    if (p2 - lineStart !== markerCount) {
      continue
    }

    if (state.skipSpaces(p2) < lineMax) {
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
  state.parentType = 'wiki_block'
  state.lineMax = nextLine

  const tokenOpen = state.push('wiki_block_open', parsed.name, 1)
  tokenOpen.markup = markup
  tokenOpen.block = true
  tokenOpen.map = [startLine, nextLine]
  applyProps(tokenOpen, parsed.props)

  const oldIndent = state.blkIndent
  state.blkIndent = indent
  state.md.block.tokenize(state, startLine + 1, nextLine)
  state.blkIndent = oldIndent

  const tokenClose = state.push('wiki_block_close', parsed.name, -1)
  tokenClose.map = [startLine, nextLine]
  tokenClose.block = true

  state.parentType = oldParent
  state.lineMax = oldLineMax
  state.line = nextLine + (autoClosed ? 1 : 0)
  return true
}

/** `[text]{.class #id}` -> `<span class="…" id="…">text</span>`, with first refusal on a `[`. */
function wikiSpan(state, silent) {
  const start = state.pos
  if (state.src[start] !== '[') {
    return false
  }
  if (state.src[start + 1] === '^') {
    // -> A footnote reference (`[^1]`) -- `markdown-it-footnote`'s own rule owns this.
    return false
  }

  let index = start + 1
  let depth = 0
  while (index < state.src.length) {
    const ch = state.src[index]
    if (ch === '\\') {
      index += 2
      continue
    }
    if (ch === '[') {
      depth++
    } else if (ch === ']') {
      if (depth === 0) {
        break
      }
      depth--
    }
    index++
  }
  if (index >= state.src.length) {
    return false
  }

  const nextChar = state.src[index + 1]
  if (nextChar === '(' || nextChar === '[') {
    // -> `[text](url)` / `[text][ref]` -- a real link or reference link. `link`/`reference` get it.
    return false
  }

  let end = index + 1
  let props = []
  if (state.src[end] === '{') {
    const parsed = parseProps(state.src, end)
    if (parsed) {
      props = parsed.props
      end = parsed.end
    }
  }

  // -> Assigned even in silent mode: `parseLinkLabel` runs every inline rule silently while scanning
  //    an outer link label, and throws if one reports a match without moving `state.pos`.
  state.pos = end
  if (silent) {
    return true
  }

  const openTok = state.push('wiki_span_open', 'span', 1)
  applyProps(openTok, props)
  const oldPos = state.pos
  const oldPosMax = state.posMax
  state.pos = start + 1
  state.posMax = index
  state.md.inline.tokenize(state)
  state.pos = oldPos
  state.posMax = oldPosMax
  state.push('wiki_span_close', 'span', -1)
  return true
}

function findMatchingLinkOpen(tokens, closeIndex) {
  let depth = 0
  for (let i = closeIndex; i >= 0; i--) {
    const token = tokens[i]
    if (token.type === 'link_close') {
      depth++
    } else if (token.type === 'link_open') {
      depth--
      if (depth === 0) {
        return token
      }
    }
  }
  return null
}

/**
 * `[text](url){.class}` / `![alt](url){.class}` -- a `{...}` landing directly on the element
 * `link`/`image` just finished, rather than opening a new span. `state.pending` empty is the
 * "directly on", with nothing buffered between them; a brace anywhere else (after plain prose, an
 * emphasis close, a heading) is left untouched for `markdown-it-attrs`'s own core rule.
 */
function wikiTrailingProps(state, silent) {
  const start = state.pos
  if (state.src[start] !== '{') {
    return false
  }
  if (state.pending) {
    return false
  }
  const last = state.tokens.at(-1)
  if (!last) {
    return false
  }
  const isLink = last.type === 'link_close'
  const isImage = last.type === 'image'
  if (!isLink && !isImage) {
    return false
  }

  const parsed = parseProps(state.src, start)
  if (!parsed) {
    return false
  }

  state.pos = parsed.end
  if (silent) {
    return true
  }

  const target = isImage ? last : findMatchingLinkOpen(state.tokens, state.tokens.length - 1)
  if (target) {
    applyProps(target, parsed.props)
  }
  return true
}

export default (md) => {
  md.block.ruler.before('fence', 'wiki_block', wikiBlock, {
    alt: ['paragraph', 'reference', 'blockquote', 'list']
  })
  md.inline.ruler.before('link', 'wiki_span', wikiSpan)
  md.inline.ruler.after('link', 'wiki_trailing_props', wikiTrailingProps)
}
