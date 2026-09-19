/**
 * Small pure helpers for reading a 2.x source row's loosely-typed columns. Deliberately hand-rolled
 * rather than taken from `es-toolkit`, whose `isPlainObject` refuses a class instance: `pg`'s own row
 * objects and a JSON-parsed bundle row must both count as "a config blob to read keys off".
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Copies the given keys when the key is present **and** carries a value — an explicit `undefined`
 * counts as absent. The module-config mappers want this variant: a picked key becomes a `config` prop
 * handed to `buildConfig()`, where an `undefined` would override the module's own declared default
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
 * Copies the given keys whenever the key is present at all — a bare `in` check, not a truthiness or
 * `undefined` check. The settings mapper wants this variant: its output is deep-merged onto 3.0's own
 * defaults, so an explicit `false`/`0`/`''` set on the 2.x install must survive the copy.
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
 * transform declared. A non-object source `config` reads as an empty object rather than being
 * refused: whether that is worth flagging is the calling mapper's decision, made before it gets here.
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
 * Undoes the `{ v: <value> }` wrapping 2.x's `configSvc.saveToDb()` applies to every non-plain-object
 * column value (`server/core/config.js`, vendored under `docs/migration/vendor/2x-settings/`). A
 * value that was never wrapped — a plain object, or an already-unwrapped export bundle row — passes
 * through unchanged.
 */
export function unwrapKnexValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'v' in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).v
  }
  return value
}
