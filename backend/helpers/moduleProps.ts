import { isNil, isPlainObject } from 'es-toolkit/predicate'
import { startCase } from 'es-toolkit/string'

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
 * As declared in a module `definition.yml`: either the bare primitive type name (e.g. `String`) or
 * an object describing the prop in full.
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
  required: boolean
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

export const SENSITIVE_CONFIG_MASK = '********'

/**
 * For a config about to leave the server. A prop with nothing stored is left alone: masking it would
 * make the admin form show a password field as "already set" when it isn't.
 *
 * Never a read method's default -- a module's own implementation needs the real value to connect
 * with, so a call site serializing a config outward chooses this explicitly.
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
 * An admin form redisplaying a masked value echoes the mask straight back on the next save. Dropping
 * it before the merge, which falls back to what is stored for an absent key, means an untouched
 * password field can never overwrite the real secret with the mask string itself.
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
