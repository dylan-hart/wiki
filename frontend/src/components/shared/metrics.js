/**
 * The measurements the `W*` library shares, so `size="sm"` and `align: 'right'` mean the same thing
 * wherever they are written.
 */

/** Quasar's named icon sizes, so `size="sm"` means what it always did. */
export const NAMED_SIZES = {
  xs: '18px',
  sm: '24px',
  md: '32px',
  lg: '38px',
  xl: '46px'
}

/**
 * A named size resolved to a length, or whatever was passed if it names none — a caller writing
 * `size="1.2em"` or `size="20px"` gets it back untouched.
 *
 * @param {string} size
 * @returns {string}
 */
export function resolveSize(size) {
  return NAMED_SIZES[size] ?? size
}

/**
 * A table column's alignment, as the column definitions write it. Logical properties, so a
 * right-to-left locale reads `left`/`right` as the start and end of the line rather than as the
 * sides of the screen.
 */
export const CELL_ALIGN = {
  left: 'text-start',
  center: 'text-center',
  right: 'text-end'
}
