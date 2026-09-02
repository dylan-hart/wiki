import type { FastifyInstance } from 'fastify'
import type { GlossaryExport, GlossaryExportTermInput } from '../models/glossary.ts'
import { actorFromRequest } from '../models/auditLog.ts'

interface GlossaryTermBody {
  term?: string
  definition?: string
  aliases?: string[]
  pageId?: string | null
}

/**
 * Glossary API Routes (OpenProject #870)
 *
 * Every admin route (list/create/update/delete, export/import, save, versions) is gated behind its
 * own `manage:glossary` global permission (OpenProject #1116) -- not `manage:sites`, which also
 * grants site creation/deletion/config editing, far more than glossary management needs.
 * `manage:system` still bypasses every check regardless, per the shared permission hook. `GET
 * .../terms` is the one exception: it carries no route-level permission, the same way `api/tags.ts`
 * doesn't, because it is what the editor's own live preview and save-time render pull from to match
 * against — refusing it there would refuse rendering, not just the admin screen.
 *
 * The single-term create/update/delete routes below have no in-repo caller — the admin UI stages
 * edits locally and applies them wholesale through `.../glossary/save` instead (see that route's own
 * comment) — but they remain a legitimate programmatic surface for an API-key client to manage one
 * term at a time. `models/glossary.ts`'s `createTerm`/`updateTerm`/`deleteTerm` now each record a
 * `glossary_versions` snapshot in the same transaction as the write (OpenProject #1891), so a write
 * through one of these routes is no longer invisible to a later "restore previous version".
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST GLOSSARY TERMS
   */
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
      return WIKI.models.glossary.listTerms(req.params.siteId)
    }
  )

  /**
   * LIST RESOLVED TERMS FOR RENDERING
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/glossary/terms',
    {
      /*
        No route-level permissions, and genuinely public -- a term's name and definition are not
        gated content, the same way an Iconify icon isn't (see CLAUDE.md's Icons section). This is
        the cached, resolved list the rendering pipeline matches against (see
        `renderers/modules/markdown-it-glossary.js`), fetched by the editor itself so its live preview
        and the render it saves stay in step with what a reader will eventually see. Each term's
        `link` IS gated, though (OpenProject #1127): `getCachedTerms` resolves it against the calling
        actor's own `read:pages` access, so an editor with no access to a term's canonical page gets
        `link: null` for it -- the page's title/existence never leaks into a render this route feeds.
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
      return WIKI.models.glossary.getCachedTerms(
        req.params.siteId,
        WIKI.models.groups.actorForRequest(req)
      )
    }
  )

  /**
   * CREATE GLOSSARY TERM
   */
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
      return WIKI.models.glossary.createTerm(
        req.params.siteId,
        {
          term: req.body.term!,
          definition: req.body.definition!,
          aliases: req.body.aliases,
          pageId: req.body.pageId
        },
        actorFromRequest(req)
      )
    }
  )

  /**
   * UPDATE GLOSSARY TERM
   */
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
      return WIKI.models.glossary.updateTerm(
        req.params.siteId,
        req.params.termId,
        {
          term: req.body.term,
          definition: req.body.definition,
          aliases: req.body.aliases,
          pageId: req.body.pageId
        },
        actorFromRequest(req)
      )
    }
  )

  /**
   * DELETE GLOSSARY TERM
   */
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
      const deleted = await WIKI.models.glossary.deleteTerm(
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

  /**
   * EXPORT GLOSSARY AS JSON
   */
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
      return WIKI.models.glossary.exportTerms(req.params.siteId)
    }
  )

  /**
   * IMPORT GLOSSARY FROM JSON
   */
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
      return WIKI.models.glossary.importTerms(req.params.siteId, req.body)
    }
  )

  /**
   * SAVE STAGED GLOSSARY EDITS
   */
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
      return WIKI.models.glossary.saveVersion(
        req.params.siteId,
        req.body.terms,
        actorFromRequest(req)
      )
    }
  )

  /**
   * LIST GLOSSARY VERSIONS
   */
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
      return WIKI.models.glossary.listVersions(req.params.siteId)
    }
  )

  /**
   * GET ONE GLOSSARY VERSION
   */
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
      const version = await WIKI.models.glossary.getVersion(req.params.siteId, req.params.versionId)
      if (!version) {
        return reply.notFound('This glossary version does not exist.')
      }
      return version
    }
  )

  /**
   * RESTORE A GLOSSARY VERSION
   */
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
      return WIKI.models.glossary.restoreVersion(
        req.params.siteId,
        req.params.versionId,
        actorFromRequest(req)
      )
    }
  )
}

export default routes
