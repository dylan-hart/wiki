import { and, count, eq, inArray } from 'drizzle-orm'
import { pages as pagesTable } from '../db/schema.ts'
import { CustomError, requestOrigin } from '../helpers/common.ts'
import { defaultLocale } from '../helpers/localeRouting.ts'
import { resolveSiteParam } from '../helpers/siteResolution.ts'
import { detectImageMime, detectSvg, imageMimeTypes, svgMimeType } from '../helpers/images.ts'
import { absoluteRedirectsAllowed, isFollowableRedirectTarget } from '../helpers/redirectTarget.ts'
import { maySiteAdmin, SITE_PERMISSIONS } from '../helpers/siteRules.ts'
import { actorFromRequest } from '../models/auditLog.ts'
import { siteAssetKinds } from '../models/sites.ts'
import type { SiteAssetKind } from '../models/sites.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

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
  'banner',
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
  'security',
  'theme',
  'uploads'
] as const

/**
 * Which `site:*` permission governs each key `PUT /:siteId` can touch. Several admin surfaces write
 * through that one route, so the check is per body key rather than per route. A key with no entry
 * (such as `isEnabled`) is deliberately not delegable: it stays `manage:sites`-only.
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
  banner: 'site:general',
  pageExtensions: 'site:general',
  allowedUrlSchemes: 'site:general',
  logoText: 'site:general',
  sitemap: 'site:general',
  discoverable: 'site:general',
  defaults: 'site:general',
  features: 'site:general',
  robots: 'site:general',
  security: 'site:general',
  uploads: 'site:general',
  auth: 'site:login',
  authStrategies: 'site:login',
  locales: 'site:locale',
  editors: 'site:editors',
  theme: 'site:theme'
}

const SITE_IMAGE_KIND_PERMISSIONS: Record<SiteAssetKind, string> = {
  logo: 'site:general',
  favicon: 'site:general',
  loginBg: 'site:login'
}

/**
 * Deliberately does NOT fold in `manage:sites`, `manage:theme` or `manage:navigation`: each covers
 * a different subset of the site surfaces, so folding one in would report a permission a specific
 * route would still refuse. The frontend holds those globals already and combines them itself
 * (`frontend/src/composables/siteAdminAccess.js`).
 */
function sitePermissionsFor(req: FastifyRequest, siteId: string): string[] {
  const actor = CARDINAL.models.groups.actorForRequest(req)
  if (actor.permissions.includes('manage:system')) {
    return SITE_PERMISSIONS
  }
  return SITE_PERMISSIONS.filter((permission) =>
    CARDINAL.models.groups.checkSiteAccess(actor, permission, siteId)
  )
}

/**
 * The single place the instance-wide pgvector capability and the site's own toggle are combined:
 * consumers read `features.semanticSearch` off the site-info response rather than re-deriving it.
 * `CARDINAL.capabilities` is absent on a `CARDINAL` that never ran the db boot step (a test stub),
 * which reads as `false`.
 */
function semanticSearchAvailable(config: Record<string, any>): boolean {
  return (
    CARDINAL.capabilities?.semanticSearch === true &&
    config.search?.config?.semanticEnabled === true
  )
}

/**
 * Every `site.config` key reaching the response is named explicitly rather than spread in: both
 * callers are `publicAccess: true`, and `config.search` holds the active search engine's
 * credentials. `schemas/site.test.ts` pins the allow-list.
 *
 * `commentsProvider` is non-null only for a `codeTemplate` provider; its `origin` comes from the
 * request this payload is built for, never a stored setting. Its (masked) config is site-wide admin
 * configuration, so sending it to every reader is not a `read:comments` leak.
 *
 * `navigationId` is public here because a non-content route (the knowledge graph, tags browse)
 * never fetches a page, the only other place a browser learns it.
 */
export async function buildSitePayload(
  site: {
    id: string
    hostname: string
    isEnabled: boolean
    config: Record<string, any>
  },
  req?: Pick<FastifyRequest, 'protocol' | 'hostname'>
): Promise<Record<string, any>> {
  const { blocksConfig, blocksIndex } = await siteBlocksInfoFor(site.id)
  const config = site.config
  const activeProvider = await CARDINAL.models.commentProviders.getActiveProvider(site.id)
  return {
    id: site.id,
    hostname: site.hostname,
    isEnabled: site.isEnabled,
    pdfExportAvailable: await CARDINAL.models.renderQueue.isAvailable(),
    docsBase: CARDINAL.config.docsBase,
    isReplicationEnabled: CARDINAL.config.replication?.isEnabled === true,
    navigationId: await CARDINAL.models.navigation.ensureSiteNav(site.id, defaultLocale(site.id)),
    // -> `req` is optional only so a test need not fabricate one; a real caller always passes it.
    commentsProvider:
      req && activeProvider?.codeTemplate
        ? {
            module: activeProvider.module,
            title: activeProvider.title,
            config: activeProvider.config,
            origin: requestOrigin(req.protocol, req.hostname)
          }
        : null,
    blocksConfig,
    blocksIndex,
    title: config.title,
    description: config.description,
    company: config.company,
    contentLicense: config.contentLicense,
    footerExtra: config.footerExtra,
    banner: config.banner,
    pageExtensions: config.pageExtensions,
    allowedUrlSchemes: config.allowedUrlSchemes,
    discoverable: config.discoverable,
    defaults: config.defaults,
    features: {
      ...config.features,
      semanticSearch: semanticSearchAvailable(config)
    },
    uploads: config.uploads,
    logoText: config.logoText,
    sitemap: config.sitemap,
    pathDisplayCase: config.pathDisplayCase,
    robots: config.robots,
    security: config.security,
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
 * `GET /sites/:siteId/blocks` is gated to authors and administrators, so a page reader's browser
 * gets both of these on the public site-info response instead: `blocksConfig` is a block's
 * site-wide config, `blocksIndex` the `id`/`isCustom` a custom block's import URL is built from.
 *
 * Enabled blocks only: neither a disabled block's config nor a URL to its code may reach a reader.
 */
async function siteBlocksInfoFor(
  siteId: string
): Promise<{ blocksConfig: Record<string, object>; blocksIndex: Record<string, object> }> {
  const siteBlocks = await CARDINAL.models.blocks.getSiteBlocks(siteId)
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
      const sites = await CARDINAL.models.sites.getAllSites()
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
        // -> `commentsProvider.origin` reflects THIS request's host, which is right only when
        //    `siteIdorHostname` names the site being browsed. A caller naming a DIFFERENT site by
        //    id gets its own origin back, not that site's.
        return buildSitePayload(site, req)
      } else {
        return reply.notFound('Site does not exist.')
      }
    }
  )

  app.get<{ Params: { siteId: string } }>(
    '/:siteId/userPermissions',
    {
      /*
        No route-level `permissions`: this answers what the caller may do, which for an anonymous or
        under-permissioned caller is an empty array rather than a 403.
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
    async (req) => {
      // -> hostname is validated by the body schema's `pattern`
      if (!req.body.title || req.body.title.length < 1 || !/^[^<>"]+$/.test(req.body.title)) {
        throw new CustomError('siteCreateInvalidTitle', 'Invalid Site Title')
      }

      if (!(await CARDINAL.models.sites.isHostnameUnique(req.body.hostname))) {
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

      const result = await CARDINAL.models.sites.createSite(req.body.hostname, {
        title: req.body.title
      })
      return {
        ok: true,
        message: 'Site created successfully.',
        id: result.id
      }
    }
  )

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
      banner?: { isEnabled?: boolean; title?: string; content?: string }
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
      security?: { embedAllowedOrigins?: string[] }
      theme?: Record<string, any>
      uploads?: Record<string, any>
    }
  }>(
    '/:siteId',
    {
      /*
        No route-level `permissions`: different `site:*` permissions gate different keys of the same
        body (see `SITE_FIELD_PERMISSIONS`), and `config.permissions` reads only the group-wide
        session list, so it cannot express a site-scoped permission. Checked in the handler instead.
      */
      schema: {
        summary: 'Update a site',
        description:
          'Requires `manage:sites`, or — per key touched — the matching `site:*` permission on this site: `site:general` for `hostname`/`title`/`description`/`company`/`contentLicense`/`footerExtra`/`banner`/`pageExtensions`/`allowedUrlSchemes`/`logoText`/`sitemap`/`discoverable`/`defaults`/`features`/`robots`/`security`/`uploads`, `site:theme` for `theme`, `site:login` for `auth`/`authStrategies`, `site:locale` for `locales`, `site:editors` for `editors`. `isEnabled` is not delegable and always requires `manage:sites`. The instance-wide `manage:theme` permission (see task #681) also covers a patch that touches nothing but `theme`.',
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
            banner: {
              $ref: 'Site#/properties/banner'
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
            security: {
              $ref: 'Site#/properties/security'
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
      const actor = CARDINAL.models.groups.actorForRequest(req)
      if (
        !actor.permissions.includes('manage:system') &&
        !actor.permissions.includes('manage:sites')
      ) {
        const touchedKeys = Object.keys(req.body) as (
          | (typeof SITE_CONFIG_KEYS)[number]
          | 'hostname'
          | 'isEnabled'
        )[]
        // -> The instance-wide `manage:theme` grant covers only a patch that touches nothing but
        //    `theme` — anything broader falls through to the per-key check below.
        const maySaveThemeOnly =
          actor.permissions.includes('manage:theme') &&
          touchedKeys.length > 0 &&
          touchedKeys.every((key) => key === 'theme')
        if (!maySaveThemeOnly) {
          const missingPermission = touchedKeys.some((key) => {
            const required = SITE_FIELD_PERMISSIONS[key]
            // -> A key with no `site:*` permission stays `manage:sites`-only -- reaching this
            //    branch already means that's absent.
            if (!required) {
              return true
            }
            return !CARDINAL.models.groups.checkSiteAccess(actor, required, req.params.siteId)
          })
          if (missingPermission) {
            return reply.forbidden()
          }
        }
      }

      if (req.body.title !== undefined && !/^[^<>"]+$/.test(req.body.title)) {
        throw new CustomError('siteUpdateInvalidTitle', 'Invalid Site Title')
      }

      // -> All three are handed straight to the browser as navigation targets, so a `javascript:`
      //    (or any other non-http(s)) value must be refused.
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

      const site = await CARDINAL.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }

      // -> With no site left enabled, every hostname would stop resolving.
      if (
        req.body.isEnabled === false &&
        site.isEnabled &&
        (await CARDINAL.models.sites.countEnabledSites()) <= 1
      ) {
        return reply.conflict(
          'Cannot disable the last enabled site. At least 1 site must remain enabled at all times.'
        )
      }

      if (
        req.body.hostname !== undefined &&
        req.body.hostname !== site.hostname &&
        !(await CARDINAL.models.sites.isHostnameUnique(req.body.hostname))
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

      // -> Validated against what the site ends up with once the patch is merged, so that a partial
      //    update cannot leave the primary locale inactive
      if (req.body.locales) {
        const installedCodes = (await CARDINAL.models.locales.getLocales()).map(
          (lc: any) => lc.code
        )
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
        //    the file manager and search. Only PAGES are counted, deliberately: a folder or asset
        //    left behind orphans no reachable URL.
        const removedLocales = (site.config.locales?.active ?? []).filter(
          (code: string) => !active.includes(code)
        )
        if (removedLocales.length > 0) {
          const counts = await CARDINAL.db
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

      const config: Record<string, any> = {}
      for (const key of SITE_CONFIG_KEYS) {
        if (req.body[key] !== undefined) {
          config[key] = req.body[key]
        }
      }

      await CARDINAL.models.sites.updateSite(req.params.siteId, {
        hostname: req.body.hostname,
        isEnabled: req.body.isEnabled,
        ...(Object.keys(config).length < 1 ? {} : { config })
      })
      await CARDINAL.models.auditLog.record({
        event: 'site.settingsUpdated',
        actor: actorFromRequest(req),
        targetType: 'site',
        targetId: req.params.siteId,
        targetLabel: req.body.title ?? site.config.title,
        detail: {
          changedFields: Object.keys(req.body)
        },
        siteId: req.params.siteId
      })
      return {
        ok: true,
        message: 'Site updated successfully.'
      }
    }
  )

  app.put<{ Params: { siteId: string; kind: SiteAssetKind } }>(
    '/:siteId/images/:kind',
    {
      /*
        No route-level `permissions`: which `site:*` permission applies depends on `kind` (see
        `SITE_IMAGE_KIND_PERMISSIONS`), which a route-level list can't express. Checked in the
        handler.
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
      const site = await CARDINAL.models.sites.getSiteById({ id: req.params.siteId })
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

      await CARDINAL.models.sites.setAsset(req.params.siteId, req.params.kind, data)

      return {
        ok: true,
        message: 'Image uploaded successfully.'
      }
    }
  )

  app.delete<{ Params: { siteId: string; kind: SiteAssetKind } }>(
    '/:siteId/images/:kind',
    {
      /*
        No route-level `permissions`: as for the PUT above, `kind` decides which `site:*` permission
        applies. Checked in the handler.
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
      const site = await CARDINAL.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      const kindPermission = SITE_IMAGE_KIND_PERMISSIONS[req.params.kind]
      if (!maySiteAdmin(req, 'manage:sites', kindPermission, req.params.siteId)) {
        return reply.forbidden()
      }

      await CARDINAL.models.sites.clearAsset(req.params.siteId, req.params.kind)

      return {
        ok: true,
        message: 'Image cleared successfully.'
      }
    }
  )

  app.delete<{ Params: { siteId: string } }>(
    '/:siteId',
    {
      /*
        Deliberately a route-level, global-only gate: deleting a site is a site-management action,
        like create and enable/disable, not one of the delegable `site:*` settings surfaces.
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
        if ((await CARDINAL.models.sites.countSites()) <= 1) {
          reply.conflict('Cannot delete the last site. At least 1 site must exist at all times.')
        } else if (await CARDINAL.models.sites.deleteSite(req.params.siteId)) {
          reply.code(204)
        } else {
          reply.notFound('Site does not exist.')
        }
      } catch (err: any) {
        // -> `deleteSite()` precounts pages/assets and refuses before touching anything: the normal
        //    way a content-holding site is refused -- a conflict, not a server fault.
        if (err.name === 'siteHasContent') {
          return reply.conflict(err.message)
        }
        // -> Backstop only: content references the site without a cascade, so a FK violation means
        //    something was inserted between `deleteSite()`'s precheck and its commit -- still a
        //    conflict, and its transaction has already rolled back everything else.
        if (err.cause?.code === '23503' || err.code === '23503') {
          return reply.conflict('Cannot delete this site: it still holds pages or assets.')
        }
        reply.send(err)
      }
    }
  )
}

export default routes
