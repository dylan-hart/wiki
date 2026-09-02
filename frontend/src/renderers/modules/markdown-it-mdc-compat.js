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
    return inlineSpan(state, silent)
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
