import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { maskSensitiveConfig } from '../helpers/moduleProps.ts'
import {
  mergeModuleConfig,
  moduleHasFile,
  readModuleDefinitions,
  syncSiteModuleRows,
  validateModuleConfig
} from '../helpers/moduleRegistry.ts'
import { commentProviders as commentProvidersTable, sites as sitesTable } from '../db/schema.ts'
import type { ModuleProp } from '../helpers/moduleProps.ts'

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
   * it never needs one. Mirrors `StorageDefinition.hasImplementation` in `models/storage.ts`, and — see
   * `isSelectable()` below — is now the sole gate on selectability, the same as it is there.
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
 * **`read:comments` permission boundary — how it is actually enforced (Feature #3286 / OpenProject
 * #3303).**
 *
 * The `default` provider's comments are read through `models/comments.ts` calls a route makes, and
 * any such route checks `mayOnPage(req, 'read:comments', page)` (`helpers/pageAccess.ts`) before returning
 * anything — the same page-rule boundary every other page-scoped permission in this codebase goes
 * through (`read:comments` is a **page rule** permission,
 * bound to path/locale/tags via a group's rules, not a global one — it cannot be enforced by
 * Fastify's route-level `config.permissions` hook, only by an explicit `mayOnPage`/`checkAccess` call
 * in the handler).
 *
 * A `codeTemplate` provider has no equivalent handler to put that check in — embedding its `<script>`
 * IS the render, there is no server response to withhold first, and this fork's page views are
 * client-rendered (no per-page server-rendered HTML for a `mayOnPage` call to gate the way a REST
 * route gates its JSON body). So the boundary is enforced on the frontend instead, the alternative
 * this doc comment always allowed for: `frontend/src/components/PageCommentsEmbed.vue` gates its
 * whole template on `userStore.pagePermissions.includes('read:comments')` — the same page-scoped
 * permission list `Index.vue` already reads for `write:pages`/`read:history`/etc, refreshed per route
 * by `App.vue` — so the vendor's `<script>` is never constructed or inserted into the DOM for a
 * reader who lacks it, not merely hidden with CSS after the fact. `buildSitePayload()` (`api/sites.ts`)
 * only ever exposes THAT a `codeTemplate` provider is active and its (non-sensitive) config/origin —
 * site-wide, admin-configured information, not anything about any specific page or its comments — so
 * nothing page-specific reaches a reader's browser ahead of that permission check.
 *
 * ---
 *
 * **Canonical URL boundary — how it is actually enforced (OpenProject #831, Feature #3286 / #3303).**
 *
 * Disqus and Commento both identify a page by a canonical URL handed to their embed script
 * (`disqus_config.page.url`, Commento's `data-page-id`/current-URL detection) — get that URL wrong
 * and the widget either refuses to load ("this page isn't registered") or loads the *wrong* page's
 * thread. Two upstream reports (requarks/wiki #2549, #2784) both trace to the same cause: that URL
 * was assembled somewhere other than the request that served the page, so it could silently drift
 * from the site's real public address — behind a reverse proxy, on a non-default port, or just
 * because an admin-typed "Site URL" setting went stale.
 *
 * The rule that follows from it: the page URL handed to a vendor's embed script must be built from
 * the request that served the app — `` `${requestOrigin(req.protocol, req.hostname)}/${page.path}` ``
 * (`helpers/common.ts`) — never by re-deriving `protocol://host` itself and never from a separately
 * stored/configured URL. There is no per-page server-rendered response to compute the *whole* URL
 * against in an SPA (see the permission-boundary note above), so the formula is split at the point
 * that stays true across page views: `buildSitePayload()` computes ONLY the origin half,
 * `requestOrigin(req.protocol, req.hostname)`, from the same request that serves the app shell/site
 * payload (`GET /sites/:id`, `GET /_api/bootstrap`) — `PageCommentsEmbed.vue` appends `/${page.path}`
 * client-side, which is not a `protocol://host` re-derivation, just the page identity the SPA already
 * knows from its own route. `req.protocol`/`req.hostname` are already correct behind a reverse proxy
 * and on a non-default port *as long as `security.trustProxy` is on* (see `requestOrigin`'s own doc
 * comment), so there is nothing left to get wrong once every caller goes through the one formula.
 */
class CommentProviders {
  /** Definitions read from disk, refreshed by `refreshFromDisk()`. */
  definitions: CommentProviderDefinition[] = []

  /** Whether the module has any server-side code to run, as opposed to only a definition. */
  async hasImplementation(key: string, modulesPath: string): Promise<boolean> {
    return moduleHasFile(modulesPath, key, 'comments.ts')
  }

  /**
   * Whether a provider may be listed and selected.
   *
   * `hasImplementation || codeTemplate` (Feature #3286 / OpenProject #3303, superseding #1958): a
   * provider is selectable when it has its own server-side implementation (the native `default`
   * provider's `comments.ts`), OR when it is a `codeTemplate` provider, now that a page-view render
   * path for one actually exists — `frontend/src/components/PageCommentsEmbed.vue`, mounted by
   * `Index.vue` off `siteStore.commentsProvider` (built by `buildSitePayload()` in `api/sites.ts`).
   *
   * #1958 turned this OFF for `codeTemplate` alone, deliberately, because at the time nothing
   * rendered a `codeTemplate` provider's embed at all: an earlier version (Feature 396) let a
   * provider with no server-side implementation be selected purely on the theory that a render path
   * would show up later, and none did — so Disqus/Commento/Artalk were marked `isAvailable: false`
   * instead of advertising a provider the picker could not actually deliver comments through. That
   * theory is no longer hypothetical: the render path now exists, `read:comments` boundary and
   * canonical-URL formula both enforced exactly as this file's own doc comments above require, so the
   * condition #1958 was waiting on is satisfied and this reverts to Feature 396's original formula.
   */
  isSelectable(
    definition: Pick<CommentProviderDefinition, 'hasImplementation' | 'codeTemplate'>
  ): boolean {
    return definition.hasImplementation || definition.codeTemplate
  }

  /**
   * Load the comment provider module definitions from disk.
   *
   * @param modulesPath Defaults to `modules/comments` under `CARDINAL.SERVERPATH`; overridable so tests
   *   can point this at a fixture directory instead of the real modules tree.
   */
  async refreshFromDisk(
    modulesPath: string = path.join(CARDINAL.SERVERPATH, 'modules/comments')
  ): Promise<void> {
    try {
      const definitions = await readModuleDefinitions<CommentProviderDefinition>(modulesPath, {
        parseProps: true,
        sortPropsByOrder: true,
        decorate: async (parsed, key) => {
          // -> Absent in YAML means "not a client-side embed", i.e. false — only ever `true` when the
          //    module says so explicitly
          parsed.codeTemplate = parsed.codeTemplate === true
          parsed.hasImplementation = await this.hasImplementation(key, modulesPath)
          return parsed as CommentProviderDefinition
        }
      })
      this.definitions = definitions.sort((a, b) => a.title.localeCompare(b.title))
      CARDINAL.logger.debug('ext', 'loaded module definitions', {
        kind: 'comments',
        modules: this.definitions.length
      })
    } catch (err: any) {
      this.definitions = []
      CARDINAL.logger.error('ext', 'reading the module definitions failed', {
        kind: 'comments',
        path: modulesPath,
        error: err
      })
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
    await syncSiteModuleRows(
      commentProvidersTable,
      siteId,
      this.definitions,
      (definition): Omit<typeof commentProvidersTable.$inferInsert, 'siteId' | 'module'> => ({
        isEnabled: false,
        config: this.buildConfig(definition.key)
      })
    )
  }

  /** Register the installed comment provider modules for every site. Called at boot, after storage. */
  async syncAllSites(): Promise<void> {
    const sites = await CARDINAL.db.select({ id: sitesTable.id }).from(sitesTable)
    for (const site of sites) {
      await CARDINAL.models.commentProviders.syncSite(site.id)
    }
    CARDINAL.logger.info('ext', 'registered comment providers', { sites: sites.length })
  }

  /**
   * Every provider of a site, in the order the admin area lists them.
   *
   * Config values are completed from the module's declared defaults, so a prop added to a module
   * after a provider was configured is returned with its default rather than as a missing key.
   *
   * @param opts.mask When true, a `sensitive` prop's stored value (the Akismet API key, ...) is
   *   replaced with a mask before being returned -- see `helpers/moduleProps.ts#maskSensitiveConfig`.
   *   Defaults to false: `setActiveProvider()`'s own merge reads through this method too, and needs
   *   the real values to preserve an untouched secret correctly. Only an admin-facing read that
   *   serializes `config` straight into an HTTP response should pass `{ mask: true }`.
   */
  async getSiteProviders(
    siteId: string,
    { mask = false }: { mask?: boolean } = {}
  ): Promise<CommentProvider[]> {
    const rows = await CARDINAL.db
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
      const config = this.buildConfig(definition.key, {}, row.config as Record<string, any>)
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
        config: mask ? maskSensitiveConfig(definition.props, config) : config,
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
    moduleKey: string,
    opts?: { mask?: boolean }
  ): Promise<CommentProvider | null> {
    return (await this.getSiteProviders(siteId, opts)).find((p) => p.module === moduleKey) ?? null
  }

  /**
   * The site's active provider, or null when none is (a fresh site, or one where comments are on but
   * no provider has ever been activated). Distinct from `getSiteProviders()`/`getSiteProviderByModule()`,
   * which serve the admin area's full list of every discovered module — this is the one answer a page
   * view actually needs, and what `buildSitePayload()` (`api/sites.ts`) calls to decide whether the
   * site payload's `commentsProvider` field is set. Always masked: this can reach an anonymous
   * reader's browser (via that public site payload), same as `setActiveProvider()`'s own return value.
   */
  async getActiveProvider(siteId: string): Promise<CommentProvider | null> {
    const providers = await this.getSiteProviders(siteId, { mask: true })
    return providers.find((p) => p.isEnabled) ?? null
  }

  /**
   * Merge incoming config values onto the ones already stored, keeping only what the module declares
   * — see `helpers/moduleRegistry.ts#mergeModuleConfig`.
   */
  buildConfig(
    moduleKey: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): Record<string, any> {
    return mergeModuleConfig(this.getDefinition(moduleKey)?.props ?? {}, incoming, existing)
  }

  /**
   * Check incoming config values against what the module declares — see
   * `helpers/moduleRegistry.ts#validateModuleConfig`. An unknown key is dropped by `buildConfig`
   * rather than refused here, so a module losing a prop can never make the admin area unable to save.
   *
   * @returns The reason it is invalid, or null when it is fine
   */
  validateConfig(moduleKey: string, incoming: Record<string, any> = {}): string | null {
    return validateModuleConfig(this.getDefinition(moduleKey)?.props ?? {}, incoming)
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
    // -> A non-selectable module (no server-side implementation, and not a codeTemplate provider
    //    either) must never be stored as active in the first place. There is no read-side counterpart
    //    to this: `buildSitePayload()`/`api/comments.ts` read the site's providers through
    //    `getSiteProviders({ mask: true })` and pick client-side, so a stored row whose module loses
    //    both `hasImplementation` and `codeTemplate` on disk AFTER activation surfaces as a
    //    non-selectable provider there rather than being silently swapped for `default`.
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

    await CARDINAL.db.transaction(async (tx) => {
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

    // -> Masked: this return value is what `PUT /sites/:siteId/comments/providers` sends straight
    //    back to the client as the response body (see `api/comments.ts`), unlike `current` above,
    //    whose raw config the merge just used.
    return this.getSiteProviderByModule(siteId, moduleKey, { mask: true })
  }
}

export const commentProviders = new CommentProviders()
