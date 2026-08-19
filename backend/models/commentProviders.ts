import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { and, eq, inArray } from 'drizzle-orm'
import { parseModuleProps } from '../helpers/common.ts'
import { commentProviders as commentProvidersTable, sites as sitesTable } from '../db/schema.ts'
import type { ModuleProp } from '../helpers/common.ts'

/**
 * A comment provider module, as declared by its `definition.yml`.
 *
 * `icon`/`vendor` (the native `default` provider's own fields) and `author`/`logo` (used by every
 * external provider — Disqus, Commento, Artalk) are both optional rather than unified into one shape:
 * the two kinds of provider were scaffolded from different sources (2.5.x's native module vs. its
 * external ones) and forcing them onto a single required field each would mean inventing a value
 * neither `definition.yml` actually declares.
 */
export interface CommentProviderDefinition {
  key: string
  title: string
  description: string
  icon?: string
  vendor?: string
  author?: string
  logo?: string
  website: string
  isAvailable: boolean
  props: Record<string, ModuleProp>
  /**
   * Whether this provider embeds a vendor's own client-side script/widget (Disqus, Commento, Artalk)
   * rather than being rendered and moderated server-side by this wiki. Read straight off
   * `definition.yml`; defaults to `false` when absent, matching the `default` provider, which has real
   * server-side render/spam/rate-limit logic and so declares no `codeTemplate` at all.
   */
  codeTemplate: boolean
  /**
   * Whether a `comments.ts` sits next to the definition, i.e. whether this provider has server-side
   * code behind it. Only the `default` provider does today — every external provider is pure
   * client-side configuration (a shortname/instance URL passed to the vendor's own embed script), so
   * it never needs one. Mirrors `StorageDefinition.hasImplementation` in `models/storage.ts`, but see
   * `isSelectable()` below for why a comment provider cannot be gated on this field alone the way a
   * storage target currently is.
   */
  hasImplementation: boolean
}

/** A configured provider: the module definition, plus how this site has it set up. */
export interface CommentProvider {
  id: string
  module: string
  isEnabled: boolean
  title: string
  description: string
  icon?: string
  vendor?: string
  author?: string
  logo?: string
  website: string
  isAvailable: boolean
  props: Record<string, ModuleProp>
  config: Record<string, any>
  codeTemplate: boolean
  hasImplementation: boolean
  isSelectable: boolean
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
 *
 * ---
 *
 * **`read:comments` permission boundary — binding on any future embed rendering.**
 *
 * Nothing in this repo renders a `codeTemplate` provider's embed yet: there is no page-view logic
 * that drops Disqus/Commento/Artalk's `<script>` onto a page, only the native `default` provider's
 * server-rendered comments are wired up. This note exists so that whichever future change adds one
 * does not reintroduce a permission bug that would be easy to miss precisely *because*
 * Disqus/Commento/Artalk have no server-side code of their own to gate.
 *
 * The `default` provider's comments are read through `models/comments.ts` calls a route makes, and
 * any such route checks `mayOnPage(req, 'read:comments', page)` (`api/pages.ts`) before returning
 * anything — the same page-rule boundary every other page-scoped permission in this codebase goes
 * through (see CLAUDE.md's "Permissions" section: `read:comments` is a **page rule** permission,
 * bound to path/locale/tags via a group's rules, not a global one — it cannot be enforced by
 * Fastify's route-level `config.permissions` hook, only by an explicit `mayOnPage`/`checkAccess` call
 * in the handler).
 *
 * A `codeTemplate` provider has no equivalent handler to put that check in — embedding its `<script>`
 * IS the render, there is no server response to withhold first. That makes it easy to wire up a page
 * view that drops the vendor's embed tag onto the page unconditionally, reachable by anyone who can
 * load the page's HTML at all. Doing that would leak more than the comments: Disqus/Commento/Artalk
 * are third-party services, and initializing their embed tells that third party the page exists (its
 * URL/shortname, at minimum, before the visitor supplies any credential of their own) — for a reader
 * who lacks `read:comments` on that specific page, that is a leak the native provider's own
 * `mayOnPage` check exists precisely to prevent. So: **whatever future code renders a `codeTemplate`
 * provider's embed on a page view must call `mayOnPage(req, 'read:comments', page)` (or the
 * equivalent frontend-side `userStore.pagePermissions` check described in CLAUDE.md) and skip
 * emitting the embed script entirely when it is false** — not merely hide the resulting widget with
 * CSS, which would still have let the third-party script load and phone home first.
 */
class CommentProviders {
  /** Definitions read from disk, refreshed by `refreshFromDisk()`. */
  definitions: CommentProviderDefinition[] = []

  /** Whether the module has any server-side code to run, as opposed to only a definition. */
  async hasImplementation(key: string, modulesPath: string): Promise<boolean> {
    try {
      await fs.access(path.join(modulesPath, key, 'comments.ts'))
      return true
    } catch {
      return false
    }
  }

  /**
   * Whether a provider may be listed and selected.
   *
   * Deliberately **not** `hasImplementation` alone: `models/storage.ts` gates a storage target's
   * actions on that field, which happens to be harmless there only because no storage module has
   * shipped an implementation yet, so every target is equally unavailable. A comment provider is a
   * different shape entirely — Disqus, Commento and Artalk are pure client-side embeds (a shortname
   * or instance URL handed to the vendor's own script) and were never going to get a `comments.ts`,
   * so gating on `hasImplementation` the same way would mark them permanently unselectable instead of
   * temporarily unavailable. `codeTemplate` is the independent signal that a provider needs no
   * server-side implementation to be usable.
   */
  isSelectable(
    definition: Pick<CommentProviderDefinition, 'hasImplementation' | 'codeTemplate'>
  ): boolean {
    return definition.hasImplementation || definition.codeTemplate
  }

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
        // -> Absent in YAML means "not a client-side embed", i.e. false — only ever `true` when the
        //    module says so explicitly
        parsed.codeTemplate = parsed.codeTemplate === true
        parsed.hasImplementation = await this.hasImplementation(dir, modulesPath)
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
        author: definition.author,
        logo: definition.logo,
        website: definition.website,
        isAvailable: definition.isAvailable,
        props: definition.props,
        config: this.buildConfig(definition.key, {}, row.config as Record<string, any>),
        codeTemplate: definition.codeTemplate,
        hasImplementation: definition.hasImplementation,
        isSelectable: this.isSelectable(definition)
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
