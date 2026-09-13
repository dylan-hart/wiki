/**
 * Re-derives the match `markdown-it-mdc`'s `mdc_inline_span` rule computes for a `[` at `start`:
 * a depth-tracked scan to the balancing `]` (an escaped `\[`/`\]` never counts, and a further-nested
 * `[...]` inside just deepens the count rather than ending the scan), rejecting a match immediately
 * followed by `(` or `[` (the real link / reference-link case the rule steps aside for so `link`
 * gets first refusal). Returns the position just past the matched `]`, or -1 if `start` is not the
 * head of a match at all. Copied from the upstream algorithm on purpose -- see the call site below.
 *
 * Deliberately has no length-bound check of its own, matching upstream: an unterminated `[` that
 * never finds its closing `]` simply runs the `while` loop to `index === src.length` and is treated
 * the same as a found `]` (OpenProject #3078 -- an earlier version of this function returned -1 for
 * that case, diverging from upstream and reopening the "inline rule didn't increment state.pos"
 * crash for an unterminated `[` at end-of-input).
 */
function matchSpanEnd(src, start) {
  let index = start + 1
  let depth = 0
  while (index < src.length) {
    if (src[index] === '\\') {
      index += 2
      continue
    }
    if (src[index] === '[') {
      depth += 1
    } else if (src[index] === ']') {
      if (depth === 0) {
        break
      }
      depth -= 1
    }
    index += 1
  }
  if (index === start) {
    return -1
  }
  const nextChar = src[index + 1]
  if (nextChar === '(' || nextChar === '[') {
    return -1
  }
  return index + 1
}

/**
 * The three places `markdown-it-mdc` has to be told to keep its hands off syntax this wiki already
 * spends elsewhere -- MDC's block slots, its inline span at a footnote reference, and its inline props
 * at a `markdown-it-attrs` brace. Each is explained where it is applied below.
 *
 * Registered after `mdMdc` itself, since two of the three reach for a rule MDC has to have installed
 * first.
 */
export default (md) => {
  /*
    MDC's slot syntax, off for the same reason as inline components: it takes a line the author
    meant as something else.

    Inside a block body it claims every line starting with `#` whose second character is not a
    space -- which is every markdown heading from `##` down. `::block-tabs` with a `### Step` in it
    threw `Invalid block params: # Step` out of the renderer, leaving the editor's preview frozen on
    the last good render with only a console error to say why, and a save then storing that stale
    HTML. Nothing is lost by turning it off: a slot renders as `<template #name>`, and `template` is
    not a tag a page may carry, so the server stripped every one of them anyway.
  */
  md.block.ruler.disable('mdc_block_slots')

  /*
    MDC's inline span, `[text]{.class}`, claims every `[` it meets — including the `[^1]` of a
    footnote reference, which came out as `<span>^1</span>`. The note itself then vanished too,
    since a definition nothing refers to is dropped. Rule order settles it whatever order the
    plugins are added in: the span rule is registered before `link`, the footnote rule after
    `image`, so the span always gets there first.

    Wrapped rather than turned off, because the span is worth keeping and the two are only ever
    confusable at `[^` — which is a footnote reference and nothing else. Reaching into `__rules__`
    is the only way to get hold of the original: markdown-it can replace a rule by name but has no
    way to read one back out.
  */
  const spanRule = md.inline.ruler.__rules__.find((rule) => rule.name === 'mdc_inline_span')
  const inlineSpan = spanRule.fn
  md.inline.ruler.at('mdc_inline_span', (state, silent) => {
    if (state.src[state.pos] === '[' && state.src[state.pos + 1] === '^') {
      return false
    }
    const matched = inlineSpan(state, silent)
    if (matched && silent) {
      // `markdown-it-mdc`'s own silent branch (`if (silent) return true`) never touches
      // `state.pos` -- a genuine invariant violation in the upstream package (0.2.12, its latest
      // release; reported upstream to antfu/markdown-it-mdc, whose one-line fix is to move the
      // `state.pos = index + 1` assignment before that early return). `skipToken()` -- which core's
      // `link` rule runs, via `helpers.parseLinkLabel()`, to step over whatever inline sits inside
      // an outer `[...]` link label it is still scanning -- runs every rule once in silent mode and
      // throws `"inline rule didn't increment state.pos"` the instant one reports a match without
      // moving `state.pos`. A bracket span nested inside an outer link label
      // (`[See it, noting **[CONTEXT]**, not traced](url)`) hits exactly this: the inner
      // `[CONTEXT]` matches this rule while the outer label's scan is still open and silent.
      //
      // `matchSpanEnd` below re-derives the same match the real rule already computed (the same
      // depth-tracked scan to the balancing `]`, rejecting one immediately followed by `(` or `[`,
      // which is the reference-link case the real rule steps aside for) purely to learn where
      // `state.pos` has to land -- it changes no parsing decision, only supplies the position
      // assignment the silent branch is missing.
      const end = matchSpanEnd(state.src, state.pos)
      if (end !== -1) {
        state.pos = end
      }
    }
    return matched
  })

  /*
    MDC's inline props, `{.class}`, and `markdown-it-attrs` both claim `{`, and MDC gets there first
    — it runs while the inline is being parsed, `markdown-it-attrs` in a core rule afterwards, so
    whatever MDC takes is already gone by the time the braces would have become attributes.

    That is what made `{.is-warning}` on the line under a blockquote do nothing at all: the braces
    were eaten and the class never reached the element. The same collision crashed the render
    outright — `Cannot read properties of undefined (reading 'tag')` out of MDC's own renderer —
    when the braces opened an inline, since the props it parsed then had no node to attach to. In
    the editor that reads as the preview freezing on the last good render, and a save then storing
    that stale HTML.

    The two are told apart by what comes before the brace, which is also what each one means by it:
    MDC's props decorate the thing they are stuck to (`[text]{.cls}`, `![img](…){.cls}`), while a
    brace opening a line, or standing off behind a space, is `markdown-it-attrs` addressing the
    block as a whole. So MDC keeps every brace that abuts a preceding character and lets the rest
    fall through to the core rule.
  */
  const propsRule = md.inline.ruler.__rules__.find((rule) => rule.name === 'mdc_inline_props')
  const inlineProps = propsRule.fn
  md.inline.ruler.at('mdc_inline_props', (state, silent) => {
    const preceding = state.src[state.pos - 1]
    if (preceding === undefined || /\s/.test(preceding)) {
      return false
    }
    return inlineProps(state, silent)
  })
}
