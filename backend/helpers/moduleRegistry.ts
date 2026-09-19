import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { and, eq, inArray } from 'drizzle-orm'
import { parseModuleProps, unmaskSensitiveConfig } from './moduleProps.ts'
import type { ModuleProp } from './moduleProps.ts'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

/**
 * The discovery/config/load boilerplate every module-backed model shares.
 *
 * What deliberately stays in each model rather than moving here:
 *  - **The `try`/`catch` around a disk scan, and every log line it writes.** The models differ in
 *    wording, in severity, and in what they do with the definitions they had — encoding all of that
 *    as options would be longer than the lines it would save each caller.
 *  - **The dynamic `import()` specifier.** It is extension-sensitive and invisible to
 *    the type checker, so it stays literal at its call site; `loadModule` takes an importer closure.
 *  - **The definition ordering**, which differs per model.
 */

/** `key` is the directory the definition was read from. */
export interface ModuleDefinitionRecord {
  key: string
}

/**
 * Throws rather than logging: what a failed scan means for the definitions already held, and how it
 * is reported, is the caller's decision.
 */
export async function readModuleDefinitions<T extends ModuleDefinitionRecord>(
  dirPath: string,
  opts: {
    label?: string
    parseProps?: boolean
    sortPropsByOrder?: boolean
    skipUnavailable?: boolean
    logEach?: boolean
    decorate?: (definition: Record<string, any>, key: string) => T | Promise<T>
  } = {}
): Promise<T[]> {
  // -> Directories only: a loose file alongside the module directories has no `definition.yml`, and
  //    with no per-entry try/catch it would abort the whole scan and lose every real module.
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const definitions: T[] = []
  for (const dir of dirs) {
    const raw = await fs.readFile(path.join(dirPath, dir, 'definition.yml'), 'utf8')
    const parsed = load(raw) as Record<string, any>
    if (opts.skipUnavailable && !parsed.isAvailable) {
      continue
    }
    parsed.key = dir
    if (opts.parseProps) {
      const props = parseModuleProps(parsed.props ?? {})
      parsed.props = opts.sortPropsByOrder
        ? Object.fromEntries(Object.entries(props).sort(([, a], [, b]) => a.order - b.order))
        : props
    }
    definitions.push(opts.decorate ? await opts.decorate(parsed, dir) : (parsed as T))
    if (opts.logEach) {
      CARDINAL.logger.debug('ext', 'definition loaded', { kind: opts.label, module: dir })
    }
  }
  return definitions
}

/**
 * Keeps only what the module declares. Read-only props are never taken from the client: the stored
 * value (or the module default) always wins.
 */
export function mergeModuleConfig(
  props: Record<string, ModuleProp>,
  incoming: Record<string, any> = {},
  existing: Record<string, any> = {}
): Record<string, any> {
  const cleanedIncoming = unmaskSensitiveConfig(props, incoming)
  const config: Record<string, any> = {}
  for (const [key, prop] of Object.entries(props)) {
    const current = existing[key] !== undefined ? existing[key] : prop.default
    config[key] =
      prop.readOnly || cleanedIncoming[key] === undefined ? current : cleanedIncoming[key]
  }
  return config
}

/**
 * The props are a runtime declaration read from a YAML file, so no JSON Schema can cover them —
 * without this, a boolean prop would happily store the string `"maybe"`.
 *
 * @param opts.refuseUnknown Off by default, so that a module losing a prop can never make the admin
 *   area unable to save; on for a surface that only ever sends what the module's own props
 *   currently list, where an unrecognized key means the request is stale or wrong.
 * @param opts.requiredAndPattern Checks `required` and `pattern` over the *effective* config
 *   (`incoming` merged onto `opts.existing`), so a value stored on an earlier request does not have
 *   to be resent on every later save just to keep validating.
 * @returns The reason it is invalid, or null when it is fine
 */
export function validateModuleConfig(
  props: Record<string, ModuleProp>,
  incoming: Record<string, any> = {},
  opts: {
    refuseUnknown?: boolean
    requiredAndPattern?: boolean
    moduleTitle?: string
    existing?: Record<string, any>
  } = {}
): string | null {
  for (const [key, value] of Object.entries(incoming)) {
    const prop = props[key]
    if (!prop) {
      if (opts.refuseUnknown) {
        return `"${key}" is not a config value ${opts.moduleTitle} accepts.`
      }
      continue
    }
    if (prop.readOnly || value === undefined) {
      continue
    }
    if (prop.enum) {
      // -> Enum entries are declared as `value` or `value|label`
      const allowed = prop.enum.map((entry) => entry.split('|')[0])
      if (!allowed.includes(`${value}`)) {
        return `"${value}" is not a valid value for ${prop.title}.`
      }
      continue
    }
    switch (prop.type) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          return `${prop.title} must be true or false.`
        }
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return `${prop.title} must be a number.`
        }
        break
      default:
        if (typeof value !== 'string') {
          return `${prop.title} must be a string.`
        }
    }
  }

  if (!opts.requiredAndPattern) {
    return null
  }
  const effective = mergeModuleConfig(props, incoming, opts.existing ?? {})
  for (const [key, prop] of Object.entries(props)) {
    const value = effective[key]
    if (prop.required && (value === undefined || value === null || value === '')) {
      return `${prop.title} is required for ${opts.moduleTitle}.`
    }
    if (
      prop.pattern &&
      typeof value === 'string' &&
      value !== '' &&
      !new RegExp(prop.pattern).test(value)
    ) {
      return `${prop.title} is not valid for ${opts.moduleTitle}.`
    }
  }
  return null
}

/**
 * @param segments Joined *inside* the `try`, deliberately: a caller reaching this before
 *   `CARDINAL.SERVERPATH` is set (a unit test with a partial `CARDINAL` global, say) then answers
 *   `false` instead of throwing out of a yes/no probe.
 */
export async function moduleHasFile(...segments: string[]): Promise<boolean> {
  try {
    await fs.access(path.join(...segments))
    return true
  } catch {
    return false
  }
}

/** @returns The implementation, or null when the module has none or it failed to load */
export async function loadModule<M>(
  cache: Record<string, M>,
  key: string,
  importer: () => Promise<{ default: M }>,
  label: string,
  isAvailable?: () => boolean | Promise<boolean>
): Promise<M | null> {
  if (cache[key]) {
    return cache[key]
  }
  if (isAvailable && !(await isAvailable())) {
    return null
  }
  try {
    cache[key] = (await importer()).default
    CARDINAL.logger.debug('ext', 'module activated', { kind: label, module: key })
    return cache[key]
  } catch (err: any) {
    CARDINAL.logger.warn('ext', 'loading a module failed', { kind: label, module: key, error: err })
    return null
  }
}

type SiteModuleTable = PgTable & { siteId: PgColumn; module: PgColumn }

/**
 * Existing rows are left alone: their settings belong to the site, whereas everything the
 * definition declares is read from disk rather than copied into the row.
 */
export async function syncSiteModuleRows<
  D extends ModuleDefinitionRecord,
  R extends Record<string, unknown>
>(
  table: SiteModuleTable,
  siteId: string,
  definitions: D[],
  rowFor: (definition: D) => R
): Promise<void> {
  const existing = await CARDINAL.db
    .select({ module: table.module })
    .from(table)
    .where(eq(table.siteId, siteId))
  const existingKeys = existing.map((row) => row.module as string)
  const definedKeys = definitions.map((d) => d.key)

  for (const definition of definitions) {
    if (existingKeys.includes(definition.key)) {
      continue
    }
    // -> `as never` only because `table` is the generic per-site shape, so drizzle has no
    //    `$inferInsert` to check against. The row is still type-checked at each call site, which
    //    types `rowFor`'s return as `Omit<typeof <its>Table.$inferInsert, 'siteId' | 'module'>`.
    await CARDINAL.db
      .insert(table)
      .values({ siteId, module: definition.key, ...rowFor(definition) } as never)
  }

  // -> A module removed from disk should not linger in the admin list
  const orphaned = existingKeys.filter((key) => !definedKeys.includes(key))
  if (orphaned.length > 0) {
    await CARDINAL.db
      .delete(table)
      .where(and(eq(table.siteId, siteId), inArray(table.module, orphaned)))
  }
}
