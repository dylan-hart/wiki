/** The named sizes the `W*` library shares, inherited from Quasar's icon scale. */
export const NAMED_SIZES = {
  xs: '18px',
  sm: '24px',
  md: '32px',
  lg: '38px',
  xl: '46px'
}

export function resolveSize(size) {
  return NAMED_SIZES[size] ?? size
}

/**
 * Logical properties, so a right-to-left locale reads a column descriptor's `left`/`right` as the
 * start and end of the line rather than as the sides of the screen.
 */
export const CELL_ALIGN = {
  left: 'text-start',
  center: 'text-center',
  right: 'text-end'
}
