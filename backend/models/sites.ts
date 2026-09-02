import crypto from 'node:crypto'
import { mergeWith, toMerged } from 'es-toolkit/object'
import { keyBy } from 'es-toolkit/array'
import {
  apiKeys as apiKeysTable,
  approvalRules as approvalRulesTable,
  assets as assetsTable,
  blockCredentials as blockCredentialsTable,
  blocks as blocksTable,
  commentProviders as commentProvidersTable,
  glossaryTerms as glossaryTermsTable,
  glossaryVersions as glossaryVersionsTable,
  navigation as navigationTable,
  pageHistory as pageHistoryTable,
  pages as pagesTable,
  pageWatchEvents as pageWatchEventsTable,
  siteAssets as siteAssetsTable,
  sites as sitesTable,
  storage as storageTable
} from '../db/schema.ts'
import { and, eq } from 'drizzle-orm'
import { ClusterReloaded } from '../helpers/clusterCache.ts'
import { CustomError, normalizeHostname, siteIdForHostname } from '../helpers/common.ts'
import {
  detectImageMime,
  detectSvg,
  normalizeImage,
  sanitizeSvg,
  svgMimeType
} from '../helpers/images.ts'
import type { ImageNormalization } from '../helpers/images.ts'
import type { SystemIds } from './types.ts'

/**
 * The images a site can have uploaded for it. Each name is also the flag in the site's
 * `config.assets` saying whether there is one — which is what the cached site config is asked before
 * the bytes are ever looked up — and the name the image is addressed by, both to upload it and to
 * serve it.
 */
export const siteAssetKinds = ['logo', 'favicon', 'loginBg'] as const

export type SiteAssetKind = (typeof siteAssetKinds)[number]

/**
 * The size and format each image is stored at, i.e. what a browser is eventually handed. Every one
 * is far smaller than what an administrator is likely to upload: these are a header logo, a tab icon
 * and a login backdrop, not artwork to be kept at its original resolution.
 */
const SITE_ASSET_NORMALIZATION: Record<SiteAssetKind, ImageNormalization> = {
  // -> A logo is whatever shape its owner made it, so it is fitted rather than cropped
  logo: { width: 512, height: 512, fit: 'inside', format: 'webp' },
  // -> PNG rather than WebP: a favicon is read by whatever the browser's tab strip, bookmark list and
  //    home screen are made of, some of it much older than the page itself
  favicon: { width: 180, height: 180, fit: 'cover', format: 'png' },
  loginBg: { width: 1920, height: 1080, fit: 'cover', format: 'webp' }
}

/**
 * Per-site editor defaults, seeded onto every site's config by both `createSite()` and `init()`
 * (the first-run default site). Previously duplicated verbatim in both places.
 */
const DEFAULT_SITE_EDITORS = {
  asciidoc: {
    isActive: true,
    config: {}
  },
  code: {
    isActive: true,
    config: {}
  },
  markdown: {
    isActive: true,
    config: {
      allowHTML: true,
      lineBreaks: true,
      linkify: true,
      multimdTable: true,
      quotes: 'english',
      tabWidth: 2,
      typographer: false,
      underline: true
    }
  },
  wysiwyg: {
    isActive: true,
    config: {}
  }
}

/**
 * Default theme colours seeded for a site, shared by `createSite()`'s default config and `init()`'s
 * first-run catch-all site so the two can never drift apart from each other. Must match the CSS
 * defaults at `frontend/src/css/tailwind.css`'s `:root` block (`--q-secondary`, `--q-accent`) and
 * `AdminTheme.vue`'s `resetColors()`/`defaultConfig()` -- all four are pinned to agree by
 * `helpers/accessibility.test.js` (frontend) and this file's own `sites.test.ts`. Picked to clear
 * 4.5:1 (WCAG AA) against white, the foreground a solid `WBtn` pairs a background this light or
 * darker with.
 */
export const DEFAULT_THEME_COLORS = {
  colorPrimary: '#1976D2',
  colorSecondary: '#018569',
  colorAccent: '#E81221',
  colorHeader: '#000000',
  colorSidebar: '#1976D2'
}

/**
 * Sites model
 */
class Sites extends ClusterReloaded {
  protected readonly reloadEvent = 'reloadSites'

  async getSiteById({ id, forceReload = false }: { id: string; forceReload?: boolean }) {
    if (forceReload) {
      await WIKI.models.sites.reloadCache()
    }
    return WIKI.sites[id]
  }

  async getSiteByHostname({
    hostname,
    forceReload = false,
    strict = false
  }: {
    hostname: string
    forceReload?: boolean
    strict?: boolean
  }) {
    if (forceReload) {
      await WIKI.models.sites.reloadCache()
    }
    const siteId = siteIdForHostname(hostname, { strict })
    if (siteId) {
      return WIKI.sites[siteId]
    }
    return null
  }

  async isHostnameUnique(hostname: string): Promise<boolean> {
    return (await WIKI.db.$count(sitesTable, eq(sitesTable.hostname, hostname))) === 0
  }

  async getAllSites() {
    return WIKI.db.select().from(sitesTable).orderBy(sitesTable.hostname)
  }

  async reloadCache(): Promise<void> {
    WIKI.logger.info('Reloading site configurations...')
    const sites = await WIKI.db.select().from(sitesTable).orderBy(sitesTable.id)
    WIKI.sites = keyBy(sites, (s) => s.id)
    WIKI.sitesMappings = {}
    for (const site of sites) {
      // -> Belt and braces: the write side is already lowercase by construction (site
      //    create/update schemas constrain `hostname` to `^(\*|[a-z0-9.-]+)$`), but routing every
      //    key through the same normalizer as every read keeps both sides provably in lockstep.
      WIKI.sitesMappings[normalizeHostname(site.hostname)] = site.id
    }
    WIKI.logger.info(`Loaded ${sites.length} site configurations [ OK ]`)
  }

  async createSite(hostname: string, config: Record<string, any> = {}) {
    const result = await WIKI.db
      .insert(sitesTable)
      .values({
        hostname,
        isEnabled: true,
        config: toMerged(
          {
            title: 'My Wiki Site',
            description: '',
            company: '',
            contentLicense: '',
            footerExtra: '',
            pageExtensions: ['md', 'html', 'txt'],
            discoverable: false,
            defaults: {
              tocDepth: {
                min: 1,
                max: 2
              }
            },
            features: {
              browse: true,
              collaborativeEditing: true,
              comments: false,
              profile: true,
              reasonForChange: 'optional',
              search: true,
              showOtherGroups: false
            },
            logoText: true,
            sitemap: true,
            robots: {
              index: true,
              follow: true
            },
            // -> Local authentication is the only strategy guaranteed to exist at this point
            authStrategies: [{ id: WIKI.data.systemIds.localAuthId, order: 0, isVisible: true }],
            auth: {
              autoLogin: false,
              bypassUnauthorized: false,
              hideLocal: false,
              loginRedirect: '/',
              welcomeRedirect: '/',
              logoutRedirect: '/'
            },
            locales: {
              primary: 'en',
              active: ['en'],
              forcePrefix: false,
              showMenu: true
            },
            assets: {
              logo: false,
              favicon: false,
              loginBg: false
            },
            theme: {
              dark: false,
              codeBlocksTheme: 'github-dark',
              ...DEFAULT_THEME_COLORS,
              injectCSS: '',
              injectHead: '',
              injectBody: '',
              contentWidth: 'full',
              sidebarPosition: 'left',
              tocPosition: 'right',
              showPrintBtn: true,
              baseFont: 'roboto',
              contentFont: 'roboto'
            },
            editors: DEFAULT_SITE_EDITORS,
            uploads: {
              conflictBehavior: 'overwrite'
            },
            analytics: {
              providers: {}
            },
            search: {
              engine: 'db',
              config: {
                dictOverrides: {}
              }
            }
          },
          config
        )
      })
      .returning({ id: sitesTable.id, config: sitesTable.config })

    const newSite = result[0]

    // -> The menu every page of the site's primary locale inherits by default. Empty to begin with,
    //    but it has to exist before a page can point at it
    WIKI.logger.debug(`Creating new root navigation for site ${newSite.id}`)
    const newSiteConfig = newSite.config as { locales: { primary: string } }
    await WIKI.models.navigation.ensureSiteNav(newSite.id, newSiteConfig.locales.primary)

    // -> Site lookups by id / hostname are served from cache, which must know about the new site —
    //    on every instance, not just this one
    await WIKI.models.sites.broadcastReload()

    // -> Otherwise the new site would have no blocks until the next restart
    await WIKI.models.blocks.syncSite(newSite.id)

    // -> Same for storage: the site needs its database target from the moment it can hold content
    await WIKI.models.storage.syncSite(newSite.id)

    // -> Same for comment providers: the site needs a row per module from the moment it can be
    //    configured, even though none of them are enabled yet
    await WIKI.models.commentProviders.syncSite(newSite.id)

    return newSite
  }

  async updateSite(
    id: string,
    patch: { hostname?: string; isEnabled?: boolean; config?: Record<string, any> }
  ): Promise<boolean> {
    const values: Partial<typeof sitesTable.$inferInsert> = {}
    if (patch.hostname !== undefined) {
      values.hostname = patch.hostname
    }
    if (patch.isEnabled !== undefined) {
      values.isEnabled = patch.isEnabled
    }
    if (patch.config) {
      // -> Config is a JSONB blob, so it must be read and merged rather than partially assigned.
      // Arrays are replaced rather than merged index-wise, otherwise removing an entry (e.g. a page
      // extension) would leave the original value in place. `dictOverrides` (search config) is the
      // object equivalent of that same problem -- a locale -> dictionary map with no fixed keys, where
      // removing an entry must actually remove it rather than leave it merged back in from the
      // previous value -- so it is replaced wholesale by key name, the same way an array is.
      const current = await WIKI.db
        .select({ config: sitesTable.config })
        .from(sitesTable)
        .where(eq(sitesTable.id, id))
      if (current.length < 1) {
        return false
      }
      values.config = mergeWith(
        current[0].config as Record<string, any>,
        patch.config,
        (_targetValue, sourceValue, key) =>
          Array.isArray(sourceValue) || key === 'dictOverrides' ? sourceValue : undefined
      )
    }
    if (Object.keys(values).length < 1) {
      return false
    }

    const updatedResult = await WIKI.db.update(sitesTable).set(values).where(eq(sitesTable.id, id))
    if ((updatedResult.rowCount ?? 0) < 1) {
      return false
    }

    await WIKI.models.sites.broadcastReload()
    return true
  }

  /**
   * The bytes of an image uploaded for a site, if there is one.
   *
   * What was stored depends on what the upload could be normalized to — Sharp is an optional
   * extension, and an SVG is never re-encoded at all — so the type is read back off the bytes rather
   * than assumed.
   */
  async getAsset(
    siteId: string,
    kind: SiteAssetKind
  ): Promise<{ data: Buffer; mime: string } | null> {
    const rows = await WIKI.db
      .select({ data: siteAssetsTable.data })
      .from(siteAssetsTable)
      .where(and(eq(siteAssetsTable.siteId, siteId), eq(siteAssetsTable.kind, kind)))
      .limit(1)
    const data = rows[0]?.data
    if (!data) {
      return null
    }
    const mime =
      detectImageMime(data) ?? (detectSvg(data) ? svgMimeType : 'application/octet-stream')
    return { data, mime }
  }

  /**
   * The sha1 hash of one of a site's uploaded images, without reading the blob itself — selects
   * only the `hash` column, kept in step with `data` by every write in `setAsset`. Lets a
   * conditional request (ETag) be answered without pulling the asset back out of the database.
   *
   * @returns The hash, or null if this kind has never been uploaded for this site
   */
  async getAssetHash(siteId: string, kind: SiteAssetKind): Promise<string | null> {
    const rows = await WIKI.db
      .select({ hash: siteAssetsTable.hash })
      .from(siteAssetsTable)
      .where(and(eq(siteAssetsTable.siteId, siteId), eq(siteAssetsTable.kind, kind)))
      .limit(1)
    return rows[0]?.hash ?? null
  }

  /**
   * Replace one of a site's images.
   *
   * A raster upload is brought down to the size and format it will be served at, per
   * `SITE_ASSET_NORMALIZATION` — there is no reason to hand every visitor the multi-megabyte
   * original of an image displayed 34 pixels tall. That needs the Sharp extension, so without it the
   * uploaded bytes are stored as they came in, which is what the admin area's "requires Sharp"
   * indicator is warning about. An SVG is stored as it came in either way: it is markup, it already
   * scales to any size, and rasterizing it would throw away the only reason to use one.
   *
   * Decision: an oversized-but-unresized upload (up to the route's 10 MB `imageUploadLimit`, stored
   * raw because Sharp is missing) is deliberately NOT flagged per-upload beyond the admin area's
   * "requires Sharp" indicator, which is a standing warning rather than a one-shot toast — it is
   * visible on every visit to this screen for as long as Sharp stays uninstalled, which fits an
   * operator-level problem (fix by reinstalling Sharp, not by re-uploading a smaller file) better
   * than a dismiss-and-forget notification would. Doing better than that would mean broadening the
   * upload route's response (today just `{ ok, message }`) to report whether normalization actually
   * ran and how large the stored bytes ended up — a real feature, not this task's hardening scope.
   * The 10 MB ceiling already bounds the worst case: what is at stake is "served raw, up to 10 MB",
   * not an unbounded original.
   *
   * @param data The uploaded image, already known to be one of the supported formats
   */
  async setAsset(siteId: string, kind: SiteAssetKind, data: Buffer): Promise<void> {
    // -> Only reached when the flag is on: a disabled `security.uploadScanSVG` stores the bytes
    //    exactly as uploaded, same as before this existed.
    const normalized = detectSvg(data)
      ? WIKI.config.security?.uploadScanSVG
        ? sanitizeSvg(data)
        : data
      : ((await normalizeImage(data, SITE_ASSET_NORMALIZATION[kind])) ?? data)
    // -> Kept in step with `data` on every write -- `hash` is NOT NULL with no default, and this is
    //    the same sha1-hex digest `controllers/site.ts` computes from the blob for its ETag, so a
    //    future hash-only reader agrees with what a full blob read would have produced.
    const hash = crypto.createHash('sha1').update(normalized).digest('hex')
    await WIKI.db
      .insert(siteAssetsTable)
      .values({ siteId, kind, data: normalized, hash })
      .onConflictDoUpdate({
        target: [siteAssetsTable.siteId, siteAssetsTable.kind],
        set: { data: normalized, hash }
      })
    // -> Serving reads this flag off the cached site config before it looks for any bytes
    await WIKI.models.sites.updateSite(siteId, { config: { assets: { [kind]: true } } })
  }

  /**
   * Remove one of a site's images, leaving the built-in default to be served again.
   */
  async clearAsset(siteId: string, kind: SiteAssetKind): Promise<void> {
    await WIKI.db
      .delete(siteAssetsTable)
      .where(and(eq(siteAssetsTable.siteId, siteId), eq(siteAssetsTable.kind, kind)))
    await WIKI.models.sites.updateSite(siteId, { config: { assets: { [kind]: false } } })
  }

  /**
   * Delete a site and every row that belongs to it rather than to its content.
   *
   * Pages and assets are checked for up front, and the whole cleanup runs inside one transaction, so
   * a refused delete (or one that hits an FK this method doesn't yet know about) destroys nothing —
   * previously each of the statements below autocommitted on its own, so a delete that was ultimately
   * refused by the final `sites` FK had already durably destroyed every site setting, block, storage
   * target, glossary term and navigation menu it passed on the way there.
   *
   * Block, block-credential, storage, uploaded image, glossary term and navigation rows belong to the
   * site rather than to its content, and their FK has no cascade, so they would otherwise block the
   * delete — navigation includes one row per active locale's site-wide menu
   * (`navigation.ensureSiteNav`'s row, addressed by its own `defaultRandom()` id, never `id ===
   * siteId`) plus any per-page override/hide row still standing. `commentProviders` (seeded per site
   * at creation and re-seeded at every boot), `pageHistory` (a `deleted` row is written before every
   * page delete, so removing every page guarantees rows remain), `pageWatchEvents`, `glossaryVersions`
   * and `approvalRules` are the same story: none is content, none cascades, and
   * nothing else ever deletes their rows. `apiKeys.siteId` is already nullable (OpenProject #2189 — a
   * null `siteId` is an ordinary, intentional "instance-wide" key, the pre-#2189 default every key
   * used to be), so a key scoped to this site is widened to instance-wide rather than destroyed: it is
   * a credential an administrator issued and may still want to use, not a record of the site itself.
   *
   * Pages and assets deliberately still lack a cascade and are what the up-front check below refuses
   * on — see the conflict handling in the route. `pageviews` and `tags` are derived data about the
   * site rather than content, so their `siteId` FK cascades at the schema level instead (`db/schema.ts`
   * — see `tags`'/`pageviews`' own column comments); a site that has only ever been viewed or tagged is
   * not "still holding content", and both are removed for free by Postgres once the final `sites`
   * delete below commits, with nothing to check or clean up here.
   *
   * @throws {CustomError} named `siteHasContent`, statusCode 409, when the site still has pages or
   *   assets — thrown before anything is deleted.
   */
  async deleteSite(id: string): Promise<boolean> {
    // -> Pages and uploaded assets are the tables kept under a site's RESTRICT FK that this method
    //    never clears itself (see the conflict handling in the route) -- counted up front, before
    //    anything is touched, so a refused delete is refused cleanly rather than after the six
    //    unconditional deletes below have already run. Checking here rather than only letting the
    //    final delete's FK violation happen is what makes the refusal atomic: nothing this method does
    //    can be observed to have happened when it returns/throws a refusal.
    const [pageCount, assetCount] = await Promise.all([
      WIKI.db.$count(pagesTable, eq(pagesTable.siteId, id)),
      WIKI.db.$count(assetsTable, eq(assetsTable.siteId, id))
    ])
    if (pageCount + assetCount > 0) {
      throw new CustomError(
        'siteHasContent',
        'Cannot delete a site that still holds content. Delete its pages and assets first.',
        409
      )
    }

    // -> Block, block-credential, storage, uploaded image and glossary term rows belong to the site
    //    rather than to its content, and their FK has no cascade, so they would otherwise block the
    //    delete. Every navigation row this site owns — one per active locale's site-wide menu
    //    (`navigation.ensureSiteNav`'s row, addressed by its own `defaultRandom()` id, never `id ===
    //    siteId`) plus any per-page override/hide row still standing — is the same story and is
    //    cleaned up the same way, filtered by the `siteId` column the FK constraint actually checks.
    //    Wrapped in a transaction (with the precheck above as the normal path, and this as a backstop
    //    against a race where content is inserted between the count and here) so a FK violation on the
    //    final delete rolls every one of these back instead of leaving the site's non-content settings
    //    destroyed while the site row itself survives.
    const deleted = await WIKI.db.transaction(async (tx) => {
      await tx.delete(blocksTable).where(eq(blocksTable.siteId, id))
      await tx.delete(blockCredentialsTable).where(eq(blockCredentialsTable.siteId, id))
      await tx.delete(storageTable).where(eq(storageTable.siteId, id))
      await tx.delete(siteAssetsTable).where(eq(siteAssetsTable.siteId, id))
      await tx.delete(glossaryTermsTable).where(eq(glossaryTermsTable.siteId, id))
      await tx.delete(navigationTable).where(eq(navigationTable.siteId, id))
      // -> None of the six below is content the delete route means to guard on (see the conflict
      //    handling in the route): `commentProviders` is seeded per site at creation
      //    (`createSite()`'s `commentProviders.syncSite()`) and again at every boot, so it blocks even
      //    a brand-new, otherwise-empty site; `pageHistory` outlives every page it describes by design
      //    (`pages.deletePage()` writes a `deleted` row *before* removing the page); `glossaryVersions`,
      //    `pageWatchEvents` and `approvalRules` are all derived/audit data about
      //    the site rather than content, with no cascade and no other delete call site that would ever
      //    clear them on their own. `tags` and `pageviews` are deliberately NOT cleared here either —
      //    both cascade at the schema level (`db/schema.ts`), so Postgres removes them on its own once
      //    the final `sites` delete below commits.
      await tx.delete(commentProvidersTable).where(eq(commentProvidersTable.siteId, id))
      await tx.delete(pageHistoryTable).where(eq(pageHistoryTable.siteId, id))
      await tx.delete(glossaryVersionsTable).where(eq(glossaryVersionsTable.siteId, id))
      await tx.delete(pageWatchEventsTable).where(eq(pageWatchEventsTable.siteId, id))
      await tx.delete(approvalRulesTable).where(eq(approvalRulesTable.siteId, id))
      // -> `apiKeys.siteId` is already nullable — null means instance-wide, not "no site" — so a key
      //    that was scoped to this site is widened to instance-wide rather than destroyed: it is a
      //    credential an administrator issued and may still want to use, not a record of the site
      //    itself.
      await tx.update(apiKeysTable).set({ siteId: null }).where(eq(apiKeysTable.siteId, id))

      const deletedResult = await tx.delete(sitesTable).where(eq(sitesTable.id, id))
      return (deletedResult.rowCount ?? 0) >= 1
    })

    if (deleted) {
      // -> Outside the transaction, after commit: other instances should only be told to reload once
      //    the delete is actually durable.
      await WIKI.models.sites.broadcastReload()
    }
    return deleted
  }

  async countSites() {
    return WIKI.db.$count(sitesTable)
  }

  async countEnabledSites() {
    return WIKI.db.$count(sitesTable, eq(sitesTable.isEnabled, true))
  }

  async init(ids: SystemIds): Promise<void> {
    WIKI.logger.info('Inserting default site...')

    await WIKI.db.insert(sitesTable).values({
      id: ids.siteId,
      hostname: '*',
      isEnabled: true,
      config: {
        title: 'Default Site',
        description: '',
        company: '',
        contentLicense: '',
        footerExtra: '',
        pageExtensions: ['md', 'html', 'txt'],
        discoverable: false,
        defaults: {
          tocDepth: {
            min: 1,
            max: 2
          }
        },
        features: {
          browse: true,
          collaborativeEditing: true,
          comments: false,
          profile: true,
          reasonForChange: 'optional',
          search: true,
          showOtherGroups: false
        },
        logoText: true,
        sitemap: true,
        robots: {
          index: true,
          follow: true
        },
        authStrategies: [{ id: ids.authModuleId, order: 0, isVisible: true }],
        auth: {
          autoLogin: false,
          bypassUnauthorized: false,
          hideLocal: false,
          loginRedirect: '/',
          welcomeRedirect: '/',
          logoutRedirect: '/'
        },
        locales: {
          primary: 'en',
          active: ['en'],
          forcePrefix: false,
          showMenu: true
        },
        assets: {
          logo: false,
          favicon: false,
          loginBg: false
        },
        editors: DEFAULT_SITE_EDITORS,
        theme: {
          dark: false,
          codeBlocksTheme: 'github-dark',
          ...DEFAULT_THEME_COLORS,
          injectCSS: '',
          injectHead: '',
          injectBody: '',
          contentWidth: 'full',
          sidebarPosition: 'left',
          tocPosition: 'right',
          showPrintBtn: true,
          baseFont: 'roboto',
          contentFont: 'roboto'
        },
        uploads: {
          conflictBehavior: 'overwrite'
        },
        analytics: {
          providers: {}
        },
        search: {
          engine: 'db',
          config: {
            dictOverrides: {}
          }
        }
      }
    })
  }
}

export const sites = new Sites()
