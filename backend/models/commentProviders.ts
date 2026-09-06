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
 * **`read:comments` permission boundary — binding on any future embed rendering.**
 *
 * Nothing in this repo renders a `codeTemplate` provider's embed yet: there is no page-view logic
 * that drops Disqus/Commento/Artalk's `<script>` onto a page, only the native `default` provider's
 * server-rendered comments are wired up. This note exists so that whichever future change adds one
 * does not reintroduce a permission bug that would be easy to miss precisely *because*
 * Disqus/Commento/Artalk have no server-side code of their own to gate.
 *
 * The `default` provider's comments are read through `models/comments.ts` calls a route makes, and
 * any such route checks `mayOnPage(req, 'read:comments', page)` (`helpers/pageAccess.ts`) before returning
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
 * The rule that follows from it is mandatory: **whatever future code renders a `codeTemplate`
 * provider's embed must build the page URL it hands the vendor's script from the request that served
 * the page — `` `${requestOrigin(req.protocol, req.hostname)}/${page.path}` `` (`helpers/common.ts`,
 * with `page.path`'s leading slash stripped) — never by re-deriving `protocol://host` itself and
 * never from a separately stored/configured URL.** `req.protocol`/`req.hostname` are already correct
 * behind a reverse proxy and on a non-default port *as long as `security.trustProxy` is on* (see
 * `requestOrigin`'s own doc comment), so there is nothing left to get wrong once every caller goes
 * through the one formula. This model carried that formula as a `canonicalPageUrl()` one-liner until
 * it was removed for having no caller but its own test — the boundary is the rule above, not a
 * wrapper kept alive for it.
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
   * Load the comment provider module definitions from disk.
   *
   * @param modulesPath Defaults to `modules/comments` under `WIKI.SERVERPATH`; overridable so tests
   *   can point this at a fixture directory instead of the real modules tree.
   */
  async refreshFromDisk(
    modulesPath: string = path.join(WIKI.SERVERPATH, 'modules/comments')
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
      WIKI.logger.debug('ext', 'loaded module definitions', {
        kind: 'comments',
        modules: this.definitions.length
      })
    } catch (err: any) {
      this.definitions = []
      WIKI.logger.error('ext', 'reading the module definitions failed', {
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
    const sites = await WIKI.db.select({ id: sitesTable.id }).from(sitesTable)
    for (const site of sites) {
      await WIKI.models.commentProviders.syncSite(site.id)
    }
    WIKI.logger.info('ext', 'registered comment providers', { sites: sites.length })
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
    // -> A non-selectable module (no server-side implementation) must never be stored as active in the
    //    first place. There is no read-side counterpart to this: `api/comments.ts` reads the site's
    //    providers through `getSiteProviders({ mask: true })` and picks client-side, so a stored row
    //    whose module loses its implementation on disk AFTER activation surfaces as a non-selectable
    //    provider there rather than being silently swapped for `default`.
    if (!this.isSelectable(definition)) {
      throw new Error(
        `${definition.title} cannot be activated: it has no server-side implementation.`
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

    // -> Masked: this return value is what `PUT /sites/:siteId/comments/providers` sends straight
    //    back to the client as the response body (see `api/comments.ts`), unlike `current` above,
    //    whose raw config the merge just used.
    return this.getSiteProviderByModule(siteId, moduleKey, { mask: true })
  }
}

export const commentProviders = new CommentProviders()
