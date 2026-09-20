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
 * A comment provider module, as declared by its `definition.yml`. `icon`/`vendor` (native) and
 * `author`/`logo` (external) are all optional rather than unified into one shape: the two kinds of
 * provider declare different subsets, so requiring either pair would mean inventing a value no
 * `definition.yml` carries.
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
   * Whether this provider embeds a vendor's own client-side script rather than being rendered and
   * moderated server-side by this wiki. Absent in `definition.yml` means false.
   */
  codeTemplate: boolean
  /**
   * Whether a `comments.ts` sits next to the definition, i.e. whether the provider has any
   * server-side code behind it -- an external provider is pure client-side configuration and has
   * none.
   */
  hasImplementation: boolean
}

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
 * Which comment provider is active for a site, and what it is configured with: one row per module
 * discovered under `modules/comments`, per site. At most one row per site ever has `isEnabled` true
 * -- `setActiveProvider` is the only way to flip it, and it clears every other row for that site
 * first. There is no default, since a site with comments off entirely is a normal state.
 *
 * **Where `read:comments` is enforced.** It is a page-rule permission, so no route-level
 * `config.permissions` can carry it: a route serving the `default` provider's comments calls
 * `mayOnPage(req, 'read:comments', page)` itself. A `codeTemplate` provider has no such handler --
 * embedding the vendor's `<script>` IS the render, and page views are client-rendered, so there is
 * no server response to withhold first. The gate is therefore `PageCommentsEmbed.vue`, which never
 * constructs or inserts the script for a reader whose `pagePermissions` lack `read:comments` rather
 * than hiding it after the fact. `buildSitePayload()` exposes only THAT a provider is active plus
 * its non-sensitive config -- site-wide admin settings, nothing page-specific.
 *
 * **The canonical URL handed to an embed script is built from the request that served the app.**
 * Disqus and Commento each identify a thread by that URL, and a wrong one either refuses to load or
 * loads another page's thread; upstream requarks/wiki #2549 and #2784 both trace to a URL assembled
 * away from the serving request, drifting behind a reverse proxy, on a non-default port, or from a
 * stale admin-typed site URL. An SPA has no per-page server response to compute the whole URL
 * against, so it is split at the point that stays true across page views: `buildSitePayload()`
 * computes the origin alone through `requestOrigin(req.protocol, req.hostname)` and
 * `PageCommentsEmbed.vue` appends the page path its own route already knows. Never re-derive
 * `protocol://host`, and never take it from separately stored configuration.
 */
class CommentProviders {
  definitions: CommentProviderDefinition[] = []

  async hasImplementation(key: string, modulesPath: string): Promise<boolean> {
    return moduleHasFile(modulesPath, key, 'comments.ts')
  }

  /**
   * Whether a provider may be listed and selected: it either renders server-side or embeds a
   * vendor's script through `PageCommentsEmbed.vue`. A provider with neither would be advertised in
   * the picker while having no way to deliver comments at all.
   */
  isSelectable(
    definition: Pick<CommentProviderDefinition, 'hasImplementation' | 'codeTemplate'>
  ): boolean {
    return definition.hasImplementation || definition.codeTemplate
  }

  /** `modulesPath` is overridable so a test can point this at a fixture tree. */
  async refreshFromDisk(
    modulesPath: string = path.join(CARDINAL.SERVERPATH, 'modules/comments')
  ): Promise<void> {
    try {
      const definitions = await readModuleDefinitions<CommentProviderDefinition>(modulesPath, {
        parseProps: true,
        sortPropsByOrder: true,
        decorate: async (parsed, key) => {
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

  getDefinition(key: string): CommentProviderDefinition | null {
    return this.definitions.find((d) => d.key === key) ?? null
  }

  /**
   * Give a site a row per installed module, dropping rows for modules no longer on disk. Existing
   * rows are left alone: their settings belong to the site, while everything the definition declares
   * is read from disk per request rather than copied into the row.
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

  async syncAllSites(): Promise<void> {
    const sites = await CARDINAL.db.select({ id: sitesTable.id }).from(sitesTable)
    for (const site of sites) {
      await CARDINAL.models.commentProviders.syncSite(site.id)
    }
    CARDINAL.logger.info('ext', 'registered comment providers', { sites: sites.length })
  }

  /**
   * Every provider of a site, in the order the admin area lists them, with config values completed
   * from the module's declared defaults so a prop added after configuration reads as that default
   * rather than as a missing key.
   *
   * `mask` defaults to false because `setActiveProvider()`'s own merge reads through here and needs
   * the real values to preserve an untouched secret; only a read that serializes `config` straight
   * into an HTTP response passes `{ mask: true }`.
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
    // -> Driven by the definitions rather than the rows: that fixes the order, and a module dropped
    //    from disk without a restart is simply absent instead of half-present
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

  async getSiteProviderByModule(
    siteId: string,
    moduleKey: string,
    opts?: { mask?: boolean }
  ): Promise<CommentProvider | null> {
    return (await this.getSiteProviders(siteId, opts)).find((p) => p.module === moduleKey) ?? null
  }

  /**
   * The site's active provider, or null when none is -- the one answer a page view needs, as against
   * the admin area's full list of discovered modules. Always masked: it reaches an anonymous
   * reader's browser through the public site payload.
   */
  async getActiveProvider(siteId: string): Promise<CommentProvider | null> {
    const providers = await this.getSiteProviders(siteId, { mask: true })
    return providers.find((p) => p.isEnabled) ?? null
  }

  buildConfig(
    moduleKey: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): Record<string, any> {
    return mergeModuleConfig(this.getDefinition(moduleKey)?.props ?? {}, incoming, existing)
  }

  /**
   * The reason the incoming config is invalid, or null when it is fine. An unknown key is dropped by
   * `buildConfig` rather than refused here, so a module losing a prop can never make the admin area
   * unable to save.
   */
  validateConfig(moduleKey: string, incoming: Record<string, any> = {}): string | null {
    return validateModuleConfig(this.getDefinition(moduleKey)?.props ?? {}, incoming)
  }

  /**
   * Set which single provider is active for a site, and store its config values. Every other
   * provider row for the site is disabled in the same transaction that enables this one, so "at most
   * one active provider" holds even under a concurrent call: whichever transaction commits second is
   * the one left enabled. Null when `moduleKey` names no discovered module.
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
    // -> Write-side only, on purpose: a module that loses both flags on disk AFTER activation
    //    surfaces to readers as a non-selectable provider rather than being silently swapped for
    //    another one behind the administrator's back.
    if (!this.isSelectable(definition)) {
      throw new Error(
        `${definition.title} cannot be activated: it has no server-side implementation and does not declare codeTemplate.`
      )
    }
    const invalid = this.validateConfig(moduleKey, config)
    if (invalid) {
      throw new Error(invalid)
    }

    // -> Guarantees a row exists for every discovered module, including one added to disk since this
    //    site was last synced
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

    // -> Masked: this goes straight back to the client as a response body, unlike `current` above,
    //    whose raw config the merge needed.
    return this.getSiteProviderByModule(siteId, moduleKey, { mask: true })
  }
}

export const commentProviders = new CommentProviders()
