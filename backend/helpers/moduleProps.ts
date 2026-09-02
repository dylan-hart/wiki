import { isNil, isPlainObject } from 'es-toolkit/predicate'
import { startCase } from 'es-toolkit/string'

/**
 * Get default value of type
 *
 * @param type primitive type name
 * @returns Default value
 */
function getTypeDefaultValue(type: string): string | number | boolean | undefined {
  switch (type.toLowerCase()) {
    case 'string':
      return ''
    case 'number':
      return 0
    case 'boolean':
      return false
  }
}

/**
 * A single prop, as declared in a module `definition.yml`. Either the bare primitive type name
 * (e.g. `String`) or an object describing the prop in full.
 */
export type ModulePropDeclaration = ModulePropDefinition | string

export interface ModulePropDefinition {
  type: string
  default?: unknown
  title?: string
  hint?: string
  enum?: string[] | false
  enumDisplay?: string
  multiline?: boolean
  sensitive?: boolean
  readOnly?: boolean
  /** Must resolve to a non-empty value (after merging with what is already stored) to validate. */
  required?: boolean
  /** A regular expression (as a string) the value must match to validate, when non-empty. */
  pattern?: string
  icon?: string
  order?: number
  if?: unknown[]
}

/** A prop after normalization, with every field resolved to a concrete value. */
export interface ModuleProp {
  default: unknown
  type: string
  title: string
  hint: string
  enum: string[] | false
  enumDisplay: string
  multiline: boolean
  sensitive: boolean
  /** Shown but not editable — the module declares something this server cannot currently change. */
  readOnly: boolean
  /** See `ModulePropDefinition.required`. */
  required: boolean
  /** See `ModulePropDefinition.pattern`. Empty string when the module declares none. */
  pattern: string
  icon: string
  order: number
  if: unknown[]
}

export function parseModuleProps(
  props: Record<string, ModulePropDeclaration>
): Record<string, ModuleProp> {
  const result: Record<string, ModuleProp> = {}
  for (const [key, value] of Object.entries(props)) {
    const def: Partial<ModulePropDefinition> = isPlainObject(value) ? value : {}
    const type = def.type || (value as string)
    const defaultValue = !isNil(def.default) ? def.default : getTypeDefaultValue(type)
    result[key] = {
      default: defaultValue,
      type: type.toLowerCase(),
      title: def.title || startCase(key),
      hint: def.hint || '',
      enum: def.enum || false,
      enumDisplay: def.enumDisplay || 'select',
      multiline: def.multiline || false,
      sensitive: def.sensitive || false,
      readOnly: def.readOnly || false,
      required: def.required || false,
      pattern: def.pattern || '',
      icon: def.icon || 'rename',
      order: def.order || 100,
      if: def.if ?? []
    }
  }
  return result
}

/**
 * Placeholder returned in place of a module-config prop declared `sensitive: true`, once it holds a
 * real value -- mirrors `PASSWORD_MASK` in `api/mail.ts`, which predates `ModuleProp` and stores the
 * SMTP password as a single flat config rather than a per-module prop list.
 */
export const SENSITIVE_CONFIG_MASK = '********'

/**
 * Replace every `sensitive` prop's stored value with `SENSITIVE_CONFIG_MASK`, for a config about to
 * leave the server -- an admin API response, a log line, anything a caller might see. A prop with
 * nothing stored (`''`, `null`, `undefined`) is left alone: there is no secret to hide, and masking
 * it would make the admin form show a password field as "already set" when it isn't.
 *
 * Deliberately not applied inside a model's own merge (`buildConfig`/`buildEngineConfig`), nor to a
 * config handed to a module's own implementation to actually connect with -- storage's
 * `dispatch()`/`executeAction()`/`runDailyBackups()` and search's `selectEngine()`/
 * `initActiveEngines()` all need the real value to function. Call sites choose this explicitly (an
 * admin list/detail route serializing straight to JSON), never as a read method's default.
 */
export function maskSensitiveConfig(
  props: Record<string, ModuleProp>,
  config: Record<string, any>
): Record<string, any> {
  const masked: Record<string, any> = { ...config }
  for (const [key, prop] of Object.entries(props)) {
    if (prop.sensitive && typeof masked[key] === 'string' && masked[key].length > 0) {
      masked[key] = SENSITIVE_CONFIG_MASK
    }
  }
  return masked
}

/**
 * Drop a `sensitive` prop's value from `incoming` when it is exactly `SENSITIVE_CONFIG_MASK` -- an
 * admin form redisplaying a masked value it was never asked to change echoes it straight back on the
 * next save. Called on the way in, before a merge such as `buildConfig`'s own `incoming[key] ===
 * undefined ? current : incoming[key]` falls back to whatever is already stored, so a save that
 * leaves a password field untouched can never overwrite the real secret with the mask string itself.
 */
export function unmaskSensitiveConfig(
  props: Record<string, ModuleProp>,
  incoming: Record<string, any>
): Record<string, any> {
  const unmasked: Record<string, any> = { ...incoming }
  for (const [key, prop] of Object.entries(props)) {
    if (prop.sensitive && unmasked[key] === SENSITIVE_CONFIG_MASK) {
      delete unmasked[key]
    }
  }
  return unmasked
}
