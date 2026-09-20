/**
 * A third, independent implementation of the MDC `{prop="value" flag}` attribute grammar rather
 * than a shared import: the read view's markdown-it block rule walks raw source line by line, and
 * the picker's writer works from values already typed against a live block definition, while this
 * Tiptap node's round-trip has to work headless, with no definition in scope at all. So it deals
 * only in raw strings and the bare-flag `true`; the typed (boolean/number) reading is
 * `BlockPropsForm.vue`'s.
 *
 * `.class`/`#id` shorthand is deliberately not special-cased: no block under `blocks/` writes it,
 * and `.`/`#` are not excluded from the key class below, so a hand-authored one round-trips as an
 * ordinary (if odd-looking) prop name rather than being lost.
 */

const PROP = /([^\s"'=}]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s}]*)))?/g

/**
 * @param {string|undefined} source The inside of the `{...}` braces.
 * @returns {Record<string, string|true>} Values by prop name, in written order. A bare flag
 *   (`hideToolbar`, no `=`) is `true` -- the same reading MDC gives it everywhere else.
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
 * @returns {string} The `{...}` braces' contents, without the braces.
 */
export function serializeBlockProps(props = {}) {
  return Object.entries(props)
    .filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== false)
    .map(([key, value]) =>
      value === true ? key : `${key}="${String(value).replaceAll('"', "'")}"`
    )
    .join(' ')
}
