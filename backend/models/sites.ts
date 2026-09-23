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
  pageTemplates as pageTemplatesTable,
  pageWatchEvents as pageWatchEventsTable,
  siteAssets as siteAssetsTable,
  sites as sitesTable,
  storage as storageTable
} from '../db/schema.ts'
import type { SiteRow } from '../db/schema.ts'
import { and, eq } from 'drizzle-orm'
import { ClusterReloaded } from '../helpers/clusterCache.ts'
import { CustomError } from '../helpers/common.ts'
import { normalizeHostname, siteIdForHostname } from '../helpers/siteResolution.ts'
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
 * Each name is triple-duty: the stored kind, the key in the site's `config.assets` flag map, and
 * the resource name the upload and serve routes address.
 */
export const siteAssetKinds = ['logo', 'favicon', 'loginBg'] as const

export type SiteAssetKind = (typeof siteAssetKinds)[number]

/**
 * `config.pathDisplayCase` transforms the raw lowercase tree segment behind a path-derived label
 * (breadcrumbs, tree navigation, a page's displayed name) at render time, never the stored `title`.
 * The frontend's `pathDisplay` composable keys its switch on these names.
 */
export const pathDisplayCaseStyles = ['off', 'lower', 'upper', 'camel', 'pascal', 'title'] as const

export type PathDisplayCaseStyle = (typeof pathDisplayCaseStyles)[number]

const SITE_ASSET_NORMALIZATION: Record<SiteAssetKind, ImageNormalization> = {
  // -> A logo is whatever shape its owner made it, so it is fitted rather than cropped
  logo: { width: 512, height: 512, fit: 'inside', format: 'webp' },
  // -> PNG rather than WebP: a favicon is read by whatever the browser's tab strip, bookmark list and
  //    home screen are made of, some of it much older than the page itself
  favicon: { width: 180, height: 180, fit: 'cover', format: 'png' },
  loginBg: { width: 1920, height: 1080, fit: 'cover', format: 'webp' }
}

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
 * Mirrored, with no import across the workspace boundary, in `frontend/src/css/tailwind.css`'s
 * `:root` block, `AdminTheme.vue`'s `resetColors()`/`defaultConfig()` and
 * `frontend/src/helpers/aestheticDefaults.js`'s `ledger` entry -- a fresh site is seeded on the
 * `ledger` aesthetic, so these literals must read the same for that seed to match what "Reset
 * defaults" produces. Picked to clear 4.5:1 (WCAG AA) against white. `colorSecondary` is outside
 * the per-aesthetic set and does not change with the aesthetic switch.
 */
export const DEFAULT_THEME_COLORS = {
  colorPrimary: '#c14a52',
  colorSecondary: '#3f7a66',
  colorAccent: '#c14a52',
  colorHeader: '#ffffff',
  colorSidebar: '#f0f2f7'
}

class Sites extends ClusterReloaded {
  protected readonly reloadEvent = 'reloadSites'

  async getSiteById({ id, forceReload = false }: { id: string; forceReload?: boolean }) {
    if (forceReload) {
      await CARDINAL.models.sites.reloadCache()
    }
    return CARDINAL.sites[id]
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
      await CARDINAL.models.sites.reloadCache()
    }
    const siteId = siteIdForHostname(hostname, { strict })
    if (siteId) {
      return CARDINAL.sites[siteId]
    }
    return null
  }

  async isHostnameUnique(hostname: string): Promise<boolean> {
    return (await CARDINAL.db.$count(sitesTable, eq(sitesTable.hostname, hostname))) === 0
  }

  async getAllSites() {
    return CARDINAL.db.select().from(sitesTable).orderBy(sitesTable.hostname)
  }

  async reloadCache(): Promise<void> {
    const sites = await CARDINAL.db.select().from(sitesTable).orderBy(sitesTable.id)
    // -> Drizzle reads `config` back as `unknown`; this is the one deliberate place it is widened to
    //    the loose shape every `CARDINAL.sites[id].config` read assumes.
    CARDINAL.sites = keyBy(sites, (s) => s.id) as Record<string, SiteRow>
    CARDINAL.sitesMappings = {}
    for (const site of sites) {
      // -> The write side is already lowercase by construction (the site schemas constrain
      //    `hostname` to `^(\*|[a-z0-9.-]+)$`), but keying through the same normalizer every read
      //    uses keeps the two sides provably in lockstep.
      CARDINAL.sitesMappings[normalizeHostname(site.hostname)] = site.id
    }
    CARDINAL.logger.debug('config', 'reloaded the site configurations', { sites: sites.length })
  }

  async createSite(hostname: string, config: Record<string, any> = {}) {
    const result = await CARDINAL.db
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
            banner: { isEnabled: false, title: '', content: '' },
            pageExtensions: ['md', 'html', 'txt'],
            // -> Additive to `helpers/htmlSanitizePolicy.ts`'s hardcoded `ALLOWED_SCHEMES`, so an
            //    empty list permits exactly those. `javascript:`/`vbscript:`/`data:`-on-non-img stay
            //    blocked whatever is listed here -- enforced where the scheme could take effect,
            //    not as a save-time denylist.
            allowedUrlSchemes: [],
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
              // -> Site-wide kill switch for *executing* per-page scripts/styles, ANDed with the
              //    `write:scripts`/`write:styles` grants, which gate authoring only.
              pageScripts: false,
              profile: true,
              reasonForChange: 'optional',
              search: true,
              showOtherGroups: false
            },
            logoText: true,
            sitemap: true,
            pathDisplayCase: 'off',
            robots: {
              index: true,
              follow: true
            },
            // -> Origins permitted to embed this site's pages, read into a per-request
            //    `frame-ancestors` directive; empty allows none. Distinct from the instance-wide
            //    `security.disallowIframe`/`xFrameOptions`, which this does not touch.
            security: {
              embedAllowedOrigins: []
            },
            // -> Local authentication is the only strategy guaranteed to exist at this point
            authStrategies: [
              { id: CARDINAL.data.systemIds.localAuthId, order: 0, isVisible: true }
            ],
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
              aesthetic: 'ledger',
              codeBlocksTheme: 'github-dark',
              ...DEFAULT_THEME_COLORS,
              injectCSS: '',
              injectHead: '',
              injectBody: '',
              contentWidth: 'measured',
              sidebarPosition: 'left',
              tocPosition: 'right',
              showPrintBtn: true,
              baseFont: 'barlow',
              contentFont: 'barlow'
            },
            editors: DEFAULT_SITE_EDITORS,
            uploads: {
              conflictBehavior: 'overwrite'
            },
            analytics: {
              providers: {}
            },
            ai: {
              provider: '',
              providers: {}
            },
            search: {
              engine: 'db',
              config: {
                dictOverrides: {},
                // -> Can't enable what isn't there: on only where the instance-wide capability
                //    (pgvector) is itself true. An operator can still flip it per site afterwards.
                semanticEnabled: CARDINAL.capabilities?.semanticSearch ?? false
              }
            }
          },
          config
        )
      })
      .returning({ id: sitesTable.id, config: sitesTable.config })

    const newSite = result[0]

    // -> Empty to begin with, but it has to exist before a page can point at it
    CARDINAL.logger.debug('nav', 'creating the root navigation', { site: newSite.id })
    const newSiteConfig = newSite.config as { locales: { primary: string } }
    await CARDINAL.models.navigation.ensureSiteNav(newSite.id, newSiteConfig.locales.primary)

    await CARDINAL.models.sites.broadcastReload()

    // -> The three module-backed tables are otherwise only seeded at boot, so without these the new
    //    site would have no blocks, no storage target and no comment provider rows until a restart
    await CARDINAL.models.blocks.syncSite(newSite.id)

    await CARDINAL.models.storage.syncSite(newSite.id)

    await CARDINAL.models.commentProviders.syncSite(newSite.id)

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
      // -> Config is a JSONB blob, so it is read and merged rather than partially assigned. Arrays
      //    are replaced rather than merged index-wise, or removing an entry (a page extension, say)
      //    would leave the original in place; `dictOverrides` and `locales.aliases` are maps with no
      //    fixed keys and the same problem, so they are replaced by key name too.
      const current = await CARDINAL.db
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
          Array.isArray(sourceValue) || key === 'dictOverrides' || key === 'aliases'
            ? sourceValue
            : undefined
      )
    }
    if (Object.keys(values).length < 1) {
      return false
    }

    const updatedResult = await CARDINAL.db
      .update(sitesTable)
      .set(values)
      .where(eq(sitesTable.id, id))
    if ((updatedResult.rowCount ?? 0) < 1) {
      return false
    }

    await CARDINAL.models.sites.broadcastReload()
    return true
  }

  /**
   * What was stored depends on what the upload could be normalized to — Sharp is an optional
   * extension, and an SVG is never re-encoded at all — so the type is read back off the bytes rather
   * than assumed.
   */
  async getAsset(
    siteId: string,
    kind: SiteAssetKind
  ): Promise<{ data: Buffer; mime: string } | null> {
    const rows = await CARDINAL.db
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
   * Selects the `hash` column alone, so a conditional request (ETag) is answered without pulling
   * the blob back out of the database.
   */
  async getAssetHash(siteId: string, kind: SiteAssetKind): Promise<string | null> {
    const rows = await CARDINAL.db
      .select({ hash: siteAssetsTable.hash })
      .from(siteAssetsTable)
      .where(and(eq(siteAssetsTable.siteId, siteId), eq(siteAssetsTable.kind, kind)))
      .limit(1)
    return rows[0]?.hash ?? null
  }

  /**
   * A raster upload is re-encoded to what it will be served at (`SITE_ASSET_NORMALIZATION`), which
   * needs the optional Sharp extension; without it the bytes are stored as they came in, which the
   * admin area's standing "requires Sharp" indicator already warns about, so an unresized upload is
   * not flagged per-upload. An SVG is stored as uploaded either way: it is markup, it already
   * scales, and rasterizing it discards the only reason to use one.
   *
   * @param data Already known to be one of the supported formats
   */
  async setAsset(siteId: string, kind: SiteAssetKind, data: Buffer): Promise<void> {
    const normalized = detectSvg(data)
      ? CARDINAL.config.security?.uploadScanSVG
        ? sanitizeSvg(data)
        : data
      : ((await normalizeImage(data, SITE_ASSET_NORMALIZATION[kind])) ?? data)
    // -> Must be written with every `data` write (`hash` is NOT NULL, no default): it is the only
    //    thing `controllers/site.ts` builds its ETag from, without ever reading the blob.
    const hash = crypto.createHash('sha1').update(normalized).digest('hex')
    await CARDINAL.db
      .insert(siteAssetsTable)
      .values({ siteId, kind, data: normalized, hash })
      .onConflictDoUpdate({
        target: [siteAssetsTable.siteId, siteAssetsTable.kind],
        set: { data: normalized, hash }
      })
    // -> Serving reads this flag off the cached site config before it looks for any bytes
    await CARDINAL.models.sites.updateSite(siteId, { config: { assets: { [kind]: true } } })
  }

  async clearAsset(siteId: string, kind: SiteAssetKind): Promise<void> {
    await CARDINAL.db
      .delete(siteAssetsTable)
      .where(and(eq(siteAssetsTable.siteId, siteId), eq(siteAssetsTable.kind, kind)))
    await CARDINAL.models.sites.updateSite(siteId, { config: { assets: { [kind]: false } } })
  }

  /**
   * Pages and assets are the two tables under a site's RESTRICT FK this method never clears itself,
   * so they are counted up front and refused before anything is touched. The cleanup then runs in
   * one transaction, so a refusal — including from an FK this method does not yet know about, or
   * from content inserted between that count and the deletes — leaves nothing destroyed. Everything
   * cleared inside it has no cascade and would otherwise block the final delete; `tags` and
   * `pageviews` are absent because their `siteId` FK cascades in `db/schema.ts`.
   *
   * @throws {CustomError} named `siteHasContent`, 409, when the site still has pages or assets.
   */
  async deleteSite(id: string): Promise<boolean> {
    const [pageCount, assetCount] = await Promise.all([
      CARDINAL.db.$count(pagesTable, eq(pagesTable.siteId, id)),
      CARDINAL.db.$count(assetsTable, eq(assetsTable.siteId, id))
    ])
    if (pageCount + assetCount > 0) {
      throw new CustomError(
        'siteHasContent',
        'Cannot delete a site that still holds content. Delete its pages and assets first.',
        409
      )
    }

    const deleted = await CARDINAL.db.transaction(async (tx) => {
      await tx.delete(blocksTable).where(eq(blocksTable.siteId, id))
      await tx.delete(blockCredentialsTable).where(eq(blockCredentialsTable.siteId, id))
      await tx.delete(storageTable).where(eq(storageTable.siteId, id))
      await tx.delete(siteAssetsTable).where(eq(siteAssetsTable.siteId, id))
      await tx.delete(glossaryTermsTable).where(eq(glossaryTermsTable.siteId, id))
      await tx.delete(pageTemplatesTable).where(eq(pageTemplatesTable.siteId, id))
      await tx.delete(navigationTable).where(eq(navigationTable.siteId, id))
      // -> None of these is content the route guards on, and each outlives what it describes:
      //    `commentProviders` is re-seeded at every boot, so it blocks even a brand-new site, and
      //    `pageHistory` survives every page (`pages.deletePage()` writes its `deleted` row *before*
      //    removing the page).
      await tx.delete(commentProvidersTable).where(eq(commentProvidersTable.siteId, id))
      await tx.delete(pageHistoryTable).where(eq(pageHistoryTable.siteId, id))
      await tx.delete(glossaryVersionsTable).where(eq(glossaryVersionsTable.siteId, id))
      await tx.delete(pageWatchEventsTable).where(eq(pageWatchEventsTable.siteId, id))
      await tx.delete(approvalRulesTable).where(eq(approvalRulesTable.siteId, id))
      // -> A null `siteId` means instance-wide, not "no site", so a key scoped to this site is
      //    widened rather than destroyed: it is a credential an administrator issued and may still
      //    want, not a record of the site.
      await tx.update(apiKeysTable).set({ siteId: null }).where(eq(apiKeysTable.siteId, id))

      const deletedResult = await tx.delete(sitesTable).where(eq(sitesTable.id, id))
      return (deletedResult.rowCount ?? 0) >= 1
    })

    if (deleted) {
      // -> After commit, not inside: other instances are told to reload only once the delete is
      //    durable.
      await CARDINAL.models.sites.broadcastReload()
    }
    return deleted
  }

  async countSites() {
    return CARDINAL.db.$count(sitesTable)
  }

  async countEnabledSites() {
    return CARDINAL.db.$count(sitesTable, eq(sitesTable.isEnabled, true))
  }

  async init(ids: SystemIds): Promise<void> {
    CARDINAL.logger.debug('config', 'seeding the default site')

    await CARDINAL.db.insert(sitesTable).values({
      id: ids.siteId,
      hostname: '*',
      isEnabled: true,
      config: {
        title: 'Default Site',
        description: '',
        company: '',
        contentLicense: '',
        footerExtra: '',
        banner: { isEnabled: false, title: '', content: '' },
        pageExtensions: ['md', 'html', 'txt'],
        allowedUrlSchemes: [],
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
          pageScripts: false,
          profile: true,
          reasonForChange: 'optional',
          search: true,
          showOtherGroups: false
        },
        logoText: true,
        sitemap: true,
        pathDisplayCase: 'off',
        robots: {
          index: true,
          follow: true
        },
        security: {
          embedAllowedOrigins: []
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
          aesthetic: 'ledger',
          codeBlocksTheme: 'github-dark',
          ...DEFAULT_THEME_COLORS,
          injectCSS: '',
          injectHead: '',
          injectBody: '',
          contentWidth: 'measured',
          sidebarPosition: 'left',
          tocPosition: 'right',
          showPrintBtn: true,
          baseFont: 'barlow',
          contentFont: 'barlow'
        },
        uploads: {
          conflictBehavior: 'overwrite'
        },
        analytics: {
          providers: {}
        },
        ai: {
          provider: '',
          providers: {}
        },
        search: {
          engine: 'db',
          config: {
            dictOverrides: {},
            semanticEnabled: CARDINAL.capabilities?.semanticSearch ?? false
          }
        }
      }
    })
  }
}

export const sites = new Sites()
