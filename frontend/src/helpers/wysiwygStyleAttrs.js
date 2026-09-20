/**
 * Markdown round-trip for the WYSIWYG toolbar's colour, highlight, font-family and text-align marks,
 * spelled as `markdown-it-attrs`-style `{style="…"}` attributes -- the same curly-brace family
 * `renderers/markdown.js` and `renderers/modules/markdown-it-blocks.js`'s `wikiSpan` parse on render.
 *
 * Two shapes, because these split across two parts of a TipTap document:
 *
 * - **`color`/`fontFamily`** both live on the one shared `textStyle` mark -- the colour and
 *   font-family packages are `Extension`s adding an attribute onto it via `addGlobalAttributes`,
 *   with no `color`/`fontFamily` mark type of their own to extend. `highlight` IS its own mark. All
 *   three render as an inline `[text]{style="…"}` bracket span, which `wikiSpan` already turns into
 *   a `<span style="…">` with no allowlist of its own -- `backend/helpers/htmlSanitizePolicy.ts` is
 *   the real boundary.
 * - **`textAlign`** is a `paragraph`/`heading` node attribute, not a mark, so it serializes as a
 *   trailing `{style="text-align: …;"}` on the block's own line -- `markdown-it-attrs`'s "end of
 *   block" pattern, which is why `style` is in that plugin's `allowedAttributes` in
 *   `renderers/markdown.js`.
 *
 * The bracket-span tokenizer below claims EVERY `[text]{style="…"}` span and dispatches on which CSS
 * property is present. A construct wanting the same shape for something else extends
 * `parseStyleSpanContent` rather than registering a second tokenizer: `MarkdownManager`'s
 * inline-token dispatch consults only the first handler registered for a token name (unlike its
 * block-level "try every handler" path), so a competing tokenizer is silently dropped.
 */

const STYLE_SPAN_TOKEN_NAME = 'wysiwygStyleSpan'

const STYLE_SPAN_SUFFIX_RE = /^\{style="([^"]*)"\}/

const TRAILING_BLOCK_STYLE_RE = /[ \t]*\{style="([^"]*)"\}\s*$/

/**
 * Takes the attribute VALUE (what sits between the quotes), not the whole `style="…"` attribute.
 * Property names come back lowercased and in CSS spelling, not camelCase.
 *
 * @param {string|null|undefined} styleText
 * @returns {Record<string, string>}
 * @example
 *   parseStyleAttr('color: #D32F2F; font-family: monospace')
 *   // → { color: '#D32F2F', 'font-family': 'monospace' }
 */
export function parseStyleAttr(styleText) {
  const result = {}
  if (!styleText) {
    return result
  }
  for (const declaration of styleText.split(';')) {
    const separatorIndex = declaration.indexOf(':')
    if (separatorIndex === -1) {
      continue
    }
    const property = declaration.slice(0, separatorIndex).trim().toLowerCase()
    const value = declaration.slice(separatorIndex + 1).trim()
    if (property && value) {
      result[property] = value
    }
  }
  return result
}

/**
 * Inverse of `parseStyleAttr`: same attribute-value shape, so the pair round-trips. Dropping falsy
 * values lets a caller pass every property it knows about and have the unset ones fall away.
 *
 * @param {Record<string, string|null|undefined>} props
 * @returns {string} Empty string when nothing survives.
 */
export function serializeStyleAttr(props) {
  return Object.entries(props)
    .filter(([, value]) => Boolean(value))
    .map(([property, value]) => `${property}: ${value};`)
    .join(' ')
}

/**
 * A "don't emit unparseable markdown" guard, NOT the security boundary -- that is
 * `backend/helpers/htmlSanitizePolicy.ts`, applied when this markdown is rendered to HTML. Every
 * value the toolbar produces is a fixed hex colour or a CSS keyword, never user-typed text.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeStyleAttrValue(value) {
  return value.replace(/"/g, "'").replace(/[\r\n]+/g, ' ')
}

/**
 * Tracks `[`/`]` nesting depth so an inner mark's own bracket span (a highlighted run inside a
 * coloured one) cannot close the outer span early. Handles the `{style="…"}` shape only, not
 * `markdown-it-attrs`' `.class`/`#id` shorthand.
 *
 * @param {string} src
 * @returns {{inner: string, styleText: string, raw: string}|null} `null` unless `src` opens with a
 *   well-formed span at position 0.
 */
export function findStyleSpan(src) {
  if (src[0] !== '[') {
    return null
  }
  let index = 1
  let depth = 0
  while (index < src.length) {
    const ch = src[index]
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
  if (index >= src.length) {
    return null
  }
  const inner = src.slice(1, index)
  const suffixMatch = STYLE_SPAN_SUFFIX_RE.exec(src.slice(index + 1))
  if (!suffixMatch) {
    return null
  }
  return {
    inner,
    styleText: suffixMatch[1],
    raw: src.slice(0, index + 1 + suffixMatch[0].length)
  }
}

/**
 * Every `[text]{style="…"}` span parses here, dispatching on the CSS property present rather than on
 * registration order -- a new property is added to this function, never as a second tokenizer.
 *
 * @param {{styleText: string, tokens: any[]}} token
 * @param {import('@tiptap/core').MarkdownParseHelpers} helpers
 * @returns {{mark: string, content: any[], attrs?: object}|null} `null` when the span carries none of
 *   the handled properties, leaving it to another extension or to plain text.
 */
function parseStyleSpanContent(token, helpers) {
  const props = parseStyleAttr(token.styleText)
  const content = helpers.parseInline(token.tokens || [])
  if (props['background-color']) {
    return helpers.applyMark('highlight', content, { color: props['background-color'] })
  }
  if (props.color || props['font-family']) {
    return helpers.applyMark('textStyle', content, {
      color: props.color ?? null,
      fontFamily: props['font-family'] ?? null
    })
  }
  return null
}

/**
 * The ONLY extension that registers the shared `wysiwygStyleSpan` tokenizer; registering it a second
 * time (on `Highlight`, say) silently drops one of the two -- see this file's opening comment.
 *
 * @param {import('@tiptap/extension-text-style').TextStyle} TextStyle
 */
export function withStyleSpanMarkdown(TextStyle) {
  return TextStyle.extend({
    markdownTokenName: STYLE_SPAN_TOKEN_NAME,
    markdownTokenizer: {
      name: STYLE_SPAN_TOKEN_NAME,
      level: 'inline',
      start: (src) => src.indexOf('['),
      tokenize(src, _tokens, helpers) {
        const span = findStyleSpan(src)
        if (!span) {
          return undefined
        }
        return {
          type: STYLE_SPAN_TOKEN_NAME,
          raw: span.raw,
          styleText: span.styleText,
          tokens: helpers.inlineTokens(span.inner)
        }
      }
    },
    parseMarkdown: parseStyleSpanContent,
    renderMarkdown(node, helpers) {
      const attrs = node.attrs || {}
      const style = serializeStyleAttr({ color: attrs.color, 'font-family': attrs.fontFamily })
      if (!style) {
        // -> This occurrence carries some other `textStyle` attribute: render the content unwrapped
        //    rather than emitting an empty `[text]{style=""}`
        return helpers.renderChildren(node)
      }
      return `[${helpers.renderChildren(node)}]{style="${escapeStyleAttrValue(style)}"}`
    }
  })
}

/**
 * A coloured highlight round-trips as `[text]{style="background-color: …;"}` because the base
 * extension's own `==text==` form carries no attributes and would silently drop the colour. A
 * highlight without a `color` still goes through that base handling untouched.
 *
 * @param {import('@tiptap/extension-highlight').Highlight} Highlight
 */
export function withStyleSpanRenderMarkdown(Highlight) {
  return Highlight.extend({
    renderMarkdown(node, helpers, ctx) {
      const color = node.attrs?.color
      if (!color) {
        return this.parent(node, helpers, ctx)
      }
      const style = serializeStyleAttr({ 'background-color': color })
      return `[${helpers.renderChildren(node)}]{style="${escapeStyleAttrValue(style)}"}`
    }
  })
}

/**
 * Recovers a block's `textAlign` before its tokens reach the base node's own inline parsing, which
 * would otherwise render the `{style="…"}` as literal text.
 *
 * @param {any[]|undefined} tokens marked.js inline tokens (a paragraph/heading's `token.tokens`).
 * @returns {{tokens: any[]|undefined, style: string|null}}
 */
export function extractTrailingBlockStyle(tokens) {
  if (!tokens || tokens.length === 0) {
    return { tokens, style: null }
  }
  const last = tokens[tokens.length - 1]
  if (!last || last.type !== 'text') {
    return { tokens, style: null }
  }
  const text = last.text ?? last.raw ?? ''
  const match = TRAILING_BLOCK_STYLE_RE.exec(text)
  if (!match) {
    return { tokens, style: null }
  }
  const strippedText = text.slice(0, match.index)
  const rest = tokens.slice(0, -1)
  if (strippedText) {
    rest.push({ ...last, text: strippedText, raw: strippedText })
  }
  return { tokens: rest, style: match[1] }
}

/**
 * `left` is skipped: it is the browser's default block alignment, so emitting it would only add
 * noise to the markdown without changing how the block renders.
 *
 * @param {string} markdown Already-rendered markdown for the block (e.g. `"# Heading"`).
 * @param {string|null|undefined} textAlign
 * @returns {string}
 */
function appendTextAlignStyle(markdown, textAlign) {
  if (!textAlign || textAlign === 'left' || !markdown) {
    return markdown
  }
  const style = serializeStyleAttr({ 'text-align': textAlign })
  return `${markdown} {style="${escapeStyleAttrValue(style)}"}`
}

/**
 * Only for a node whose own `parseMarkdown`/`renderMarkdown` already handle its content, since both
 * overrides here delegate the content half to `this.parent`.
 *
 * @param {import('@tiptap/core').Node} node
 */
export function withTextAlignMarkdown(node) {
  return node.extend({
    parseMarkdown(token, helpers) {
      const { tokens, style } = extractTrailingBlockStyle(token.tokens)
      const parsed = this.parent(style ? { ...token, tokens } : token, helpers)
      if (!style || !parsed || Array.isArray(parsed)) {
        return parsed
      }
      const textAlign = parseStyleAttr(style)['text-align']
      if (textAlign) {
        parsed.attrs = { ...parsed.attrs, textAlign }
      }
      return parsed
    },
    renderMarkdown(node, helpers, ctx) {
      return appendTextAlignStyle(this.parent(node, helpers, ctx), node?.attrs?.textAlign)
    }
  })
}

/** Exported for tests, so they can assert the token name without duplicating the literal. */
export { STYLE_SPAN_TOKEN_NAME }
