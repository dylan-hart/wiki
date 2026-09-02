/**
 * The small pure helpers `authentication.ts`, `storage.ts` and `site-settings.ts` all need to read a
 * 2.x source row's loosely-typed columns. Deliberately hand-rolled rather than taken from
 * `es-toolkit`: its `isPlainObject` rejects a class instance, and a row handed back by a source
 * connector is not guaranteed to be a bare object literal — `pg`'s own row objects and a JSON-parsed
 * bundle row must both count as "a config blob to read keys off".
 */

/** A value with string keys that is worth reading columns off — anything object-shaped that is not an
 * array. Deliberately looser than `es-toolkit`'s `isPlainObject`, which refuses a class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Copies the given keys from `source` into a fresh object when the key is present **and** carries a
 * value — an explicit `undefined` is treated the same as absent. This is the variant the two
 * module-config mappers (`authentication.ts`, `storage.ts`) want: a picked key becomes a `config` prop
 * handed to `buildConfig()`, and an `undefined` there would override the module's own declared default
 * with nothing.
 */
export function pickDefined(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in source && source[key] !== undefined) {
      result[key] = source[key]
    }
  }
  return result
}

/**
 * Copies the given keys from `source` into a fresh object whenever the key is present at all — a bare
 * `in` check, not a truthiness or `undefined` check. This is the variant `site-settings.ts` wants: its
 * output is deep-merged onto 3.0's own defaults, so an explicit `false`/`0`/`''` the operator actually
 * set on the 2.x install is a real value that must survive the copy.
 */
export function pickPresent(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    if (key in source) {
      result[key] = source[key]
    }
  }
  return result
}

export type ConfigTransform = (raw: Record<string, unknown>) => Record<string, unknown>

/**
 * Applies one module's key-by-key `config` remap, or produces an empty config when the module has no
 * transform declared. A non-object source `config` (null, a stray string) is read as an empty object
 * rather than refused: whether that is worth flagging is the calling mapper's own decision, made
 * before it gets here.
 */
export function transformConfig(
  transforms: Record<string, ConfigTransform>,
  module: string,
  rawConfig: unknown
): Record<string, unknown> {
  const raw = isPlainObject(rawConfig) ? rawConfig : {}
  const transform = transforms[module]
  return transform ? transform(raw) : {}
}

/**
 * Undoes the `{ v: <value> }` wrapping 2.x's own `configSvc.saveToDb()` applies to every
 * non-plain-object column value (`server/core/config.js`, vendored under
 * `docs/migration/vendor/2x-settings/`) — the same unwrap 3.0's `Settings.getConfig()` already does.
 * A value that was never wrapped (the export-bundle path unwraps before this mapper sees a row, and
 * 2.x stores plain objects unwrapped either way) passes through unchanged.
 */
export function unwrapKnexValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'v' in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).v
  }
  return value
}
