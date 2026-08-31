import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { and, eq, inArray } from 'drizzle-orm'
import { parseModuleProps, requestOrigin } from '../helpers/common.ts'
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
 *
 * ---
 *
 * **Canonical URL boundary — also binding on any future embed rendering (OpenProject #831).**
 *
 * Disqus and Commento both identify a page by a canonical URL handed to their embed script
 * (`disqus_config.page.url`, Commento's `data-page-id`/current-URL detection) — get that URL wrong
 * and the widget either refuses to load ("this page isn't registered") or loads the *wrong* page's
 * thread. Two upstream reports (requarks/wiki #2549, #2784) both trace to the same cause: that URL
 * was assembled somewhere other than the request that served the page, so it could silently drift
 * from the site's real public address — behind a reverse proxy, on a non-default port, or just
 * because an admin-typed "Site URL" setting went stale.
 *
 * `canonicalPageUrl()` below is the fix, and it is mandatory: **whatever future code renders a
 * `codeTemplate` provider's embed must build the page URL it hands the vendor's script by calling
 * `canonicalPageUrl(req.protocol, req.hostname, page.path)`, never by re-deriving `protocol://host`
 * itself and never from a separately stored/configured URL.** `req.protocol`/`req.hostname` are
 * already correct behind a reverse proxy and on a non-default port *as long as `security.trustProxy`
 * is on* (see `requestOrigin`'s own doc comment in `helpers/common.ts`), so there is nothing left to
 * get wrong once every caller goes through the one formula.
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
   * `hasImplementation` alone, matching `models/storage.ts`'s equivalent gate. Reversed from an
   * earlier version that also treated `codeTemplate` as an independent grant — see the "Comment
   * provider selectability" entry in `docs/variances.md` for why: no page-view code renders a
   * `codeTemplate` provider's embed, and building that render path turned out to be materially more
   * than the one-field flip it looked like (a new public, per-page-permission-gated API to expose
   * the active provider to anonymous readers, plus vendor-specific glue for three different
   * third-party SDKs), so the fork now marks Disqus/Commento/Artalk `isAvailable: false` instead —
   * `AdminComments.vue` already renders such a row disabled — rather than advertise a provider the
   * picker cannot actually deliver comments through.
   */
  isSelectable(definition: Pick<CommentProviderDefinition, 'hasImplementation'>): boolean {
    return definition.hasImplementation
  }

  /**
   * The absolute URL of a page on this site, as it was actually reached — the value any
   * `codeTemplate` provider's embed script must be given to identify the page. See the class doc
   * comment's "Canonical URL boundary" section for why this must be the *only* way that URL is ever
   * built.
   *
   * @param protocol `req.protocol`, verbatim
   * @param hostname `req.hostname`, verbatim — already includes a non-default port, and already
   *   honors `X-Forwarded-Host` behind a reverse proxy when `security.trustProxy` is on
   * @param pagePath The page's own path, without a leading slash (as `models/pages.ts` stores it)
   */
  canonicalPageUrl(protocol: string, hostname: string, pagePath: string): string {
    const normalizedPath = pagePath.replace(/^\/+/, '')
    return `${requestOrigin(protocol, hostname)}/${normalizedPath}`
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
      // -> Filtered to directories only: a loose per-module test file sitting alongside the module
      //    directories has no `definition.yml` of its own, and this loop has no per-entry try/catch
      //    -- one such file would abort the whole scan and silently lose every real provider.
      const commentEntries = await fs.readdir(modulesPath, { withFileTypes: true })
      const commentDirs = commentEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      for (const dir of commentDirs) {
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
   * The provider actually driving comment rendering for a site (OpenProject #1962).
   *
   * `setActiveProvider` below refuses to ever *store* a non-selectable module, but that alone does
   * not make a stored `isEnabled` row permanently safe to trust: a module can lose its
   * `codeTemplate`/implementation status on disk after a site already activated it -- most plausibly
   * the parent epic here (#1950) marking Disqus/Commento/Artalk `isAvailable`/`codeTemplate` off
   * without also touching every site that had already picked one of them. Whichever branch that
   * parent takes, a site must not be left pointing at a provider the registry now refuses to select
   * -- this falls back to the `default` provider instead, so a caller rendering comments (or the
   * admin area explaining what is actually live) always gets back something that renders.
   *
   * Returns null only when the site has no `default` row to fall back to at all (a `syncSite()` that
   * has never run for this site) -- a genuinely unconfigured site, not a dead end this method can fix.
   */
  async getActiveProvider(siteId: string): Promise<CommentProvider | null> {
    const providers = await this.getSiteProviders(siteId)
    const enabled = providers.find((p) => p.isEnabled)
    if (enabled?.isSelectable) {
      return enabled
    }
    return providers.find((p) => p.module === 'default') ?? null
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
    // -> A non-selectable module (no server-side implementation, and not declared as a client-side
    //    `codeTemplate` embed) must never be stored as active in the first place -- see
    //    `getActiveProvider` above for the read-side half of this, covering a module that becomes
    //    non-selectable AFTER a site already activated it.
    if (!this.isSelectable(definition)) {
      throw new Error(
        `${definition.title} cannot be activated: it has no server-side implementation and does not declare codeTemplate.`
      )
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
