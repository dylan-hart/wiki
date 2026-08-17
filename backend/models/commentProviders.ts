import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { and, eq, inArray } from 'drizzle-orm'
import { parseModuleProps } from '../helpers/common.ts'
import { commentProviders as commentProvidersTable, sites as sitesTable } from '../db/schema.ts'
import type { ModuleProp } from '../helpers/common.ts'

/** A comment provider module, as declared by its `definition.yml`. */
export interface CommentProviderDefinition {
  key: string
  title: string
  description: string
  icon: string
  vendor: string
  website: string
  isAvailable: boolean
  props: Record<string, ModuleProp>
}

/** A configured provider: the module definition, plus how this site has it set up. */
export interface CommentProvider {
  id: string
  module: string
  isEnabled: boolean
  title: string
  description: string
  icon: string
  vendor: string
  website: string
  isAvailable: boolean
  props: Record<string, ModuleProp>
  config: Record<string, any>
}

/**
 * Comment providers model
 *
 * Which comment provider is active for a site, and what it is configured with. One row per module
 * discovered under `modules/comments` per site (see `syncSite`), same as `models/storage.ts` does for
 * storage targets — but unlike storage, at most one row per site ever has `isEnabled` true:
 * `setActiveProvider` is the only way to flip it, and it always clears every other row for that site
 * first. There is no default: a fresh site has every provider disabled until an administrator picks
 * one, since (unlike storage) a site with comments off entirely is a perfectly normal state.
 */
class CommentProviders {
  /** Definitions read from disk, refreshed by `refreshFromDisk()`. */
  definitions: CommentProviderDefinition[] = []

  /**
   * Load the comment provider module definitions from disk.
   *
   * @param modulesPath Defaults to `modules/comments` under `WIKI.SERVERPATH`; overridable so tests
   *   can point this at a fixture directory instead of the real modules tree.
   */
  async refreshFromDisk(
    modulesPath: string = path.join(WIKI.SERVERPATH, 'modules/comments')
  ): Promise<void> {
    const definitions: CommentProviderDefinition[] = []
    try {
      for (const dir of await fs.readdir(modulesPath)) {
        const raw = await fs.readFile(path.join(modulesPath, dir, 'definition.yml'), 'utf8')
        const parsed = load(raw) as Record<string, any>
        // -> The directory name is the key, as it is for every other module type
        parsed.key = dir
        // -> Props carry a display `order`, applied once here so that every consumer — the admin
        //    area included — reads them in the order the module meant them to be shown in
        parsed.props = Object.fromEntries(
          Object.entries(parseModuleProps(parsed.props ?? {})).sort(
            ([, a], [, b]) => a.order - b.order
          )
        )
        definitions.push(parsed as CommentProviderDefinition)
      }
      this.definitions = definitions.sort((a, b) => a.title.localeCompare(b.title))
      WIKI.logger.info(`Found ${this.definitions.length} comment provider modules [ OK ]`)
    } catch (err: any) {
      this.definitions = []
      WIKI.logger.error(
        `Could not read the comment provider module definitions at ${modulesPath} [ FAILED ]`
      )
      WIKI.logger.error(err.message)
    }
  }

  /** A single definition, or null when nothing on disk declares that key. */
  getDefinition(key: string): CommentProviderDefinition | null {
    return this.definitions.find((d) => d.key === key) ?? null
  }

  /**
   * Give a site a row per installed module, and drop rows for modules no longer on disk.
   *
   * Existing rows are left alone: their settings belong to the site, whereas everything the
   * definition declares is read from disk on every request rather than copied into the row.
   */
  async syncSite(siteId: string): Promise<void> {
    const existing = await WIKI.db
      .select({ module: commentProvidersTable.module })
      .from(commentProvidersTable)
      .where(eq(commentProvidersTable.siteId, siteId))
    const existingKeys = existing.map((t) => t.module)
    const definedKeys = this.definitions.map((d) => d.key)

    for (const definition of this.definitions) {
      if (existingKeys.includes(definition.key)) {
        continue
      }
      await WIKI.db.insert(commentProvidersTable).values({
        siteId,
        module: definition.key,
        isEnabled: false,
        config: this.buildConfig(definition.key)
      })
    }

    // -> A module removed from disk should not linger in the admin list
    const orphaned = existingKeys.filter((key) => !definedKeys.includes(key))
    if (orphaned.length > 0) {
      await WIKI.db
        .delete(commentProvidersTable)
        .where(
          and(
            eq(commentProvidersTable.siteId, siteId),
            inArray(commentProvidersTable.module, orphaned)
          )
        )
    }
  }

  /** Register the installed comment provider modules for every site. Called at boot, after storage. */
  async syncAllSites(): Promise<void> {
    WIKI.logger.info('Registering comment providers for all sites...')
    const sites = await WIKI.db.select({ id: sitesTable.id }).from(sitesTable)
    for (const site of sites) {
      await WIKI.models.commentProviders.syncSite(site.id)
    }
    WIKI.logger.info(`Registered comment providers for ${sites.length} sites [ OK ]`)
  }

  /**
   * Every provider of a site, in the order the admin area lists them.
   *
   * Config values are completed from the module's declared defaults, so a prop added to a module
   * after a provider was configured is returned with its default rather than as a missing key.
   */
  async getSiteProviders(siteId: string): Promise<CommentProvider[]> {
    const rows = await WIKI.db
      .select()
      .from(commentProvidersTable)
      .where(eq(commentProvidersTable.siteId, siteId))
    const providers: CommentProvider[] = []
    // -> Driven by the definitions rather than by the rows, so that the list is ordered the same way
    //    and a module dropped on disk without a restart is simply absent instead of half-present
    for (const definition of this.definitions) {
      const row = rows.find((p) => p.module === definition.key)
      if (!row) {
        continue
      }
      providers.push({
        id: row.id,
        module: definition.key,
        isEnabled: row.isEnabled,
        title: definition.title,
        description: definition.description,
        icon: definition.icon,
        vendor: definition.vendor,
        website: definition.website,
        isAvailable: definition.isAvailable,
        props: definition.props,
        config: this.buildConfig(definition.key, {}, row.config as Record<string, any>)
      })
    }
    return providers
  }

  /** A single provider of a site by module key, or null if there is no such provider. */
  async getSiteProviderByModule(
    siteId: string,
    moduleKey: string
  ): Promise<CommentProvider | null> {
    return (await this.getSiteProviders(siteId)).find((p) => p.module === moduleKey) ?? null
  }

  /**
   * Merge incoming config values onto the ones already stored, keeping only what the module declares.
   *
   * Read-only props are never taken from the client: they are declarations of something the server
   * does not support changing, so the stored value (or the module default) always wins.
   */
  buildConfig(
    moduleKey: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): Record<string, any> {
    const props = this.getDefinition(moduleKey)?.props ?? {}
    const config: Record<string, any> = {}
    for (const [key, prop] of Object.entries(props)) {
      const current = existing[key] !== undefined ? existing[key] : prop.default
      config[key] = prop.readOnly || incoming[key] === undefined ? current : incoming[key]
    }
    return config
  }

  /**
   * Check incoming config values against what the module declares.
   *
   * The props are a runtime declaration read from a YAML file, so no JSON Schema can cover them —
   * without this, a boolean prop would happily store the string `"maybe"`.
   *
   * @returns The reason it is invalid, or null when it is fine
   */
  validateConfig(moduleKey: string, incoming: Record<string, any> = {}): string | null {
    const props = this.getDefinition(moduleKey)?.props ?? {}
    for (const [key, value] of Object.entries(incoming)) {
      const prop = props[key]
      // -> Unknown keys are dropped by buildConfig rather than refused: a module losing a prop must
      //    not make the admin area unable to save
      if (!prop || prop.readOnly || value === undefined) {
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
    return null
  }

  /**
   * Set which single provider is active for a site, and store its config values.
   *
   * Every other provider row for the site is disabled in the same statement that enables this one, so
   * the "at most one active provider" invariant holds even under a concurrent call: whichever `UPDATE`
   * commits second is the one left enabled.
   *
   * @returns The provider as stored, or null when `moduleKey` names no discovered module
   * @throws When `config` fails `validateConfig`
   */
  async setActiveProvider(
    siteId: string,
    moduleKey: string,
    config: Record<string, any> = {}
  ): Promise<CommentProvider | null> {
    const definition = this.getDefinition(moduleKey)
    if (!definition) {
      return null
    }
    const invalid = this.validateConfig(moduleKey, config)
    if (invalid) {
      throw new Error(invalid)
    }

    // -> Guarantees a row exists for every discovered module, including one just added to disk that
    //    this site has never seen before
    await this.syncSite(siteId)

    const current = await this.getSiteProviderByModule(siteId, moduleKey)
    const mergedConfig = this.buildConfig(moduleKey, config, current?.config ?? {})

    await WIKI.db.transaction(async (tx) => {
      await tx
        .update(commentProvidersTable)
        .set({ isEnabled: false })
        .where(eq(commentProvidersTable.siteId, siteId))
      await tx
        .update(commentProvidersTable)
        .set({ isEnabled: true, config: mergedConfig })
        .where(
          and(eq(commentProvidersTable.siteId, siteId), eq(commentProvidersTable.module, moduleKey))
        )
    })

    return this.getSiteProviderByModule(siteId, moduleKey)
  }
}

export const commentProviders = new CommentProviders()
