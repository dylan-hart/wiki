import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PageTemplateInput, PageTemplatePatch } from '../models/pageTemplates.ts'
import type { RenderPermissions } from '../helpers/htmlSanitizePolicy.ts'
import { actorFrom, mayOnPage } from '../helpers/pageAccess.ts'
import { defaultLocale } from '../helpers/localeRouting.ts'
import { maySiteAdmin } from '../helpers/siteRules.ts'

interface SiteParams {
  siteId: string
}

interface TemplateParams extends SiteParams {
  templateId: string
}

function authorPermissions(
  req: FastifyRequest,
  siteId: string,
  locale: string | null | undefined
): RenderPermissions {
  const page = { path: '', locale: locale ?? defaultLocale(siteId) }
  return {
    scripts: mayOnPage(req, 'write:scripts', siteId, page),
    styles: mayOnPage(req, 'write:styles', siteId, page)
  }
}

const templateParams = {
  type: 'object',
  properties: {
    siteId: { type: 'string', format: 'uuid' },
    templateId: { type: 'string', format: 'uuid' }
  },
  required: ['siteId', 'templateId']
}

/**
 * No route-level permissions: `write:pages` is a page permission and `site:templates` a site one,
 * neither of which the `config.permissions` hook can check, so each handler asks in its own body.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: SiteParams; Querystring: { basePath?: string; locale?: string } }>(
    '/sites/:siteId/page-templates',
    {
      schema: {
        summary: 'List the page templates offered for a new page',
        description:
          'With `basePath` (the folder the new page is being created under, empty for the site root) and optionally `locale`, requires `write:pages` at that path and locale, and lists the templates for that locale: the all-locale ones plus its own. A holder of `manage:sites` or `site:templates` on the site may instead omit `basePath` to list every template the site holds, for the admin screen.',
        tags: ['Page Templates'],
        params: { $ref: 'SiteIdParams#' },
        querystring: {
          type: 'object',
          properties: {
            basePath: { type: 'string', maxLength: 1024 },
            locale: { type: 'string', minLength: 1, maxLength: 255 }
          }
        },
        response: {
          200: {
            description: 'Templates, alphabetical by name',
            type: 'array',
            items: { $ref: 'PageTemplate#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const { siteId } = req.params
      const { basePath, locale } = req.query
      if (basePath === undefined && maySiteAdmin(req, 'manage:sites', 'site:templates', siteId)) {
        return CARDINAL.models.pageTemplates.list(siteId, locale)
      }
      const path = (basePath ?? '').replace(/^\/+|\/+$/g, '')
      if (
        !mayOnPage(req, 'write:pages', siteId, { path, locale: locale ?? defaultLocale(siteId) })
      ) {
        return reply.forbidden()
      }
      return CARDINAL.models.pageTemplates.list(siteId, locale ?? defaultLocale(siteId))
    }
  )

  app.post<{ Params: SiteParams; Body: PageTemplateInput }>(
    '/sites/:siteId/page-templates',
    {
      schema: {
        summary: 'Create a page template',
        description:
          'Requires `manage:sites`, or `site:templates` on this site. The content is sanitized against the saving author’s own `write:scripts` and `write:styles`.',
        tags: ['Page Templates'],
        params: { $ref: 'SiteIdParams#' },
        body: { $ref: 'PageTemplateInput#' },
        response: {
          200: { $ref: 'PageTemplate#' },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const { siteId } = req.params
      if (!maySiteAdmin(req, 'manage:sites', 'site:templates', siteId)) {
        return reply.forbidden()
      }
      return CARDINAL.models.pageTemplates.create(
        siteId,
        req.body,
        actorFrom(req)?.id ?? null,
        authorPermissions(req, siteId, req.body.locale)
      )
    }
  )

  app.put<{ Params: TemplateParams; Body: PageTemplatePatch }>(
    '/sites/:siteId/page-templates/:templateId',
    {
      schema: {
        summary: 'Update a page template',
        description:
          'Requires `manage:sites`, or `site:templates` on this site. Only the fields present are changed. `content` is sanitized again only when it is sent (or when a change of `editor` moves it to a different sanitizer).',
        tags: ['Page Templates'],
        params: templateParams,
        body: { $ref: 'PageTemplatePatch#' },
        response: {
          200: { $ref: 'PageTemplate#' },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const { siteId, templateId } = req.params
      if (!maySiteAdmin(req, 'manage:sites', 'site:templates', siteId)) {
        return reply.forbidden()
      }
      return CARDINAL.models.pageTemplates.update(
        siteId,
        templateId,
        req.body,
        authorPermissions(req, siteId, req.body.locale)
      )
    }
  )

  app.delete<{ Params: TemplateParams }>(
    '/sites/:siteId/page-templates/:templateId',
    {
      schema: {
        summary: 'Delete a page template',
        description: 'Requires `manage:sites`, or `site:templates` on this site.',
        tags: ['Page Templates'],
        params: templateParams,
        response: {
          200: {
            type: 'object',
            properties: { ok: { type: 'boolean' } }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const { siteId, templateId } = req.params
      if (!maySiteAdmin(req, 'manage:sites', 'site:templates', siteId)) {
        return reply.forbidden()
      }
      await CARDINAL.models.pageTemplates.delete(siteId, templateId)
      return { ok: true }
    }
  )
}

export default routes
