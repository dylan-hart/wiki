import type { FastifyInstance } from 'fastify'
import type { GlossaryAlias, GlossaryExport, GlossaryExportTermInput } from '../models/glossary.ts'
import { actorFromRequest } from '../models/auditLog.ts'
import { actorFrom } from '../helpers/pageAccess.ts'
import { limitRenders } from '../helpers/rateLimit.ts'

interface GlossaryTermBody {
  term?: string
  definition?: string
  aliases?: GlossaryAlias[]
  isAcronym?: boolean
  pageId?: string | null
}

/**
 * Admin routes are gated on `manage:glossary` rather than `manage:sites`, which grants far more
 * than glossary management needs.
 *
 * The single-term create/update/delete routes have no in-repo caller -- the admin UI applies its
 * staged edits wholesale through `.../glossary/save` -- and stay as the API surface for managing
 * one term at a time.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/glossary',
    {
      config: {
        permissions: ['manage:glossary']
      },
      schema: {
        summary: 'List a site’s glossary terms',
        tags: ['Glossary'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Glossary terms, alphabetical',
            type: 'array',
            items: { $ref: 'GlossaryTerm#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.glossary.listTerms(req.params.siteId)
    }
  )

  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/glossary/terms',
    {
      /*
        No route-level permissions, and public: a term's name and definition are not gated content,
        and the editor's live preview and save-time render both match against this list. Each term's
        `link` IS gated: `getCachedTerms` resolves it against the actor's own `read:pages`, so a
        canonical page's existence never leaks through it.
      */
      schema: {
        summary: 'List the resolved glossary terms the rendering pipeline matches against',
        description:
          'Cached, and invalidated on every term create/update/delete. Empty when the site has no glossary terms defined — which is also how the feature degrades to plain text.',
        tags: ['Glossary'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Resolved glossary terms',
            type: 'array',
            items: { $ref: 'GlossaryRenderTerm#' }
          },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.glossary.getCachedTerms(
        req.params.siteId,
        CARDINAL.models.groups.actorForRequest(req)
      )
    }
  )

  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/glossary/acronyms',
    {
      /*
        No route-level permissions: an acronym's casing carries no page-access sensitivity, and the
        frontend's path-segment humanizer reads this on every page, not only in the admin area.
      */
      schema: {
        summary: 'The site’s acronym lookup, for the path-segment humanizer',
        description:
          'A lowercase-surface-form → canonical-display-casing map, built from every glossary term/alias marked as an acronym. Cached the same way, and invalidated on the same schedule, as `GET .../glossary/terms`.',
        tags: ['Glossary'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: { $ref: 'GlossaryAcronymMap#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.glossary.getAcronymMap(req.params.siteId)
    }
  )

  app.post<{ Params: { siteId: string }; Body: GlossaryTermBody }>(
    '/sites/:siteId/glossary',
    {
      config: {
        permissions: ['manage:glossary']
      },
      schema: {
        summary: 'Create a glossary term',
        tags: ['Glossary'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          allOf: [
            { $ref: 'GlossaryTermInput#' },
            { type: 'object', required: ['term', 'definition'] }
          ]
        },
        response: {
          200: { $ref: 'GlossaryTerm#' },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.glossary.createTerm(
        req.params.siteId,
        {
          term: req.body.term!,
          definition: req.body.definition!,
          aliases: req.body.aliases,
          isAcronym: req.body.isAcronym,
          pageId: req.body.pageId
        },
        actorFromRequest(req)
      )
    }
  )

  app.put<{ Params: { siteId: string; termId: string }; Body: GlossaryTermBody }>(
    '/sites/:siteId/glossary/:termId',
    {
      config: {
        permissions: ['manage:glossary']
      },
      schema: {
        summary: 'Update a glossary term',
        description: 'Accepts any subset of the fields.',
        tags: ['Glossary'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            termId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'termId']
        },
        body: { $ref: 'GlossaryTermInput#' },
        response: {
          200: { $ref: 'GlossaryTerm#' },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.glossary.updateTerm(
        req.params.siteId,
        req.params.termId,
        {
          term: req.body.term,
          definition: req.body.definition,
          aliases: req.body.aliases,
          isAcronym: req.body.isAcronym,
          pageId: req.body.pageId
        },
        actorFromRequest(req)
      )
    }
  )

  app.delete<{ Params: { siteId: string; termId: string } }>(
    '/sites/:siteId/glossary/:termId',
    {
      config: {
        permissions: ['manage:glossary']
      },
      schema: {
        summary: 'Delete a glossary term',
        tags: ['Glossary'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            termId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'termId']
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const deleted = await CARDINAL.models.glossary.deleteTerm(
        req.params.siteId,
        req.params.termId,
        actorFromRequest(req)
      )
      if (!deleted) {
        return reply.notFound('This glossary term does not exist.')
      }
      return { ok: true }
    }
  )

  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/glossary/export',
    {
      config: {
        permissions: ['manage:glossary']
      },
      schema: {
        summary: 'Export the glossary as portable JSON',
        description:
          'Every term, carrying its canonical page as a `path` rather than a `pageId` -- portable across instances, and round-trippable through `POST .../glossary/import` after external editing (OpenProject #1114).',
        tags: ['Glossary'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: { $ref: 'GlossaryExport#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.glossary.exportTerms(req.params.siteId)
    }
  )

  app.post<{ Params: { siteId: string }; Body: GlossaryExport }>(
    '/sites/:siteId/glossary/import',
    {
      config: {
        permissions: ['manage:glossary']
      },
      schema: {
        summary: 'Replace the glossary wholesale from portable JSON',
        description:
          'The imported term list REPLACES the entire existing glossary -- not a per-term merge. Every entry is validated, and every `path` resolved to a page, before anything is written, so a bad entry anywhere in the payload leaves the existing glossary untouched (OpenProject #1114).',
        tags: ['Glossary'],
        params: { $ref: 'SiteIdParams#' },
        body: { $ref: 'GlossaryExport#' },
        response: {
          200: {
            description: 'The glossary as it now stands',
            type: 'array',
            items: { $ref: 'GlossaryTerm#' }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.glossary.importTerms(req.params.siteId, req.body)
    }
  )

  app.post<{ Params: { siteId: string }; Body: { terms: GlossaryExportTermInput[] } }>(
    '/sites/:siteId/glossary/save',
    {
      config: {
        permissions: ['manage:glossary']
      },
      schema: {
        summary: 'Apply staged glossary edits and save a new version',
        description:
          "The admin glossary screen's Save action (OpenProject #1113): edits are staged locally and NOT applied to the live glossary until this is called, which atomically replaces the whole term list with `terms` and records the result as a new version. Not a per-term merge -- the same wholesale-replace semantics, and the same `GlossaryExportTerm` shape (`path`, not `pageId`), as `POST .../glossary/import` -- the admin UI's own canonical-page picker is a live-validated path input, not a dropdown (OpenProject #1112), so its staged edits are already in this shape.",
        tags: ['Glossary'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['terms'],
          properties: {
            terms: {
              type: 'array',
              items: { $ref: 'GlossaryExportTerm#' }
            }
          }
        },
        response: {
          200: { $ref: 'GlossarySaveResult#' },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.glossary.saveVersion(
        req.params.siteId,
        req.body.terms,
        actorFromRequest(req)
      )
    }
  )

  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/glossary/versions',
    {
      config: {
        permissions: ['manage:glossary']
      },
      schema: {
        summary: 'List saved glossary versions',
        description:
          'Whole-glossary snapshots (OpenProject #1113), most recent first -- not the per-term history `pageHistory` keeps for individual pages. Metadata only; fetch one by id for its full term list.',
        tags: ['Glossary'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            type: 'array',
            items: { $ref: 'GlossaryVersionSummary#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.glossary.listVersions(req.params.siteId)
    }
  )

  app.get<{ Params: { siteId: string; versionId: string } }>(
    '/sites/:siteId/glossary/versions/:versionId',
    {
      config: {
        permissions: ['manage:glossary']
      },
      schema: {
        summary: 'Get a saved glossary version, including its full term list',
        tags: ['Glossary'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            versionId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'versionId']
        },
        response: {
          200: { $ref: 'GlossaryVersion#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const version = await CARDINAL.models.glossary.getVersion(
        req.params.siteId,
        req.params.versionId
      )
      if (!version) {
        return reply.notFound('This glossary version does not exist.')
      }
      return version
    }
  )

  /**
   * Gated on `manage:glossary` rather than a per-page `write:pages` check, unlike
   * `POST .../pages/bulk`'s `render` action: this is not a caller-picked selection of pages but
   * everything the glossary can affect -- the reach every other glossary route already carries.
   */
  app.post<{ Params: { siteId: string } }>(
    '/sites/:siteId/glossary/rerender-all-pages',
    {
      config: {
        permissions: ['manage:glossary']
      },
      // -> One call can queue a browser render for every page on the site.
      preHandler: limitRenders,
      schema: {
        summary: 'Queue every page of a site to be rendered again from its source',
        description:
          'For applying a glossary change (or any other render-time content) across the whole site immediately, rather than waiting on each page\'s own next save. Queues every markdown-editor page through the same render queue `POST .../pages/:pageId/render` uses -- not a scoped "only pages that mention this term" operation, and not a new rendering mechanism. Answers 202: a browser is too heavy to hold a request open for, so pages join a queue drained one at a time. Needs the Puppeteer extension, and answers 503 without it.',
        tags: ['Glossary'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          202: {
            description: 'Every markdown page on the site queued for rendering',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              queued: { type: 'integer', description: 'How many pages were queued.' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Rerendering pages requires a logged in user.')
      }
      const queued = await CARDINAL.models.pages.queueRerenderAllPages(req.params.siteId, actor)
      return reply.code(202).send({ ok: true, queued })
    }
  )

  app.post<{ Params: { siteId: string; versionId: string } }>(
    '/sites/:siteId/glossary/versions/:versionId/restore',
    {
      config: {
        permissions: ['manage:glossary']
      },
      schema: {
        summary: 'Restore a saved glossary version as the live glossary',
        description:
          'Applies that version’s term list wholesale, THEN records the result as a new version of its own -- the version list stays append-only, so restoring never rewrites history retroactively.',
        tags: ['Glossary'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            versionId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'versionId']
        },
        response: {
          200: { $ref: 'GlossarySaveResult#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return CARDINAL.models.glossary.restoreVersion(
        req.params.siteId,
        req.params.versionId,
        actorFromRequest(req)
      )
    }
  )
}

export default routes
