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
          }
        }
      }
    },
    async (req) => {
      return WIKI.models.locales.getStrings(req.params.code)
    }
  )
}

export default routes
