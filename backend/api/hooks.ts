import type { FastifyInstance } from 'fastify'
import { EMITTED_EVENTS, HOOK_EVENTS, postJson } from '../models/hooks.ts'

interface HookBody {
  name?: string
  events?: string[]
  url?: string
  includeMetadata?: boolean
  includeContent?: boolean
  acceptUntrusted?: boolean
  authHeader?: string
  siteId?: string | null
}

interface HookTestBody {
  url: string
  acceptUntrusted?: boolean
  authHeader?: string
}

/**
 * Reject what the admin area's own validation rejects, so the API is not the looser of the two
 */
function invalidReason(body: HookBody, { partial }: { partial: boolean }): string | null {
  if (body.name !== undefined && !/^[^<>"]+$/.test(body.name)) {
    return 'The webhook name contains invalid characters.'
  }
  if (body.url !== undefined) {
    if (!/^[^<>"]+$/.test(body.url)) {
      return 'The URL contains invalid characters.'
    }
    let parsed: URL
    try {
      parsed = new URL(body.url)
    } catch {
      return 'The URL is not valid.'
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'The URL must be an http or https address.'
    }
  }
  if (!partial && (body.events?.length ?? 0) < 1) {
    return 'At least one event is required.'
  }
  if (body.events !== undefined && body.events.length < 1) {
    return 'At least one event is required.'
  }
  if (body.siteId != null && !WIKI.sites[body.siteId]) {
    return 'The selected site does not exist.'
  }
  return null
}

/**
 * Webhooks API Routes
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST WEBHOOKS
   */
  app.get(
    '/',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List all webhooks',
        tags: ['Webhooks'],
        response: {
          200: {
            description: 'List of webhooks',
            type: 'array',
            items: { $ref: 'Hook#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return WIKI.models.hooks.getHooks()
    }
  )

  /**
   * LIST AVAILABLE EVENTS
   */
  app.get(
    '/events',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List the events a webhook can subscribe to',
        description:
          'Every event listed here currently has an emit point (see `isEmitted` on each), so a subscription to any of them is triggered by the corresponding write.',
        tags: ['Webhooks'],
        response: {
          200: {
            description: 'List of event keys',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: {
                  type: 'string'
                },
                isEmitted: {
                  type: 'boolean',
                  description: 'Whether anything in the server currently emits this event.'
                }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return HOOK_EVENTS.map((key) => ({ key, isEmitted: EMITTED_EVENTS.includes(key) }))
    }
  )

  /**
   * GET WEBHOOK
   */
  app.get<{ Params: { hookId: string } }>(
    '/:hookId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get a single webhook',
        tags: ['Webhooks'],
        params: {
          type: 'object',
          properties: {
            hookId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['hookId']
        },
        response: {
          200: { $ref: 'Hook#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const hook = await WIKI.models.hooks.getHookById(req.params.hookId)
      if (!hook) {
        return reply.notFound('Webhook does not exist.')
      }
      return hook
    }
  )

  /**
   * LIST WEBHOOK DELIVERY HISTORY
   */
  // -> `limit` is non-optional: the querystring schema declares a `default` for it, and fastify's
  //    AJV runs with `useDefaults`, so a missing param is filled in before the handler sees it.
  app.get<{ Params: { hookId: string }; Querystring: { limit: number } }>(
    '/:hookId/deliveries',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: "List a webhook's delivery history",
        description:
          'Past delivery attempts, most recently started first. Backed by the scheduler job history, so entries are purged on the same retention as every other job.',
        tags: ['Webhooks'],
        params: {
          type: 'object',
          properties: {
            hookId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['hookId']
        },
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }
          }
        },
        response: {
          200: {
            description: 'List of deliveries',
            type: 'object',
            properties: {
              total: {
                type: 'integer',
                description:
                  'How many deliveries this webhook has, which can exceed the number returned.'
              },
              limit: {
                type: 'integer'
              },
              deliveries: {
                type: 'array',
                items: { $ref: 'HookDelivery#' }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!(await WIKI.models.hooks.getHookById(req.params.hookId))) {
        return reply.notFound('Webhook does not exist.')
      }
      const { limit } = req.query
      const { total, deliveries } = await WIKI.models.hooks.getDeliveryHistory(req.params.hookId, {
        limit
      })
      return { total, limit, deliveries }
    }
  )

  /**
   * SEND TEST EVENT
   */
  app.post<{ Body: HookTestBody }>(
    '/test',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Send a synthetic test event to a webhook endpoint',
        description:
          'Takes the destination directly in the body rather than a hookId, so it can validate a URL ' +
          'that is still being typed into the edit form and has never been saved. Never touches the ' +
          'hooks table — a test delivery is not a real delivery, and must not overwrite a saved ' +
          "webhook's state or lastErrorMessage.",
        tags: ['Webhooks'],
        body: { $ref: 'HookTestInput#' },
        response: {
          200: {
            description:
              'The test request was attempted (a non-2xx answer or a connection failure is still `ok: false`, not an HTTP error)',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean',
                description: 'Whether the endpoint answered with a 2xx status.'
              },
              statusCode: {
                type: 'integer',
                description:
                  'The HTTP status the endpoint answered with, or 0 on a connection failure.'
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
      const invalid = invalidReason({ url: req.body.url }, { partial: true })
      if (invalid) {
        return reply.badRequest(invalid)
      }

      const body = JSON.stringify({
        event: 'hook:test',
        sentAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
        instance: WIKI.INSTANCE_ID,
        data: {
          message: 'This is a test event sent by Cardinal.js to verify your webhook endpoint.'
        }
      })

      try {
        const { statusCode } = await postJson(req.body.url, body, {
          authHeader: req.body.authHeader,
          acceptUntrusted: req.body.acceptUntrusted ?? false
        })
        const ok = statusCode >= 200 && statusCode <= 299
        return {
          ok,
          statusCode,
          message: ok
            ? 'The endpoint answered successfully.'
            : `The endpoint answered with HTTP ${statusCode}.`
        }
      } catch (err: any) {
        return {
          ok: false,
          statusCode: 0,
          message: err.message
        }
      }
    }
  )

  /**
   * CREATE WEBHOOK
   */
  app.post<{ Body: HookBody }>(
    '/',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Create a new webhook',
        tags: ['Webhooks'],
        // -> The same shape as an update, with the three fields a webhook cannot exist without
        body: {
          allOf: [{ $ref: 'HookInput#' }, { type: 'object', required: ['name', 'events', 'url'] }]
        },
        response: {
          200: {
            description: 'Webhook created successfully',
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
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      // -> `siteId` here is a body field, not `req.params.siteId`, and this route is `manage:system`
      //    only -- no `enforceApiKeySite()` call; see `helpers/apiKeySite.ts`'s doc comment for why.
      const invalid = invalidReason(req.body, { partial: false })
      if (invalid) {
        return reply.badRequest(invalid)
      }

      const id = await WIKI.models.hooks.createHook({
        name: req.body.name!,
        events: req.body.events!,
        url: req.body.url!,
        includeMetadata: req.body.includeMetadata,
        includeContent: req.body.includeContent,
        acceptUntrusted: req.body.acceptUntrusted,
        authHeader: req.body.authHeader,
        siteId: req.body.siteId ?? null
      })

      return {
        ok: true,
        message: 'Webhook created successfully.',
        id
      }
    }
  )

  /**
   * UPDATE WEBHOOK
   */
  app.put<{ Params: { hookId: string }; Body: HookBody }>(
    '/:hookId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Update a webhook',
        description:
          'Accepts any subset of the fields. Changing the URL, the events or the authentication header resets the webhook to pending, since the last outcome no longer describes the new configuration.',
        tags: ['Webhooks'],
        params: {
          type: 'object',
          properties: {
            hookId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['hookId']
        },
        body: { $ref: 'HookInput#' },
        response: {
          200: {
            description: 'Webhook updated successfully',
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
      // -> Same body-`siteId`, `manage:system`-only shape as CREATE above -- see the comment there.
      if (!(await WIKI.models.hooks.getHookById(req.params.hookId))) {
        return reply.notFound('Webhook does not exist.')
      }
      const invalid = invalidReason(req.body, { partial: true })
      if (invalid) {
        return reply.badRequest(invalid)
      }
      const patch: Record<string, any> = {}
      for (const field of [
        'name',
        'events',
        'url',
        'includeMetadata',
        'includeContent',
        'acceptUntrusted',
        'authHeader',
        'siteId'
      ] as const) {
        if (req.body[field] !== undefined) {
          patch[field] = req.body[field]
        }
      }
      if (Object.keys(patch).length < 1) {
        return reply.badRequest('No webhook fields provided to update.')
      }

      await WIKI.models.hooks.updateHook(req.params.hookId, patch)

      return {
        ok: true,
        message: 'Webhook updated successfully.'
      }
    }
  )

  /**
   * DELETE WEBHOOK
   */
  app.delete<{ Params: { hookId: string } }>(
    '/:hookId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Delete a webhook',
        tags: ['Webhooks'],
        params: {
          type: 'object',
          properties: {
            hookId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['hookId']
        },
        response: {
          204: {
            description: 'Webhook deleted successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!(await WIKI.models.hooks.deleteHook(req.params.hookId))) {
        return reply.notFound('Webhook does not exist.')
      }
      return reply.code(204).send()
    }
  )
}

export default routes
