import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { and, eq, inArray } from 'drizzle-orm'
import { parseModuleProps, unmaskSensitiveConfig } from './moduleProps.ts'
import type { ModuleProp } from './moduleProps.ts'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

/**
 * The pluggable-module boilerplate every module-backed model repeats.
 *
 * Six models discover modules the same way — `models/storage.ts`, `models/search.ts`,
 * `models/authentication.ts`, `models/commentProviders.ts`, `models/analytics.ts` and
 * `models/extensions.ts` — each scanning a `modules/<kind>/<key>/definition.yml` tree, merging and
 * validating a config against the props that definition declares, probing for a sibling
 * implementation file, loading it on first use, and (for the two that keep a row per site) keeping
 * those rows in step with what is on disk. This is that shared machinery, once.
 *
 * What deliberately stays in each model rather than moving here:
 *  - **The `try`/`catch` around a disk scan, and every log line it writes.** The six differ in
 *    wording, in severity (extensions warns and carries on, the rest error), and in what
 *    they do with the definitions they had (most reset to `[]`, authentication/analytics keep
 *    whatever a failed `readdir` left behind) — encoding all of that as options would be longer than
 *    the four lines it would save each caller.
 *  - **The dynamic `import()` specifier.** Per CLAUDE.md it is extension-sensitive and invisible to
 *    the type checker, so it stays literal at its call site; `loadModule` takes an importer closure.
 *  - **The definition ordering.** `db`-first, title-first and "leave it as read" are all in play.
 */

/** The minimum a discovered definition carries: the directory it was read from, as its key. */
export interface ModuleDefinitionRecord {
  key: string
}

/**
 * Read every `<dirPath>/<key>/definition.yml`, keyed by directory name.
 *
 * Throws rather than logging: what a failed scan means for the definitions already held, and how it
 * is reported, is the caller's decision (see the header comment above).
 *
 * @param opts.label The module kind in human words ("authentication module"). Read only by
 *   `logEach`, so a caller that does not log per module leaves it out.
 * @param opts.parseProps Normalize `props` through `parseModuleProps` (`helpers/moduleProps.ts`).
 * @param opts.sortPropsByOrder Order the parsed props by their declared `order`, so that every
 *   consumer — the admin area included — reads them in the order the module meant them to be shown.
 * @param opts.skipUnavailable Drop a definition that does not declare `isAvailable`.
 * @param opts.logEach Write a per-module debug line as each definition loads.
 * @param opts.decorate Per-model completion of the parsed record — defaults, derived flags, a probe
 *   for a sibling implementation file. Whatever it returns is what lands in the result.
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
  // -> Filtered to directories only: a loose per-module test file sitting alongside the module
  //    directories has no `definition.yml` of its own, and this loop has no per-entry try/catch
  //    -- one such file would abort the whole scan and silently lose every real module.
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const definitions: T[] = []
  for (const dir of dirs) {
    const raw = await fs.readFile(path.join(dirPath, dir, 'definition.yml'), 'utf8')
    const parsed = load(raw) as Record<string, any>
    if (opts.skipUnavailable && !parsed.isAvailable) {
      continue
    }
    // -> The directory name is the key, as it is for every other module type
    parsed.key = dir
    if (opts.parseProps) {
      const props = parseModuleProps(parsed.props ?? {})
      parsed.props = opts.sortPropsByOrder
        ? Object.fromEntries(Object.entries(props).sort(([, a], [, b]) => a.order - b.order))
        : props
    }
    definitions.push(opts.decorate ? await opts.decorate(parsed, dir) : (parsed as T))
    if (opts.logEach) {
      WIKI.logger.debug('ext', 'definition loaded', { kind: opts.label, module: dir })
    }
  }
  return definitions
}

/**
 * Merge incoming config values onto the ones already stored, keeping only what the module declares.
 *
 * Read-only props are never taken from the client: they are declarations of something the server
 * does not support changing, so the stored value (or the module default) always wins.
 */
export function mergeModuleConfig(
  props: Record<string, ModuleProp>,
  incoming: Record<string, any> = {},
  existing: Record<string, any> = {}
): Record<string, any> {
  // -> Drops a `sensitive` value that is just the mask being echoed back unchanged, so it falls
  //    through to `current` below instead of overwriting the real stored secret with the mask
  //    string itself. See `helpers/moduleProps.ts#unmaskSensitiveConfig`.
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
 * Check incoming config values against what the module declares.
 *
 * The props are a runtime declaration read from a YAML file, so no JSON Schema can cover them —
 * without this, a boolean prop would happily store the string `"maybe"`.
 *
 * @param opts.refuseUnknown Refuse a key the module does not declare instead of ignoring it. Off by
 *   default, so that a module losing a prop can never make the admin area unable to save; on for a
 *   surface that only ever sends what the module's own props currently list (the search engine
 *   picker), where an unrecognized key means the request is stale or wrong.
 * @param opts.requiredAndPattern Additionally check every `required` prop against a non-empty value
 *   and every `pattern` prop against its regular expression — over the *effective* config
 *   (`incoming` merged onto `opts.existing`, the same merge `mergeModuleConfig` does for what
 *   actually gets saved), so a value stored on an earlier request does not have to be resent on
 *   every later save just to keep validating.
 * @param opts.moduleTitle What to call the module in a message that names it.
 * @param opts.existing What is already stored, for `requiredAndPattern`'s merge.
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
      // -> Unknown keys are dropped by the merge rather than refused: a module losing a prop must
      //    not make the admin area unable to save
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
 * Whether a module has a given file sitting next to its definition — i.e. whether it has any code to
 * run, as opposed to only a `definition.yml`. The file name is the module kind's own implementation
 * entry point (`storage.ts`, `search.ts`, `comments.ts`).
 *
 * @param segments The file to probe for, as `path.join` segments — the modules directory, the module
 *   key, the file name. Joined *inside* the `try`, deliberately: a caller reaching this before
 *   `WIKI.SERVERPATH` is set (a unit test with a partial `WIKI` global, say) then answers `false` —
 *   the same thing an absent file means — instead of throwing out of a probe whose whole contract is
 *   to answer yes or no.
 */
export async function moduleHasFile(...segments: string[]): Promise<boolean> {
  try {
    await fs.access(path.join(...segments))
    return true
  } catch {
    return false
  }
}

/**
 * Ensure a module's implementation is loaded, memoising it into `cache`.
 *
 * @param importer The dynamic `import()`, as a closure: the specifier is extension-sensitive (see
 *   CLAUDE.md) and stays literal at the call site.
 * @param label The module kind, for the log lines.
 * @param isAvailable Consulted only on a cache miss, before the import — whether this module has an
 *   implementation to load at all.
 * @returns The implementation, or null when the module has none or it failed to load
 */
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
    WIKI.logger.debug('ext', 'module activated', { kind: label, module: key })
    return cache[key]
  } catch (err: any) {
    WIKI.logger.warn('ext', 'loading a module failed', { kind: label, module: key, error: err })
    return null
  }
}

/** A per-site module row table: one row per (site, module), as storage and comment providers keep. */
type SiteModuleTable = PgTable & { siteId: PgColumn; module: PgColumn }

/**
 * Give a site a row per installed module, and drop rows for modules no longer on disk.
 *
 * Existing rows are left alone: their settings belong to the site, whereas everything the
 * definition declares is read from disk on every request rather than copied into the row.
 *
 * @param rowFor The module-specific column values for a newly-inserted row; `siteId` and `module`
 *   are set from the arguments rather than by the caller.
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
  const existing = await WIKI.db
    .select({ module: table.module })
    .from(table)
    .where(eq(table.siteId, siteId))
  const existingKeys = existing.map((row) => row.module as string)
  const definedKeys = definitions.map((d) => d.key)

  for (const definition of definitions) {
    if (existingKeys.includes(definition.key)) {
      continue
    }
    // -> `as never` only because `table` is the generic per-site shape rather than one concrete
    //    table, so drizzle has no `$inferInsert` to check against here. The row itself is still
    //    fully type-checked, at the call site: each caller annotates `rowFor`'s return as
    //    `Omit<typeof <its>Table.$inferInsert, 'siteId' | 'module'>`.
    await WIKI.db
      .insert(table)
      .values({ siteId, module: definition.key, ...rowFor(definition) } as never)
  }

  // -> A module removed from disk should not linger in the admin list
  const orphaned = existingKeys.filter((key) => !definedKeys.includes(key))
  if (orphaned.length > 0) {
    await WIKI.db
      .delete(table)
      .where(and(eq(table.siteId, siteId), inArray(table.module, orphaned)))
  }
}
