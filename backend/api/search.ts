import type { FastifyInstance } from 'fastify'
import type { SearchEngine } from '../models/search.ts'

/** The one engine whose panel needs a dictionary override editor, task #574. */
const DB_ENGINE_KEY = 'db'

/**
 * Attach `dictOverrides` and `availableDictionaries` onto the `db` entry of an engine list.
 *
 * Both routes below that return the engine list (`GET .../engines`, `POST .../refresh`) need this, so
 * it lives here rather than in `models/search.ts`: computing it for every engine on every call would
 * load and query the `db` module even when nothing asked for its panel, and `getSiteEngines()`'s own
 * test coverage already pins its output to exactly the `SearchEngine` fields it builds itself. See the
 * `SearchEngine.dictOverrides` doc comment in `models/search.ts`.
 */
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
 * Search API Routes
 *
 * Per-site, mirroring the shape of `api/storage.ts`'s target routes: search configuration
 * (`dictOverrides`) and the rebuild action moved off the instance-wide `/system/search` routes onto a
 * site once `models/sites.ts` started seeding `config.search` per site (task #563). `manage:sites`
 * rather than `manage:system` there: unlike a storage target's credentials, none of that general
 * search config holds a secret, so it belongs with the rest of a site's editable settings.
 *
 * `termHighlighting` used to live on `/sites/:siteId/search` alongside `dictOverrides`, but task #574
 * folded it into the `db` engine's own per-engine config: it is a plain boolean prop on `db`'s
 * `definition.yml`, so it is read and written through the engine-picker routes below like any other
 * engine's config, and this route no longer mentions it. `dictOverrides` could not follow — see
 * `SearchEngine.dictOverrides` in `models/search.ts` — so it keeps the PATCH below to write it; the
 * caller-less bare `GET .../search` was deleted (task #1871), since the `db` entry of the
 * engine-picker list below already carries `dictOverrides`' current value (plus `availableDictionaries`)
 * so the admin area's `db`-specific panel needs no second round trip to render it.
 *
 * The engine-picker routes below (task #570) are different: a non-default engine's config can hold
 * credentials the same way a storage target's can (an API key, an index name pointing at private
 * infrastructure, ...), so they require `manage:system`, exactly like `api/storage.ts`. `refresh` and
 * `rebuild` require it too for consistency with the rest of this surface, even though neither reads a
 * secret itself -- `rebuild` in particular can now run arbitrary engine code, the same reasoning
 * `api/storage.ts`'s action route uses.
 *
 * `semanticEnabled` / `GET .../search/semantic` / `POST .../search/rebuild-embeddings` (task #3104,
 * Epic #3050) are unrelated to the pluggable engine system above — semantic search is always backed
 * directly by Postgres/pgvector regardless of which full-text engine a site has selected — but they
 * live in this same file since they are, like `dictOverrides`, a site-level search setting plus a
 * matching rebuild action with no engine of its own to belong to.
 */
async function routes(app: FastifyInstance) {
  /**
   * UPDATE SITE SEARCH CONFIGURATION
   *
   * `semanticEnabled` (Task #3104) is the per-site half of the semantic-search availability flag
   * triangle: `CARDINAL.capabilities.semanticSearch` (instance-wide, Task #3095) AND this setting must
   * both be true before the feature is actually reachable — enforced here, not just hinted at in the
   * admin UI, so a stale or hand-crafted request can't flip this on when the capability itself is
   * false and end up with a setting that can never do anything.
   */
  app.patch<{
    Params: { siteId: string }
    Body: { dictOverrides?: Record<string, string>; semanticEnabled?: boolean }
  }>(
    '/sites/:siteId/search',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Update the search configuration of a site',
        description:
          'Every dictionary named in `dictOverrides` must exist in this database, otherwise indexing would fail later, long after the setting was accepted. Changing a mapping affects pages the next time they are indexed — rebuild the index to apply it to existing content. `semanticEnabled` may only be set to `true` when semantic search is available on this instance.',
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
      if (req.body.dictOverrides === undefined && req.body.semanticEnabled === undefined) {
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

  /**
   * GET SITE SEMANTIC SEARCH SETTING
   *
   * A small, dedicated route rather than folding this onto `GET .../search/engines` (task #1871
   * deliberately deleted the last caller-less bare `GET .../search`, but this one has a real caller:
   * `AdminSearch.vue`'s toggle needs both the stored setting and the instance capability to render
   * itself — disabled with an explanation when the capability is false — and semantic search is not
   * an engine, so it has no natural home on that list). `manage:sites`, matching the PATCH above: this
   * is the same site-settings surface, not the credential-bearing engine-picker one.
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/search/semantic',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: "Get a site's semantic search setting",
        description:
          "`available` reflects `CARDINAL.capabilities.semanticSearch` (instance-wide: whether pgvector is usable at all); `enabled` is this site's own stored setting, independent of `available`. The feature is reachable only when both are true.",
        tags: ['Search'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: "The site's semantic search setting",
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              available: { type: 'boolean' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return {
        enabled: CARDINAL.models.search.getConfig(req.params.siteId).semanticEnabled,
        available: CARDINAL.capabilities?.semanticSearch ?? false
      }
    }
  )

  /**
   * REBUILD SITE EMBEDDINGS INDEX
   *
   * Mirrors the full-text `POST .../search/rebuild` route immediately below: queues a job and returns
   * right away rather than doing per-page work in the request/response cycle (Epic #3050's
   * coordination note is explicit about this). Refused up front when semantic search is unavailable on
   * this instance — nothing to rebuild.
   */
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

  /**
   * REBUILD SITE SEARCH INDEX
   */
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

  /**
   * LIST SITE SEARCH ENGINES
   */
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

  /**
   * SELECT SITE SEARCH ENGINE
   */
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

  /**
   * REFRESH SEARCH ENGINE DEFINITIONS
   */
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
