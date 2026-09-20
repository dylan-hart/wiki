/**
 * The MDC markup for a block, as the editor writes it into a page. Shared rather than living in the
 * block picker, because the picker is not the only way a block gets inserted — the toolbar has a
 * shortcut for the tabset, and the "Edit Block Parameters" lens rewrites the opening line of a block
 * already in the page.
 *
 * `::block-name{prop="value"}` is what the renderer turns into `<block-name prop="value">`, the
 * element the component registers itself as.
 */

/**
 * Separate from `blockMarkdown` because editing an existing block reuses only this half: its body is
 * whatever the author has since written between the two fences, and rebuilding the whole block from
 * the definition would throw that away.
 */
export function blockAttributes(block, values = {}) {
  // -> Skip anything still on the block's own default: a block reading that default from its own
  //    code does not need to be told it in every page
  const written = (block.props ?? []).filter((prop) => {
    const value = values[prop.name]
    if (value === undefined || value === null || value === '') {
      return false
    }
    return String(value) !== String(prop.default ?? '')
  })
  // -> A double quote in a value would close the attribute; MDC has no escape for it, so it goes
  return written.map((prop) => `${prop.name}="${String(values[prop.name]).replaceAll('"', "'")}"`)
}

export function blockMarkdown(block, values = {}) {
  const attributes = blockAttributes(block, values).join(' ')
  const suffix = attributes ? `{${attributes}}` : ''

  // -> A template holding blocks of its own is fenced with three colons: against a two-colon fence
  //    the first `::` inside it would read as the end of this one
  if (block.template) {
    const fence = /^::/m.test(block.template) ? ':::' : '::'
    return `${fence}block-${block.block}${suffix}\n${block.template}\n${fence}`
  }
  return `::block-${block.block}${suffix}\n::`
}

/**
 * What a prop starts on when nothing has said otherwise: the site's configured default, set on the
 * admin Blocks page, falling back to the block's own hardcoded one.
 *
 * An empty string in `config` counts as though it were not there — the admin card leaves the field
 * blank to mean "no site-wide override", not "override with nothing".
 */
export function propDefault(block, prop) {
  const configured = block.config?.[prop.name]
  return configured !== undefined && configured !== '' ? configured : (prop.default ?? '')
}

export function blockPropsFilled(block, values) {
  return (block.props ?? [])
    .filter((prop) => prop.required)
    .every((prop) => String(values[prop.name] ?? '').length > 0)
}

/** Seeds the admin "Configure" form, the site-wide counterpart to an author's per-use props. */
export function seedConfigValues(block) {
  return Object.fromEntries(
    (block.configFields ?? []).map((field) => [
      field.name,
      (block.config ?? {})[field.name] ?? field.default ?? ''
    ])
  )
}
