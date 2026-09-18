/**
 * Parsing and writing the `{prop="value" flag}` attribute list on a block's opening line -- the MDC
 * syntax `renderers/modules/markdown-it-blocks.js#parseProps()` reads for the read view and
 * `helpers/blocks.js#blockAttributes()` writes for the plain-text editor's picker.
 *
 * This is a third, independent implementation of the same small grammar rather than a shared
 * import: the two existing ones are shaped for what THEY already have in scope -- a markdown-it
 * block-rule `state` walking the raw source line by line, and a `values` object already typed
 * against a block's live `props` definition -- and neither is what this Tiptap node's markdown
 * tokenizer/serializer wants, which is an ordered set of raw string/`true` pairs read and written
 * with no block definition in scope at all. The node's own markdown round-trip has to work headless
 * (e.g. the conversion job OpenProject #3400 owns runs with no site loaded to resolve one against),
 * so it never assumes a live definition is available -- only `BlockPropsForm.vue`, reached through
 * the existing `BlockPickerOverlay.vue`/`BlockParamsDialog.vue`, does the typed (boolean/number)
 * reading; this file only ever deals in strings and the bare-flag `true`.
 *
 * `.class`/`#id` shorthand is deliberately not special-cased: no block under `blocks/` writes it
 * (`blocks/definitions.test.js`'s own template check would catch one that tried to), and a `.`/`#`
 * leading character is not excluded from the key class below, so a hand-authored one round-trips as
 * an ordinary (if odd-looking) prop name rather than being lost.
 */

const PROP = /([^\s"'=}]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s}]*)))?/g

/**
 * @param {string|undefined} source The inside of the `{...}` braces, or `undefined` for none.
 * @returns {Record<string, string|true>} Values by prop name, in the order they were written. A
 *   bare flag (`hideToolbar`, no `=`) is `true` -- the same reading MDC gives it everywhere else.
 */
export function parseBlockProps(source) {
  const props = {}
  for (const match of (source ?? '').matchAll(PROP)) {
    const [, key, doubleQuoted, singleQuoted, bare] = match
    const value = doubleQuoted ?? singleQuoted ?? bare
    props[key] = value === undefined ? true : value
  }
  return props
}

/**
 * @param {Record<string, unknown>} [props]
 * @returns {string} The `{...}` braces' contents, or `''` for no props at all.
 */
export function serializeBlockProps(props = {}) {
  return Object.entries(props)
    .filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== false)
    .map(([key, value]) =>
      value === true ? key : `${key}="${String(value).replaceAll('"', "'")}"`
    )
    .join(' ')
}
