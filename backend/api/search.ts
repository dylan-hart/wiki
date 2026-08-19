import type { FastifyInstance } from 'fastify'

/**
 * Search API Routes
 *
 * Per-site, mirroring the shape of `api/storage.ts`'s target routes: search configuration
 * (`termHighlighting`/`dictOverrides`) and the rebuild action moved off the instance-wide
 * `/system/search` routes onto a site once `models/sites.ts` started seeding `config.search` per site
 * (task #563). `manage:sites` rather than `manage:system`: unlike a storage target's credentials, none
 * of this holds a secret, so it belongs with the rest of a site's editable settings.
 */
async function routes(app: FastifyInstance) {
  /**
   * GET SITE SEARCH CONFIGURATION
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/search',
    {
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Get the search configuration of a site',
        description:
          'Search is postgres full-text. `availableDictionaries` lists the text search configurations this database has, which is what a locale may be mapped to.',
        tags: ['Search'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
        response: {
          200: {
            description: 'Search configuration',
            type: 'object',
            properties: {
              termHighlighting: {
                type: 'boolean'
              },
              dictOverrides: {
                type: 'object',
                description:
                  'Locale code to postgres dictionary, e.g. `{ "en": "english" }`. Overrides the built-in mapping.',
                additionalProperties: { type: 'string' }
              },
              availableDictionaries: {
                type: 'array',
                description: 'Dictionary names this postgres installation knows.',
                items: { type: 'string' }
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }
      return {
        ...WIKI.models.search.getConfig(req.params.siteId),
        availableDictionaries: await WIKI.models.search.getAvailableDictionaries()
      }
    }
  )

  /**
   * UPDATE SITE SEARCH CONFIGURATION
   */
  app.patch<{
    Params: { siteId: string }
    Body: { termHighlighting?: boolean; dictOverrides?: Record<string, string> }
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
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
        body: {
          type: 'object',
          properties: {
            termHighlighting: {
              type: 'boolean'
            },
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
          }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }

      if (req.body.termHighlighting === undefined && req.body.dictOverrides === undefined) {
        return reply.badRequest('No search settings provided to update.')
      }

      if (req.body.dictOverrides) {
        const available = await WIKI.models.search.getAvailableDictionaries()
        for (const [locale, dictionary] of Object.entries(req.body.dictOverrides)) {
          if (!/^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/.test(locale)) {
            return reply.badRequest(`"${locale}" is not a valid locale code.`)
          }
          if (!available.includes(dictionary)) {
            return reply.badRequest(
              `"${dictionary}" is not a text search dictionary in this database.`
            )
          }
        }
      }

      const patch: Record<string, any> = {}
      if (req.body.termHighlighting !== undefined) {
        patch.termHighlighting = req.body.termHighlighting
      }
      if (req.body.dictOverrides !== undefined) {
        patch.dictOverrides = req.body.dictOverrides
      }

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
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Rebuild the search index of a site',
        description:
          'Queues a job that recomputes the search vector of every page of this site from its stored content, using the dictionary mapping in force. Runs in the background: the response only says the job was queued.',
        tags: ['Search'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId']
        },
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
          }
        }
      }
    },
    async (req, reply) => {
      const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId })
      if (!site) {
        return reply.notFound('Site does not exist.')
      }

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
}

export default routes
