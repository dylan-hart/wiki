import type { FastifyInstance } from 'fastify'
import type { SearchEngine } from '../models/search.ts'

const DB_ENGINE_KEY = 'db'
const AUTO_TAG_MAX_TAGS_LIMIT = 20

async function withDbSearchExtras(
  engines: SearchEngine[],
  siteId: string
): Promise<SearchEngine[]> {
  const db = engines.find((eng) => eng.key === DB_ENGINE_KEY)
  if (db) {
    db.dictOverrides = CARDINAL.models.search.getConfig(siteId).dictOverrides
    db.availableDictionaries = await CARDINAL.models.search.getAvailableDictionaries()
  }
  return engines
}

/**
 * The general search settings (`dictOverrides`, `semanticEnabled`) hold no secret, so they take
 * `manage:sites` like the rest of a site's settings. An engine's config can hold credentials, so
 * the engine-picker routes take `manage:system`, as `api/storage.ts` does; `refresh` and the
 * rebuilds take it too, since a rebuild runs engine code.
 *
 * Semantic search is not an engine: it is always backed by Postgres/pgvector, whichever full-text
 * engine a site has selected.
 */
async function routes(app: FastifyInstance) {
  /**
   * `semanticEnabled: true` is refused here, not only greyed out in the admin UI, so a hand-crafted
   * request cannot store a setting the instance capability would never let take effect.
   */
  app.patch<{
    Params: { siteId: string }
    Body: {
      dictOverrides?: Record<string, string>
      semanticEnabled?: boolean
      autoTagThreshold?: number
      autoTagMaxTags?: number
    }
  }>(
    '/sites/:siteId/search',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Update the search configuration of a site',
        description:
          'Every dictionary named in `dictOverrides` must exist in this database, otherwise indexing would fail later, long after the setting was accepted. Changing a mapping affects pages the next time they are indexed — rebuild the index to apply it to existing content. `semanticEnabled` may only be set to `true` when semantic search is available on this instance. `autoTagThreshold` and `autoTagMaxTags` apply to pages auto-tagged after the change; tags already applied are left as they are.',
        tags: ['Search'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          properties: {
            dictOverrides: {
              type: 'object',
              description: 'Locale code to postgres dictionary. Replaces the stored mapping.',
              additionalProperties: { type: 'string' }
            },
            semanticEnabled: {
              type: 'boolean',
              description:
                'Whether semantic (embedding) search is enabled for this site. Rejected when `true` if semantic search is not available on this instance.'
            },
            autoTagThreshold: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description:
                "The minimum token-overlap score (0-1, higher means more overlap) an existing tag must reach against a page's text to be auto-applied to it. A fraction, not a distance: 0.15 means 15% overlap required."
            },
            autoTagMaxTags: {
              type: 'integer',
              minimum: 1,
              maximum: AUTO_TAG_MAX_TAGS_LIMIT,
              description: 'The most tags auto-tagging adds to any one page.'
            }
          }
        },
        response: {
          200: {
            description: 'Search configuration updated successfully',
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
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (
        req.body.dictOverrides === undefined &&
        req.body.semanticEnabled === undefined &&
        req.body.autoTagThreshold === undefined &&
        req.body.autoTagMaxTags === undefined
      ) {
        return reply.badRequest('No search settings provided to update.')
      }

      if (req.body.dictOverrides !== undefined) {
        const available = await CARDINAL.models.search.getAvailableDictionaries()
        for (const [locale, dictionary] of Object.entries(req.body.dictOverrides)) {
          if (!/^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/.test(locale)) {
            return reply.badRequest('ERR_INVALID_LOCALE_CODE')
          }
          if (!available.includes(dictionary)) {
            return reply.badRequest('ERR_INVALID_SEARCH_DICTIONARY')
          }
        }
      }

      if (req.body.semanticEnabled === true && !CARDINAL.capabilities?.semanticSearch) {
        return reply.badRequest('ERR_SEMANTIC_SEARCH_UNAVAILABLE')
      }

      const patch: Record<string, any> = {}
      if (req.body.dictOverrides !== undefined) {
        patch.dictOverrides = req.body.dictOverrides
      }
      if (req.body.semanticEnabled !== undefined) {
        patch.semanticEnabled = req.body.semanticEnabled
      }
      if (req.body.autoTagThreshold !== undefined) {
        patch.autoTagThreshold = req.body.autoTagThreshold
      }
      if (req.body.autoTagMaxTags !== undefined) {
        patch.autoTagMaxTags = req.body.autoTagMaxTags
      }

      const updated = await CARDINAL.models.sites.updateSite(req.params.siteId, {
        config: { search: { config: patch } }
      })
      if (!updated) {
        return reply.internalServerError('Failed to save the search configuration.')
      }

      return {
        ok: true,
        message: 'Search configuration updated successfully.'
      }
    }
  )

  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/search/semantic',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: "Get a site's semantic search and auto-tagging settings",
        description:
          "`available` reflects `CARDINAL.capabilities.semanticSearch` (instance-wide: whether pgvector is usable at all); `enabled` is this site's own stored setting, independent of `available`. The feature is reachable only when both are true. `autoTagThreshold` (a 0-1 overlap fraction, higher is stricter) and `autoTagMaxTags` tune auto-tagging, which runs on embedded page text and so only while semantic search is available.",
        tags: ['Search'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: "The site's semantic search setting",
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              available: { type: 'boolean' },
              autoTagThreshold: { type: 'number' },
              autoTagMaxTags: { type: 'integer' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const config = CARDINAL.models.search.getConfig(req.params.siteId)
      return {
        enabled: config.semanticEnabled,
        available: CARDINAL.capabilities?.semanticSearch ?? false,
        autoTagThreshold: config.autoTagThreshold,
        autoTagMaxTags: config.autoTagMaxTags
      }
    }
  )

  app.post<{ Params: { siteId: string } }>(
    '/sites/:siteId/search/rebuild-embeddings',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: "Rebuild a site's semantic search embeddings index",
        description:
          "Queues a job that re-runs the embedding pipeline for every page of this site, deleting and regenerating its passage-level embeddings. Runs in the background: the response only says the job was queued. Idempotent — running it twice leaves the same end state as running it once, since each page's embeddings are fully replaced rather than appended to.",
        tags: ['Search'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Rebuild queued successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              id: {
                type: 'string',
                format: 'uuid',
                description: 'ID of the queued job, which the scheduler view lists.'
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!CARDINAL.capabilities?.semanticSearch) {
        return reply.badRequest('ERR_SEMANTIC_SEARCH_UNAVAILABLE')
      }

      const added = await CARDINAL.scheduler.addJob({
        task: 'rebuildEmbeddingsIndex',
        payload: { siteId: req.params.siteId }
      })
      if (!added?.id) {
        return reply.internalServerError('The scheduler could not queue the rebuild.')
      }
      return {
        ok: true,
        message: 'Embeddings index rebuild queued successfully.',
        id: added.id
      }
    }
  )

  app.post<{ Params: { siteId: string } }>(
    '/sites/:siteId/search/rebuild',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Rebuild the search index of a site',
        description:
          'Queues a job that recomputes the search vector of every page of this site from its stored content, using the dictionary mapping in force. Runs in the background: the response only says the job was queued.',
        tags: ['Search'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Rebuild queued successfully',
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
                format: 'uuid',
                description: 'ID of the queued job, which the scheduler view lists.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const added = await CARDINAL.scheduler.addJob({
        task: 'rebuildSearchIndex',
        payload: { siteId: req.params.siteId }
      })
      if (!added?.id) {
        return reply.internalServerError('The scheduler could not queue the rebuild.')
      }
      return {
        ok: true,
        message: 'Search index rebuild queued successfully.',
        id: added.id
      }
    }
  )

  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/search/engines',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List the search engines available to a site',
        description:
          "One entry per search engine module installed in `modules/search`, whether or not it is the one currently selected. Configuration values may include a module's credentials, hence the `manage:system` requirement.",
        tags: ['Search'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'List of search engines',
            type: 'array',
            items: { $ref: 'SearchEngine#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return withDbSearchExtras(
        await CARDINAL.models.search.getSiteEngines(req.params.siteId, { mask: true }),
        req.params.siteId
      )
    }
  )

  app.put<{ Params: { siteId: string; key: string }; Body: { config?: Record<string, any> } }>(
    '/sites/:siteId/search/engines/:key',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: "Select a site's active search engine",
        description:
          "Makes the named engine the one queries and indexing dispatch to, and saves its config. Values are validated against what the engine's `definition.yml` declares; an unrecognized key, a value of the wrong type, a `required` prop left empty (e.g. Algolia's `apiKey`, Elasticsearch's `hosts`), or a value that fails a declared `pattern` (e.g. Elasticsearch's `hosts` shape) is refused, and nothing is written. Required/pattern checks run against the config that would actually end up stored -- incoming values merged onto what is already saved for this engine on this site -- so a value saved on an earlier request does not need to be resent just to keep validating. Config for an engine that is not selected is kept, so switching back to it later starts from what was last saved rather than from its bare defaults.",
        tags: ['Search'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            key: {
              type: 'string',
              maxLength: 255
            }
          },
          required: ['siteId', 'key']
        },
        body: {
          type: 'object',
          properties: {
            config: {
              type: 'object',
              additionalProperties: true
            }
          }
        },
        response: {
          200: {
            description: 'Search engine selected successfully',
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
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const definition = CARDINAL.models.search.getDefinition(req.params.key)
      if (!definition) {
        return reply.notFound(`Search engine "${req.params.key}" does not exist.`)
      }

      const invalid = CARDINAL.models.search.validateEngineConfig(
        req.params.key,
        req.body.config,
        CARDINAL.models.search.getEngineConfig(req.params.siteId, req.params.key)
      )
      if (invalid) {
        return reply.badRequest(invalid)
      }

      const selected = await CARDINAL.models.search.selectEngine(
        req.params.siteId,
        req.params.key,
        req.body.config
      )
      if (!selected) {
        return reply.internalServerError('Failed to select the search engine.')
      }

      return {
        ok: true,
        message: `${definition.title} selected as the search engine successfully.`
      }
    }
  )

  app.post<{ Params: { siteId: string } }>(
    '/sites/:siteId/search/refresh',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Re-read the search engine definitions from disk',
        description:
          'Re-scans `modules/search` for `definition.yml` files, picking up an engine added or removed since boot, then returns the refreshed list for this site -- same shape as `GET .../search/engines`.',
        tags: ['Search'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Refreshed list of search engines',
            type: 'array',
            items: { $ref: 'SearchEngine#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      await CARDINAL.models.search.refreshFromDisk()
      return withDbSearchExtras(
        await CARDINAL.models.search.getSiteEngines(req.params.siteId, { mask: true }),
        req.params.siteId
      )
    }
  )
}

export default routes
