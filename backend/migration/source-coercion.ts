/**
 * Cross-engine boolean coercion for the 2.5.x → 3.0 migration read path (OpenProject #1845/#1850).
 *
 * `PostgresSourceConnector` hands `content-staging.ts`/`importers/users-groups.ts` a real JS
 * `boolean` for every 2.x `boolean` column, since `pg` decodes them that way. But
 * `docs/migration/decision-source-scope.md` makes the export bundle (`connectors/export-bundle.ts`)
 * the only supported path for MySQL, MariaDB and SQLite — engines where 2.x's knex/Objection layer
 * represents the same columns as integer `0`/`1`, which land in `pages.json.gz` (and friends) as
 * plain JSON numbers, not booleans. (MSSQL is unaffected: tedious decodes `BIT` to a real boolean.)
 *
 * `coerceSourceBoolean` is the one place both connector kinds' consumers coerce a source boolean
 * column, so the representations it accepts only need deciding once. `undefined` means "not
 * recognized as a boolean at all" — distinct from a real `false` — so a caller that needs to tell
 * "this column was present and false" apart from "this column was missing/garbage" still can.
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
