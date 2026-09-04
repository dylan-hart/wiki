import { and, count, eq, inArray } from 'drizzle-orm'
import { pages as pagesTable } from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import { defaultLocale } from '../helpers/localeRouting.ts'
import { resolveSiteParam } from '../helpers/siteResolution.ts'
import { detectImageMime, detectSvg, imageMimeTypes, svgMimeType } from '../helpers/images.ts'
import { absoluteRedirectsAllowed, isFollowableRedirectTarget } from '../helpers/redirectTarget.ts'
import { maySiteAdmin, SITE_PERMISSIONS } from '../helpers/siteRules.ts'
import { actorFromRequest } from '../models/auditLog.ts'
import { siteAssetKinds } from '../models/sites.ts'
import type { SiteAssetKind } from '../models/sites.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

/** How large one of a site's own images may be uploaded, before it is re-encoded. */
const imageUploadLimit = 10 * 1024 * 1024

/**
 * Site properties stored in the `config` JSONB column rather than as their own table column.
 * Anything listed here is merged into the existing config on update.
 */
const SITE_CONFIG_KEYS = [
  'title',
  'description',
  'company',
  'contentLicense',
  'footerExtra',
  'pageExtensions',
  'allowedUrlSchemes',
  'logoText',
  'sitemap',
  'discoverable',
  'analytics',
  'auth',
  'authStrategies',
  'defaults',
  'editors',
  'features',
  'locales',
  'robots',
  'theme',
  'uploads'
] as const

/**
 * Which `site:*` permission (see `helpers/siteRules.ts`) governs each key `PUT /:siteId` can
 * touch, per the per-surface mapping in §3 of `docs/decisions/delegated-per-site-administration.md`.
 *
 * `general`, `theme`, `login`, `locale` and `editors` all write through this one route, so — unlike
 * `blocks.ts`, `navigation.ts` and `approvals.ts`, which each have a dedicated route per permission —
 * the check here has to be per body key, not per route. A key with no entry (`isEnabled`, or
 * anything not in `SITE_CONFIG_KEYS`) is deliberately left ungated by any `site:*` permission: it
 * belongs to `AdminSites.vue`'s own site-management actions (enable/disable, alongside create and
 * delete), which stay `manage:sites`-only rather than becoming delegable.
 */
const SITE_FIELD_PERMISSIONS: Partial<
  Record<(typeof SITE_CONFIG_KEYS)[number] | 'hostname' | 'isEnabled', string>
> = {
  hostname: 'site:general',
  title: 'site:general',
  description: 'site:general',
  company: 'site:general',
  contentLicense: 'site:general',
  footerExtra: 'site:general',
  pageExtensions: 'site:general',
  allowedUrlSchemes: 'site:general',
  logoText: 'site:general',
  sitemap: 'site:general',
  discoverable: 'site:general',
  defaults: 'site:general',
  features: 'site:general',
  robots: 'site:general',
  uploads: 'site:general',
  auth: 'site:login',
  authStrategies: 'site:login',
  locales: 'site:locale',
  editors: 'site:editors',
  theme: 'site:theme'
}

/** Which `site:*` permission covers replacing or clearing each of a site's own images. */
const SITE_IMAGE_KIND_PERMISSIONS: Record<SiteAssetKind, string> = {
  logo: 'site:general',
  favicon: 'site:general',
  loginBg: 'site:login'
}

/**
 * Every `site:*` permission (see `helpers/siteRules.ts`) this requester holds on this site.
 *
 * The site-scoped counterpart to `pagePermissionsFor` in `helpers/pageAccess.ts`: what the interface hides
 * `AdminGeneral.vue`, `AdminTheme.vue` and the rest of the nine site-scoped admin pages by, asked the
 * same way that route's own handlers decide it (`checkSiteAccess`) rather than a broader question.
 *
 * Deliberately does NOT fold in `manage:sites`, `manage:theme` or `manage:navigation` — each of those
 * covers a different subset of the eight surfaces (see `SITE_FIELD_PERMISSIONS`, and the
 * `checkSiteAdminAccess` calls in `api/blocks.ts`, `api/navigation.ts` and `api/approvals.ts`), so
 * folding any one of them in here would tell the caller they hold a permission
 * a specific route would still refuse. The frontend already has all three of those in
 * `userStore.permissions` and combines them itself — see `frontend/src/composables/siteAdminAccess.js`.
 */
function sitePermissionsFor(req: FastifyRequest, siteId: string): string[] {
  const actor = WIKI.models.groups.actorForRequest(req)
  if (actor.permissions.includes('manage:system')) {
    return SITE_PERMISSIONS
  }
  return SITE_PERMISSIONS.filter((permission) =>
    WIKI.models.groups.checkSiteAccess(actor, permission, siteId)
  )
}

/**
 * Assemble the payload a site's config alone doesn't cover: the row fields (`id`, `hostname`,
 * `isEnabled`) plus `pdfExportAvailable`, which isn't something a site chooses — it's whether this
 * whole instance ever installed the Puppeteer extension, per `WIKI.models.renderQueue.isAvailable()`,
 * the same check `renderPdf` itself gates on before ever launching a browser. Surfaced here, on the
 * payload the frontend already loads per-site (`sites/:siteIdorHostname` via `siteStore.loadSite`)
 * and reused by `bootstrap` for the same payload at app load, so the PDF export control can hide or
 * disable itself with an explanatory tooltip instead of offering a button that always 503s.
 *
 * Also carries `navigationId`: this site's default (locale-scoped) menu row id, resolved via
 * `WIKI.models.navigation.ensureSiteNav()` the same way `GET .../navigation/default` resolves it for
 * an admin caller. Unlike that route -- gated behind `manage:navigation`/`site:navigation`, a
 * convenience-route choice rather than a real permission requirement, since `ensureSiteNav()` itself
 * checks nothing -- this is `publicAccess: true`, because the only other way a browser ever learns a
 * real `navigationId` today is embedded in a per-page fetch response (`toPage()` in
 * `models/pages.ts`), which requires a content page to have loaded first. A non-content `MainLayout`
 * route (the knowledge graph, tags browse) never calls that, so without this fallback its sidebar has
 * no `navigationId` to ask for on a cold load or refresh (OpenProject #2526/#2527) -- `NavSidebar.vue`'s
 * watcher falls back to `siteStore.navigationId` exactly when `pageStore.navigationId` is unset.
 *

 * Every `site.config` key reaching the response is named explicitly rather than spread in, and both
 * callers of this function (`GET /sites/:siteIdorHostname` below and `GET /_api/bootstrap`) are
 * `publicAccess: true`. `search` is the reason: it's where active search-engine credentials live
 * (`WIKI.sites[siteId]?.config?.search?.engines?.[key]` — `models/search.ts:402`/`:535`, Algolia's
 * `apiKey` and AWS CloudSearch's `secretAccessKey`), seeded under the same top-level `search` key as
 * `search.engine`/`search.config` (`models/sites.ts`'s `createSite` defaults). It used to stay out of
 * the browser only because `api/schemas/site.ts`'s `Site` schema declared no top-level `search`
 * property and fast-json-stringify silently drops undeclared keys — an invariant nothing stated and
 * no test pinned, so one additive schema edit would have disclosed both keys on the app's
 * highest-traffic unauthenticated route. Naming every key here — mirroring
 * `authentication.ts`'s `activeStrategies` payload — makes the omission positive instead of
 * accidental; `schemas/site.test.ts` pins it.
 */
export async function buildSitePayload(site: {
  id: string
  hostname: string
  isEnabled: boolean
  config: Record<string, any>
}): Promise<Record<string, any>> {
  const { blocksConfig, blocksIndex } = await siteBlocksInfoFor(site.id)
  const config = site.config
  return {
    id: site.id,
    hostname: site.hostname,
    isEnabled: site.isEnabled,
    pdfExportAvailable: await WIKI.models.renderQueue.isAvailable(),
    docsBase: WIKI.config.docsBase,
    navigationId: await WIKI.models.navigation.ensureSiteNav(site.id, defaultLocale(site.id)),
    blocksConfig,
    blocksIndex,
    title: config.title,
    description: config.description,
    company: config.company,
    contentLicense: config.contentLicense,
    footerExtra: config.footerExtra,
    pageExtensions: config.pageExtensions,
    allowedUrlSchemes: config.allowedUrlSchemes,
    discoverable: config.discoverable,
    defaults: config.defaults,
    features: config.features,
    uploads: config.uploads,
    logoText: config.logoText,
    sitemap: config.sitemap,
    robots: config.robots,
    auth: config.auth,
    authStrategies: config.authStrategies,
    locales: config.locales,
    assets: config.assets,
    editors: config.editors,
    theme: config.theme,
    analytics: config.analytics
  }
}

/**
 * The site's per-block config and tag-to-block index, both for a reader's browser.
 *
 * Built from one `getSiteBlocks` call rather than a route of its own: `GET /sites/:siteId/blocks`
 * (see `mayListBlocks` in `api/blocks.ts`) is gated to authors and administrators, and a page reader
 * is neither. Both travel instead on the site-info response every reader's browser already fetches
 * publicly:
 *
 *   - `blocksConfig` lets a block like `block-map` resolve its site-wide config (a tile server URL,
 *     an API key) without ever calling the gated route.
 *   - `blocksIndex` lets the page view resolve an undefined `block-*` element to its `id`/`isCustom`
 *     — what `blockImportUrl()` (`stores/common.js`) needs to build a custom block's
 *     `/_blocks/custom/:siteId/:id.js` import URL — without the gated route either. Before this
 *     existed, that resolution went through `GET /sites/:siteId/blocks` directly (OpenProject #954),
 *     so a custom block silently 404'd (falling through to the built-in, tag-only URL) for every
 *     reader who wasn't also an author.
 *
 * Both are filtered to enabled blocks only: a disabled block must never reach a reader's browser,
 * neither its config nor a URL to fetch its code from. `blocksConfig` additionally excludes a block
 * with nothing configurable, so it doesn't add an empty object to every page's payload for no reader
 * to use.
 */
async function siteBlocksInfoFor(
  siteId: string
): Promise<{ blocksConfig: Record<string, object>; blocksIndex: Record<string, object> }> {
  const siteBlocks = await WIKI.models.blocks.getSiteBlocks(siteId)
  const blocksConfig: Record<string, object> = {}
  const blocksIndex: Record<string, object> = {}
  for (const block of siteBlocks) {
    if (!block.isEnabled) {
      continue
    }
    if (block.configFields.length > 0) {
      blocksConfig[block.block] = block.config ?? {}
    }
    blocksIndex[block.block] = { id: block.id, isCustom: block.isCustom }
  }
  return { blocksConfig, blocksIndex }
}

/**
 * Sites API Routes
 */
async function routes(app: FastifyInstance) {
  // -> An image upload is the raw file rather than a multipart form: one file, no fields, and no
  //    dependency to add. Registered inside this plugin, so every other route keeps rejecting an
  //    image body outright.
  app.addContentTypeParser(
    [...imageMimeTypes, svgMimeType],
    { parseAs: 'buffer', bodyLimit: imageUploadLimit },
    (req, body, done) => {
      done(null, body)
    }
  )

  app.get(
    '/',
    {
      config: {
        permissions: ['access:admin']
      },
      schema: {
        summary: 'List all sites',
        tags: ['Sites'],
        response: {
          200: {
            description: 'List of all sites',
            type: 'array',
            items: { $ref: 'Site#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      const sites = await WIKI.models.sites.getAllSites()
      return sites.map((s: any) => ({
        ...s.config,
        id: s.id,
        hostname: s.hostname,
        isEnabled: s.isEnabled
      }))
    }
  )

  app.get<{ Params: { siteIdorHostname: string }; Querystring: { strict?: boolean } }>(
    '/:siteIdorHostname',
    {
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'Get site info',
        tags: ['Sites'],
        params: {
          type: 'object',
          properties: {
            siteIdorHostname: {
              type: 'string',
              description: 'Either a site ID, hostname or "current" to use the request hostname.',
              anyOf: [{ format: 'uuid' }, { enum: ['current'] }, { pattern: '^[a-z0-9.-]+$' }]
            }
          },
          required: ['siteIdorHostname']
        },
        querystring: {
          type: 'object',
          properties: {
            strict: {
              type: 'boolean',
              description:
                'Whether to only return a site that exactly matches the hostname. Wildcard sites will not be matched.',
              default: false
            }
          }
        },
        response: {
          200: {
            description: 'Site info',
            type: 'object',
            $ref: 'Site#'
          },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const site = await resolveSiteParam(req.params.siteIdorHostname, req.hostname, {
        strict: req.query.strict ?? false
      })
      if (site) {
        return buildSitePayload(site)
      } else {
        return reply.notFound('Site does not exist.')
      }
    }
  )

  /**
   * SITE USER PERMISSIONS
   */
  app.get<{ Params: { siteId: string } }>(
    '/:siteId/userPermissions',
    {
      /*
        No route-level `permissions`: same reasoning as `pages/userPermissions` in `api/pages/read.ts` --
        this answers what the caller may do, which for an anonymous or under-permissioned caller is
        an empty array rather than a 403.
      */
      schema: {
        summary: 'Get site-admin user permissions',
        description:
          "Which `site:*` permissions (see `helpers/siteRules.ts`) the caller holds on this site. This is what the interface hides the nine site-scoped admin pages by. Deliberately does not fold in `manage:sites` / `manage:theme` / `manage:navigation` -- see `sitePermissionsFor`'s own comment for why.",
        tags: ['Sites'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Site-admin permissions the current user holds for this site',
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    },
    async (req) => {
      return sitePermissionsFor(req, req.params.siteId)
    }
  )

  /**
   * CREATE SITE
   */
  app.post<{ Body: { hostname: string; title: string } }>(
    '/',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Create a new site',
        tags: ['Sites'],
        body: {
          type: 'object',
          required: ['hostname', 'title'],
          properties: {
            hostname: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              pattern: '^(\\*|[a-z0-9.-]+)$'
            },
            title: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            }
          },
          examples: [
            {
              hostname: 'wiki.example.org',
              title: 'My Wiki Site'
            }
          ]
        },
        response: {
          200: {
            description: 'Site created successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              id: {
                type: 'string',
                format: 'uuid'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The site could not be created.' }
        }
      }
    },
    async (req, reply) => {
      // -> Validate inputs
      // -> hostname is already validated by the body schema's `pattern`; no hand-rolled check needed.
      if (!req.body.title || req.body.title.length < 1 || !/^[^<>"]+$/.test(req.body.title)) {
        throw new CustomError('siteCreateInvalidTitle', 'Invalid Site Title')
      }

      // -> Check for duplicate hostname
      if (!(await WIKI.models.sites.isHostnameUnique(req.body.hostname))) {
        if (req.body.hostname === '*') {
          throw new CustomError(
            'siteCreateDuplicateCatchAll',
            'A site with a catch-all hostname already exists! Cannot have 2 catch-all hostnames.'
          )
        } else {
          throw new CustomError(
            'siteCreateDuplicateHostname',
            'A site with a this hostname already exists! Cannot have duplicate hostnames.'
          )
        }
      }

      // -> Create site
      try {
        const result = await WIKI.models.sites.createSite(req.body.hostname, {
          title: req.body.title
        })
        return {
          ok: true,
          message: 'Site created successfully.',
          id: result.id
        }
      } catch (err: any) {
        WIKI.logger.warn(err)
        return reply.internalServerError()
      }
    }
  )

  /**
   * UPDATE SITE
   */
  app.put<{
    Params: { siteId: string }
    Body: {
      isEnabled?: boolean
      hostname?: string
      title?: string
      description?: string
      company?: string
      contentLicense?: string
      footerExtra?: string
      pageExtensions?: string[]
      allowedUrlSchemes?: string[]
      logoText?: boolean
      sitemap?: boolean
      discoverable?: boolean
      analytics?: {
        providers?: Record<string, { isEnabled?: boolean; config?: Record<string, any> }>
      }
      auth?: Record<string, any>
      authStrategies?: Array<{ id: string; order?: number; isVisible?: boolean }>
      defaults?: Record<string, any>
      editors?: Record<string, { isActive?: boolean; config?: Record<string, any> }>
      features?: Record<string, any>
      locales?: {
        primary?: string
        active?: string[]
        forcePrefix?: boolean
        showMenu?: boolean
      }
      robots?: Record<string, any>
      theme?: Record<string, any>
      uploads?: Record<string, any>
    }
  }>(
    '/:siteId',
    {
      /*
        No route-level `permissions`: five different `site:*` permissions gate different keys of the
        same body (see `SITE_FIELD_PERMISSIONS`), which `config.permissions` cannot express any more
        than it can express a page permission — see CLAUDE.md's "A page permission cannot be enforced
        by `config.permissions`" note, which applies identically to a site-scoped one. Checked in the
        handler below instead.
      */
      schema: {
        summary: 'Update a site',
        description:
          'Requires `manage:sites`, or — per key touched — the matching `site:*` permission on this site: `site:general` for `hostname`/`title`/`description`/`company`/`contentLicense`/`footerExtra`/`pageExtensions`/`allowedUrlSchemes`/`logoText`/`sitemap`/`discoverable`/`defaults`/`features`/`robots`/`uploads`, `site:theme` for `theme`, `site:login` for `auth`/`authStrategies`, `site:locale` for `locales`, `site:editors` for `editors`. `isEnabled` is not delegable and always requires `manage:sites`. The instance-wide `manage:theme` permission (see task #681) also covers a patch that touches nothing but `theme`.',
        tags: ['Sites'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          properties: {
            isEnabled: {
              type: 'boolean'
            },
            hostname: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              pattern: '^(\\*|[a-z0-9.-]+)$'
            },
            title: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            },
            description: {
              type: 'string'
            },
            company: {
              type: 'string'
            },
            contentLicense: {
              type: 'string'
            },
            footerExtra: {
              type: 'string'
            },
            pageExtensions: {
              type: 'array',
              items: {
                type: 'string',
                pattern: '^[a-z0-9]+$'
              }
            },
            allowedUrlSchemes: {
              type: 'array',
              description:
                'Additional URL schemes (e.g. `discord`) permitted in page link/embed hrefs, additive to the hardcoded safe defaults (`http`, `https`, `mailto`, `tel`, `ftp`). `javascript`, `vbscript` and `data` (on a non-img element) are never actually permittable regardless of what is listed here — enforced at render time, not by this schema.',
              items: {
                type: 'string',
                pattern: '^[a-z][a-z0-9+.-]*$'
              }
            },
            logoText: {
              type: 'boolean'
            },
            sitemap: {
              type: 'boolean'
            },
            discoverable: {
              type: 'boolean'
            },
            analytics: {
              $ref: 'Site#/properties/analytics'
            },
            auth: {
              $ref: 'Site#/properties/auth'
            },
            authStrategies: {
              $ref: 'Site#/properties/authStrategies'
            },
            defaults: {
              $ref: 'Site#/properties/defaults'
            },
            editors: {
              $ref: 'Site#/properties/editors'
            },
            features: {
              $ref: 'Site#/properties/features'
            },
            locales: {
              $ref: 'Site#/properties/locales'
            },
            robots: {
              $ref: 'Site#/properties/robots'
            },
            theme: {
              $ref: 'Site#/properties/theme'
            },
            uploads: {
              $ref: 'Site#/properties/uploads'
            }
          },
          examples: [
            {
              hostname: 'wiki.example.org',
              title: 'My Wiki Site'
            }
          ]
        },
        response: {
          200: {
            description: 'Site updated successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The site could not be updated.' }
        }
      }
    },
    async (req, reply) => {
      const actor = WIKI.models.groups.actorForRequest(req)
      if (
        !actor.permissions.includes('manage:system') &&
        !actor.permissions.includes('manage:sites')
      ) {
        const touchedKeys = Object.keys(req.body) as (
          | (typeof SITE_CONFIG_KEYS)[number]
          | 'hostname'
          | 'isEnabled'
        )[]
        // -> The instance-wide `manage:theme` grant (task #681) only ever covers a patch that
        //    touches nothing but `theme` — anything broader falls through to the per-key check
        //    below, same as it always has.
        const maySaveThemeOnly =
          actor.permissions.includes('manage:theme') &&
          touchedKeys.length > 0 &&
          touchedKeys.every((key) => key === 'theme')
        if (!maySaveThemeOnly) {
          const missingPermission = touchedKeys.some((key) => {
            const required = SITE_FIELD_PERMISSIONS[key]
            // -> `isEnabled`, or any key nobody delegated a `site:*` permission for, stays
            //    `manage:sites`-only -- reaching this branch already means that's absent.
            if (!required) {
              return true
            }
            return !WIKI.models.groups.checkSiteAccess(actor, required, req.params.siteId)
          })
          if (missingPermission) {
            return reply.forbidden()
          }
        }
      }

      // -> Validate inputs
      if (req.body.title !== undefined && !/^[^<>"]+$/.test(req.body.title)) {
        throw new CustomError('siteUpdateInvalidTitle', 'Invalid Site Title')
      }

      // -> Guard against a `javascript:` (or any other non-http(s)) `auth.*Redirect` field the same
      //    way the group redirect fields are guarded — OpenProject #2208 §2. `welcomeRedirect` and
      //    `logoutRedirect` are handed straight to the browser the same way `loginRedirect` is.
      if (req.body.auth) {
        const allowAbsolute = absoluteRedirectsAllowed()
        for (const field of ['loginRedirect', 'welcomeRedirect', 'logoutRedirect'] as const) {
          const value = req.body.auth[field]
          if (
            value !== undefined &&
            value !== '' &&
            !isFollowableRedirectTarget(value, { allowAbsolute })
          ) {
            throw new CustomError(
              'siteUpdateInvalidRedirect',
              `auth.${field} must be a path on this wiki${allowAbsolute ? ' or a complete https:// URL' : ''}.`
            )
          }
        }
      }

      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }

      // -> Mirror the DELETE route's last-site guard: a site can only be disabled if at least one
      //    other site would remain enabled, otherwise every hostname would stop resolving.
      if (
        req.body.isEnabled === false &&
        site.isEnabled &&
        (await WIKI.models.sites.countEnabledSites()) <= 1
      ) {
        return reply.conflict(
          'Cannot disable the last enabled site. At least 1 site must remain enabled at all times.'
        )
      }

      // -> Check for duplicate hostname
      if (
        req.body.hostname !== undefined &&
        req.body.hostname !== site.hostname &&
        !(await WIKI.models.sites.isHostnameUnique(req.body.hostname))
      ) {
        if (req.body.hostname === '*') {
          throw new CustomError(
            'siteUpdateDuplicateCatchAll',
            'A site with a catch-all hostname already exists! Cannot have 2 catch-all hostnames.'
          )
        } else {
          throw new CustomError(
            'siteUpdateDuplicateHostname',
            'A site with a this hostname already exists! Cannot have duplicate hostnames.'
          )
        }
      }

      // -> Validate locales against the installed ones, and against what the site ends up with once
      //    the patch is merged, so that a partial update cannot leave the primary locale inactive
      if (req.body.locales) {
        const installedCodes = (await WIKI.models.locales.getLocales()).map((lc: any) => lc.code)
        const active = req.body.locales.active ?? site.config.locales?.active ?? []
        const primary = req.body.locales.primary ?? site.config.locales?.primary

        if (active.length < 1) {
          throw new CustomError(
            'siteUpdateNoActiveLocale',
            'At least one active locale is required.'
          )
        }
        const unknownCodes = [...active, primary].filter(
          (code) => code && !installedCodes.includes(code)
        )
        if (unknownCodes.length > 0) {
          throw new CustomError(
            'siteUpdateUnknownLocale',
            `Locale is not installed: ${[...new Set(unknownCodes)].join(', ')}`
          )
        }
        if (!active.includes(primary)) {
          throw new CustomError(
            'siteUpdatePrimaryLocaleNotActive',
            'The primary locale must be one of the active locales.'
          )
        }

        // -> Deactivating a locale that still holds pages would orphan them: unreachable by URL
        //    (the prefix parser only recognizes ACTIVE codes), uncreatable, yet still surfacing in
        //    the file manager and search. Refuse with counts; moving or deleting the pages first is
        //    the explicit path. (Decision doc, Option A item 5.)
        //
        //    Only PAGES are counted, deliberately: a folder or asset left behind in a deactivated
        //    locale with zero pages does not orphan a reachable URL the way a page would, so
        //    deactivation is allowed to proceed in that case. Pages are the orphaning concern this
        //    check exists for.
        const removedLocales = (site.config.locales?.active ?? []).filter(
          (code: string) => !active.includes(code)
        )
        if (removedLocales.length > 0) {
          const counts = await WIKI.db
            .select({ locale: pagesTable.locale, total: count() })
            .from(pagesTable)
            .where(
              and(
                eq(pagesTable.siteId, req.params.siteId),
                inArray(pagesTable.locale, removedLocales)
              )
            )
            .groupBy(pagesTable.locale)
          if (counts.length > 0) {
            throw new CustomError(
              'siteUpdateLocaleHasPages',
              `Cannot deactivate locale(s) still holding pages: ${counts
                .map((c) => `${c.locale} (${c.total})`)
                .join(', ')}. Move or delete those pages first.`,
              409
            )
          }
        }
      }

      // -> Split the patch between real columns and the config JSONB blob
      const config: Record<string, any> = {}
      for (const key of SITE_CONFIG_KEYS) {
        if (req.body[key] !== undefined) {
          config[key] = req.body[key]
        }
      }

      // -> Update site
      try {
        await WIKI.models.sites.updateSite(req.params.siteId, {
          hostname: req.body.hostname,
          isEnabled: req.body.isEnabled,
          ...(Object.keys(config).length < 1 ? {} : { config })
        })
        await WIKI.models.auditLog.record({
          event: 'site.settingsUpdated',
          actor: actorFromRequest(req),
          targetType: 'site',
          targetId: req.params.siteId,
          targetLabel: req.body.title ?? site.title,
          detail: {
            changedFields: Object.keys(req.body)
          },
          siteId: req.params.siteId
        })
        return {
          ok: true,
          message: 'Site updated successfully.'
        }
      } catch (err: any) {
        WIKI.logger.warn(err)
        return reply.internalServerError()
      }
    }
  )

  /**
   * UPLOAD SITE IMAGE
   */
  app.put<{ Params: { siteId: string; kind: SiteAssetKind } }>(
    '/:siteId/images/:kind',
    {
      /*
        No route-level `permissions`: which `site:*` permission applies depends on `kind` (`logo`
        and `favicon` are `site:general`, `loginBg` is `site:login`), which a route-level list can't
        express. Checked in the handler via `checkSiteAdminAccess`, over `SITE_IMAGE_KIND_PERMISSIONS`.
      */
      schema: {
        summary: "Replace one of a site's images",
        description: `Requires \`manage:sites\`, or \`site:general\` for \`logo\`/\`favicon\` and \`site:login\` for \`loginBg\` on this site.\n\nThe body is the raw image, not a multipart form — send the file itself with its \`Content-Type\`. At most ${imageUploadLimit / 1024 / 1024} MB, and it must really be one of the accepted formats: the bytes are checked, not the declared type.\n\nA raster upload is re-encoded to the size and format the image is served at — 512x512 WebP for a logo, 180x180 PNG for a favicon, 1920x1080 WebP for a login background — when the Sharp extension is installed, and stored as uploaded when it is not. An SVG is always stored as uploaded.\n\nServed afterwards from \`/_site/<siteId>/<kind>\`, which falls back to the built-in default until something is uploaded.`,
        tags: ['Sites'],
        consumes: [...imageMimeTypes, svgMimeType],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            kind: {
              type: 'string',
              description: 'Which of the site images to replace.',
              enum: [...siteAssetKinds]
            }
          },
          required: ['siteId', 'kind']
        },
        response: {
          200: {
            description: 'Image uploaded successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      const kindPermission = SITE_IMAGE_KIND_PERMISSIONS[req.params.kind]
      if (!maySiteAdmin(req, 'manage:sites', kindPermission, req.params.siteId)) {
        return reply.forbidden()
      }

      const data = req.body
      if (!Buffer.isBuffer(data) || data.length < 1) {
        throw new CustomError('siteImageEmpty', 'No image was sent.')
      }
      // -> The declared content type got the request this far; what the bytes actually are is what
      //    decides, since they are what gets stored and served back
      if (!detectImageMime(data) && !detectSvg(data)) {
        throw new CustomError(
          'siteImageInvalidImage',
          'Not an SVG, PNG, JPEG, WebP or GIF image, whatever the request said it was.'
        )
      }

      await WIKI.models.sites.setAsset(req.params.siteId, req.params.kind, data)

      return {
        ok: true,
        message: 'Image uploaded successfully.'
      }
    }
  )

  /**
   * CLEAR SITE IMAGE
   */
  app.delete<{ Params: { siteId: string; kind: SiteAssetKind } }>(
    '/:siteId/images/:kind',
    {
      /*
        No route-level `permissions`: same reasoning as the PUT above — `kind` decides which `site:*`
        permission applies, checked in the handler via `checkSiteAdminAccess`.
      */
      schema: {
        summary: "Remove one of a site's images",
        description:
          'Requires `manage:sites`, or `site:general` for `logo`/`favicon` and `site:login` for `loginBg` on this site.\n\nLeaves the built-in default to be served in its place again. Succeeds even if there was no image to remove.',
        tags: ['Sites'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            kind: {
              type: 'string',
              description: 'Which of the site images to remove.',
              enum: [...siteAssetKinds]
            }
          },
          required: ['siteId', 'kind']
        },
        response: {
          200: {
            description: 'Image cleared successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      const kindPermission = SITE_IMAGE_KIND_PERMISSIONS[req.params.kind]
      if (!maySiteAdmin(req, 'manage:sites', kindPermission, req.params.siteId)) {
        return reply.forbidden()
      }

      await WIKI.models.sites.clearAsset(req.params.siteId, req.params.kind)

      return {
        ok: true,
        message: 'Image cleared successfully.'
      }
    }
  )

  /**
   * DELETE SITE
   */
  app.delete<{ Params: { siteId: string } }>(
    '/:siteId',
    {
      /*
        Deliberately still a route-level, global-only gate: deleting a site is one of
        `AdminSites.vue`'s own site-management actions (alongside create and enable/disable), not one
        of the eight delegable `site:*` settings surfaces in
        `docs/decisions/delegated-per-site-administration.md` §3, so there is no site-scoped
        permission for `config.permissions` to be unable to express here — `manage:sites` says the
        whole of it, same as before.
      */
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Delete a site',
        tags: ['Sites'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          204: {
            description: 'Site deleted successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            $ref: 'ApiError#',
            description: 'This is the last remaining site, or it still holds content.'
          }
        }
      }
    },
    async (req, reply) => {
      try {
        if ((await WIKI.models.sites.countSites()) <= 1) {
          reply.conflict('Cannot delete the last site. At least 1 site must exist at all times.')
        } else if (await WIKI.models.sites.deleteSite(req.params.siteId)) {
          reply.code(204)
        } else {
          reply.notFound('Site does not exist.')
        }
      } catch (err: any) {
        // -> `deleteSite()` precounts pages/assets and refuses before touching anything, so this is
        //    the normal way a still-content-holding site is refused -- reported as a conflict, not a
        //    server fault.
        if (err.name === 'siteHasContent') {
          return reply.conflict(err.message)
        }
        // -> Backstop only: pages, assets, navigation and the page tree all reference the site without
        //    a cascade, so a FK violation here means content was inserted in the race between
        //    `deleteSite()`'s precheck and its transaction actually committing -- still a conflict to
        //    report, not a server fault. `deleteSite()`'s own transaction has already rolled back
        //    everything else it touched.
        if (err.cause?.code === '23503' || err.code === '23503') {
          return reply.conflict('Cannot delete this site: it still holds pages or assets.')
        }
        reply.send(err)
      }
    }
  )
}

export default routes
