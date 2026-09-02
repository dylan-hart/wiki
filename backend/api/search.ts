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
    db.dictOverrides = WIKI.models.search.getConfig(siteId).dictOverrides
    db.availableDictionaries = await WIKI.models.search.getAvailableDictionaries()
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
 */
async function routes(app: FastifyInstance) {
  /**
   * UPDATE SITE SEARCH CONFIGURATION
   */
  app.patch<{
    Params: { siteId: string }
    Body: { dictOverrides?: Record<string, string> }
  }>(
    '/sites/:siteId/search',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Update the search configuration of a site',
        description:
          'Every dictionary named in `dictOverrides` must exist in this database, otherwise indexing would fail later, long after the setting was accepted. Changing a mapping affects pages the next time they are indexed — rebuild the index to apply it to existing content.',
        tags: ['Search'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          properties: {
            dictOverrides: {
              type: 'object',
              description: 'Locale code to postgres dictionary. Replaces the stored mapping.',
              additionalProperties: { type: 'string' }
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
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (req.body.dictOverrides === undefined) {
        return reply.badRequest('No search settings provided to update.')
      }

      const available = await WIKI.models.search.getAvailableDictionaries()
      for (const [locale, dictionary] of Object.entries(req.body.dictOverrides)) {
        if (!/^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/.test(locale)) {
          return reply.badRequest('ERR_INVALID_LOCALE_CODE')
        }
        if (!available.includes(dictionary)) {
          return reply.badRequest('ERR_INVALID_SEARCH_DICTIONARY')
        }
      }

      const patch: Record<string, any> = { dictOverrides: req.body.dictOverrides }

      const updated = await WIKI.models.sites.updateSite(req.params.siteId, {
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
      const added = await WIKI.scheduler.addJob({
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
        await WIKI.models.search.getSiteEngines(req.params.siteId, { mask: true }),
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
      const definition = WIKI.models.search.getDefinition(req.params.key)
      if (!definition) {
        return reply.notFound(`Search engine "${req.params.key}" does not exist.`)
      }

      const invalid = WIKI.models.search.validateEngineConfig(
        req.params.key,
        req.body.config,
        WIKI.models.search.getEngineConfig(req.params.siteId, req.params.key)
      )
      if (invalid) {
        return reply.badRequest(invalid)
      }

      const selected = await WIKI.models.search.selectEngine(
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
      await WIKI.models.search.refreshFromDisk()
      return withDbSearchExtras(
        await WIKI.models.search.getSiteEngines(req.params.siteId, { mask: true }),
        req.params.siteId
      )
    }
  )
}

export default routes
