import crypto from 'node:crypto'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import type { FastifyInstance } from 'fastify'

/**
 * Locales API Routes
 */
async function routes(app: FastifyInstance) {
  app.get(
    '/',
    {
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'List all locales',
        tags: ['Locales'],
        response: {
          200: {
            description: 'Locales known to this instance, ordered by code.',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  description: 'Locale code, e.g. `en` or `pt-BR`.'
                },
                isRTL: { type: 'boolean' },
                language: {
                  type: 'string',
                  description: 'Unicode language subtag, e.g. `en`.'
                },
                name: { type: 'string' },
                nativeName: { type: 'string' },
                completeness: {
                  type: 'integer',
                  description: 'Percentage of strings translated, 0-100.'
                },
                createdAt: {
                  type: 'string',
                  format: 'date-time',
                  description: 'RFC 3339 Date Time'
                },
                updatedAt: {
                  type: 'string',
                  format: 'date-time',
                  description: 'RFC 3339 Date Time'
                }
              }
            }
          }
        }
      }
    },
    async () => {
      return WIKI.models.locales.getLocales()
    }
  )

  app.get<{ Params: { code: string } }>(
    '/:code/strings',
    {
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'Get locale strings',
        description:
          'A flat key -> translated string map, or `[]` when the locale code is unknown.',
        tags: ['Locales'],
        response: {
          200: {
            description: 'Locale strings',
            headers: {
              ETag: {
                type: 'string',
                description:
                  'sha1 hash of the strings payload, quoted. Send back as `If-None-Match` on the next request to revalidate cheaply.'
              },
              'Cache-Control': {
                type: 'string',
                description:
                  'Always `public, no-cache` — cacheable, but must be revalidated before reuse.'
              }
            },
            oneOf: [
              {
                type: 'object',
                description: 'Translation key -> translated string.',
                additionalProperties: { type: 'string' }
              },
              {
                type: 'array',
                description: 'Empty: the locale code does not exist.',
                maxItems: 0
              }
            ]
          },
          304: {
            description: 'Strings unchanged since the `ETag` named in `If-None-Match`.',
            type: 'null'
          }
        }
      }
    },
    async (req, reply) => {
      const strings = await WIKI.models.locales.getStrings(req.params.code)
      const etag = `"${crypto.createHash('sha1').update(JSON.stringify(strings)).digest('hex')}"`
      // -> `nosniff: false`: these are this instance's own translation strings, served as JSON —
      //    not the uploaded bytes the `controllers/` users of this helper are guarding
      if (
        notModifiedOrPrepare(req, reply, {
          etag,
          cacheControl: 'public, no-cache',
          nosniff: false
        })
      ) {
        return reply
      }
      return strings
    }
  )

  app.post(
    '/sideload',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Sideload locale packs from the data volume',
        description:
          'Rescans `<dataPath>/locales/` for locale-pack JSON files and loads them into the DB — the offline-mode path (OpenProject #820) for adding or updating a locale against a running instance with no rebuild, redeploy, or network access. Always force-reloads every file found there, regardless of its last-modified time.',
        tags: ['Locales'],
        response: {
          200: {
            description: 'What the rescan did',
            type: 'object',
            properties: {
              loaded: {
                type: 'array',
                items: { type: 'string' },
                description: 'Locale codes loaded or updated from the sideload directory.'
              },
              skipped: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    code: { type: 'string' },
                    error: { type: 'string' }
                  }
                },
                description: 'Files found but rejected, with why.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return WIKI.models.locales.sideloadFromDataPath({ force: true })
    }
  )
}

export default routes
