/**
 * Markdown round-trip for the WYSIWYG toolbar's text-colour, highlight-colour, font-family and
 * text-align marks (OpenProject #3398) -- spelled as `markdown-it-attrs`-style `{style="…"}`
 * attributes, the same curly-brace syntax family `renderers/markdown.js`'s `mdAttrs` and
 * `renderers/modules/markdown-it-blocks.js`'s `wikiSpan` already parse on render.
 *
 * Two distinct shapes, because the marks in scope split across two different parts of a TipTap
 * document:
 *
 * - **`color`/`fontFamily`** (the "Text Color"/"Font Family" toolbar dropdowns) both live on the
 *   one shared `textStyle` mark -- `@tiptap/extension-color` and `@tiptap/extension-font-family`
 *   are `Extension`s that add their own attribute onto `textStyle` via `addGlobalAttributes`,
 *   there is no separate `color`/`fontFamily` mark type to extend. `highlight`'s own `color`
 *   attribute (background colour) is a real, separate mark. All three render as an inline
 *   `[text]{style="…"}` bracket span -- `wikiSpan` already turns that into
 *   `<span style="…">text</span>` with no allowlist of its own (the sanitizer is the real
 *   boundary, see `backend/helpers/htmlSanitizePolicy.ts`), so no render-side plugin change was
 *   needed for this shape.
 * - **`textAlign`** (the alignment button group) is a `paragraph`/`heading` node attribute, not a
 *   mark -- `@tiptap/extension-text-align` adds it the same `addGlobalAttributes` way, but onto
 *   those node types. It serializes as a trailing `{style="text-align: …;"}` on the block's own
 *   markdown line, which is real `markdown-it-attrs` territory (see the "end of block" pattern in
 *   `markdown-it-attrs/patterns.js`) -- `style` was added to that plugin's `allowedAttributes` in
 *   `renderers/markdown.js` for exactly this.
 *
 * Scope boundary: the bracket-span tokenizer below claims every `[text]{style="…"}` span in the
 * WYSIWYG editor's own markdown parse and dispatches purely on which CSS property is present
 * (`color`/`font-family` -> `textStyle`, `background-color` -> `highlight`). A future construct
 * that wants the same `[text]{style="…"}` shape for something else needs to extend
 * `parseStyleSpanContent` below rather than registering a second marked tokenizer for it --
 * `MarkdownManager`'s inline-token dispatch (`parseInlineTokens` -> `getHandlerForToken`) only
 * ever consults the *first* registered handler for a given token name, unlike the block-level
 * "try every handler until one succeeds" path, so two competing tokenizers for the same bracket
 * shape would silently drop whichever one loses the race.
 */

/** The one marked.js inline token name every `[text]{style="…"}` span parses to. */
const STYLE_SPAN_TOKEN_NAME = 'wysiwygStyleSpan'

/** Matches the bracket span's trailing `{style="…"}`, right after its closing `]`. */
const STYLE_SPAN_SUFFIX_RE = /^\{style="([^"]*)"\}/

/** A block's own trailing `{style="…"}`, with optional leading whitespace, at the very end. */
const TRAILING_BLOCK_STYLE_RE = /[ \t]*\{style="([^"]*)"\}\s*$/

/**
 * Parses a `style="…"` attribute VALUE (the part between the quotes, e.g.
 * `color: #D32F2F; font-family: monospace;`) into a plain `{ property: value }` object.
 * Tolerant of a missing trailing `;`, extra whitespace, and an empty string.
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
 * Serializes a `{ property: value }` object into a `style="…"` attribute VALUE, in the order the
 * properties are given, dropping any falsy value. Mirrors `parseStyleAttr`'s shape exactly so
 * `parseStyleAttr(serializeStyleAttr(props))` round-trips.
 *
 * @param {Record<string, string|null|undefined>} props
 * @returns {string} Empty string when nothing survives.
 * @example
 *   serializeStyleAttr({ color: '#D32F2F', 'font-family': null })
 *   // → 'color: #D32F2F;'
 */
export function serializeStyleAttr(props) {
  return Object.entries(props)
    .filter(([, value]) => Boolean(value))
    .map(([property, value]) => `${property}: ${value};`)
    .join(' ')
}

/**
 * Defensive escaping for a style value embedded inside `{style="…"}` in markdown source. Every
 * value this WP's toolbar ever produces is a fixed hex colour or a bare CSS keyword (never
 * user-typed free text), so this is a "don't emit unparseable markdown" guard rather than the
 * actual security boundary -- that's `backend/helpers/htmlSanitizePolicy.ts`'s sanitizer, applied
 * once this markdown is rendered to HTML.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeStyleAttrValue(value) {
  return value.replace(/"/g, "'").replace(/[\r\n]+/g, ' ')
}

/**
 * Scans `src` (starting at index 0) for a `[…]{style="…"}` bracket span, tracking `[`/`]` nesting
 * depth so an inner mark's own bracket span (e.g. a highlighted run inside a coloured one) doesn't
 * prematurely close the outer span. Mirrors `renderers/modules/markdown-it-blocks.js`'s `wikiSpan`
 * scan, trimmed to the one `{style="…"}` shape this module cares about (no `.class`/`#id`
 * shorthand -- out of scope here).
 *
 * @param {string} src
 * @returns {{inner: string, styleText: string, raw: string}|null} `null` when `src` doesn't open
 *   with a well-formed span at position 0.
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
 * The one consolidated parse for every `[text]{style="…"}` span (see this module's own doc
 * comment for why it must stay one function). Dispatches on which CSS property the span carries,
 * not on any registration order.
 *
 * @param {{styleText: string, tokens: any[]}} token
 * @param {import('@tiptap/core').MarkdownParseHelpers} helpers
 * @returns {{mark: string, content: any[], attrs?: object}|null} `null` when the span carries
 *   none of the properties this WP handles (left for some other extension/plain text).
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
 * `@tiptap/extension-text-style`'s `TextStyle` mark, extended to round-trip through markdown as
 * `[text]{style="…"}`. The ONLY extension in this editor that registers the shared
 * `wysiwygStyleSpan` marked tokenizer -- see this module's doc comment for why registering it a
 * second time (e.g. on `Highlight` too) would be wrong, not merely redundant.
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
        // -> No colour/font-family on this occurrence of the mark (some other `textStyle` attr a
        //    future extension adds, out of this WP's scope) -- render the content unwrapped rather
        //    than emitting an empty `[text]{style=""}`.
        return helpers.renderChildren(node)
      }
      return `[${helpers.renderChildren(node)}]{style="${escapeStyleAttrValue(style)}"}`
    }
  })
}

/**
 * `@tiptap/extension-highlight`'s `Highlight` mark, extended so a multicolor occurrence (`color`
 * attr set) round-trips its colour as `[text]{style="background-color: …;"}` instead of silently
 * dropping it into a plain `==text==` (the base extension's own markdown form, which carries no
 * attributes). A highlight with no `color` -- typed via the `==text==` input/paste rule, or
 * applied by a non-multicolor `Highlight` configuration -- still renders and parses through the
 * base extension's own `==text==` handling, left untouched here.
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
 * Strips a trailing `{style="…"}` off the LAST token of an inline token array, if that last token
 * is plain text ending with one. Used by `withTextAlignMarkdown` to recover a paragraph/heading's
 * `textAlign` attribute before handing the (now-clean) tokens to the base node's own inline
 * parsing.
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
 * Appends a block's own `textAlign` as a trailing `{style="text-align: …;"}`, unless it is
 * missing or `left` -- `left` is the browser's own default block alignment, so omitting it keeps
 * markdown output clean without changing how the block actually renders.
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
 * Extends a `paragraph`/`heading`-shaped node (i.e. one whose `parseMarkdown`/`renderMarkdown`
 * already handle its own content, keyed on `this.parent` -- see `@tiptap/extension-paragraph` and
 * `@tiptap/extension-heading`) with `@tiptap/extension-text-align`'s `textAlign` attribute
 * round-tripping through a trailing `{style="text-align: …;"}` on the block's own markdown line.
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

/**
 * Re-exported so a test can assert against the exact token name without duplicating the literal.
 */
export { STYLE_SPAN_TOKEN_NAME }
