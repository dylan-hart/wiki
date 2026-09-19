/**
 * The one place a 2.x source boolean column is coerced, because its representation depends on the
 * source engine: `pg` decodes a real `boolean`, but an export bundle from MySQL, MariaDB or SQLite
 * carries 2.x's knex/Objection integer `0`/`1` as a plain JSON number.
 *
 * `undefined` means "not recognized as a boolean at all", deliberately distinct from `false`, so a
 * caller can tell a present-and-false column from a missing or garbage one.
 */
export function coerceSourceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return undefined
  }
  if (typeof value === 'string') {
    switch (value.trim().toLowerCase()) {
      case '1':
      case 't':
      case 'true':
        return true
      case '0':
      case 'f':
      case 'false':
        return false
      default:
        return undefined
    }
  }
  return undefined
}
