import maintenance from '../../core/maintenance.ts'
import { purgeTimeframes } from '../../models/pageHistory.ts'
import type { PurgeTimeframe } from '../../models/pageHistory.ts'
import { actorFromRequest } from '../../models/auditLog.ts'
import { JOB_STATES } from '../../models/jobs.ts'
import type { FastifyInstance } from 'fastify'

/**
 * Operator actions against the running instance: dropping websocket connections, flushing the
 * cache, the TLS certificate view and renewal, and the three purges (expired API keys, sessions,
 * page history).
 */
async function routes(app: FastifyInstance) {
  /**
   * DISCONNECT WEBSOCKET SESSIONS
   */
  app.post(
    '/websockets/disconnect',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Close every websocket connection, on every instance',
        description:
          'The sockets are the editors of live collaborative editing (`/_collab`) and the admin terminal’s log stream (`/_terminal`). Closing one is not a refusal: the code sent is a plain "come back", so an editor reconnects on its own and picks up the room it was in, and its unsaved text survives as long as somebody else is still in that room. Every other instance is told to do the same over the event bus, and does it as it hears it — `count` is this instance’s own, since a socket is held by the instance the browser reached and nothing reports back.',
        tags: ['System'],
        response: {
          200: {
            description: 'Websocket connections closed successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              count: {
                type: 'number',
                description: 'Connections that were open on this instance and have been closed.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      const count = maintenance.disconnectWebsockets()
      CARDINAL.events.outbound.emit('disconnectWebsockets')
      return {
        ok: true,
        message: `Closed ${count} websocket connection(s) on this instance.`,
        count
      }
    }
  )

  /**
   * FLUSH CACHE
   */
  app.post(
    '/cache/flush',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Flush the caches, on every instance',
        description:
          'Throws away everything an instance holds that the database is the real copy of: the file and icon caches, in memory and on disk, and the site, group, page-rule and locale state that answers every request. Nothing is lost and nothing is disabled — what is read on every request is refilled before this answers, and the rest as it is asked for again. Every other instance is told to do the same over the event bus, and does it as it hears it.',
        tags: ['System'],
        response: {
          200: {
            description: 'Cache flushed successfully',
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
    async () => {
      await maintenance.flushCaches()
      CARDINAL.events.outbound.emit('flushCaches')
      return {
        ok: true,
        message: 'The cache has been flushed.'
      }
    }
  )

  /**
   * GET API KEY CERTIFICATE STATE
   */
  app.get(
    '/certificates',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'When the API key signing certificates were generated',
        description:
          'The moment the current keypair came into being — at install, or the last time an administrator regenerated it. Every key issued before it was signed by a keypair that no longer exists and cannot authenticate, which is what `isInvalidated` on a key reports.',
        tags: ['System'],
        response: {
          200: {
            description: 'Certificate state',
            type: 'object',
            properties: {
              generatedAt: {
                type: 'string',
                format: 'date-time',
                description: 'RFC 3339 Date Time'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return { generatedAt: CARDINAL.models.apiKeys.certificatesGeneratedAt() }
    }
  )

  /**
   * REGENERATE API KEY CERTIFICATES
   */
  app.post(
    '/certificates',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Replace the API key signing certificates',
        description:
          'Generates a new keypair and a new passphrase for it. An API key is a token signed with that keypair, so every key ever issued stops authenticating at once, on every instance — this is what takes back a key that has escaped and cannot be revoked one at a time. The key rows are left as they are, still listed and still not revoked: what has to happen next is that each one is reissued. Logins are unaffected — session cookies are signed with a secret of their own.',
        tags: ['System'],
        response: {
          200: {
            description: 'Certificates regenerated successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              invalidatedKeys: {
                type: 'number',
                description:
                  'Keys that were neither revoked nor expired, and have just stopped working.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The new certificates could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      const invalidatedKeys = await CARDINAL.models.apiKeys.regenerateCertificates()
      if (invalidatedKeys === null) {
        return reply.internalServerError('Failed to save the new certificates.')
      }

      await CARDINAL.models.auditLog.record({
        event: 'system.certificatesRegenerated',
        actor: actorFromRequest(req),
        detail: { invalidatedKeys }
      })

      return {
        ok: true,
        message: `Certificates regenerated successfully. ${invalidatedKeys} API key(s) will have to be reissued.`,
        invalidatedKeys
      }
    }
  )

  /**
   * PURGE REVOKED API KEYS
   */
  app.post(
    '/api-keys/purge',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Delete every revoked API key',
        description:
          'Clears revoked keys out of the list for good. Nothing about access changes — a revoked key already authenticates nothing — so this trades the record that the key ever existed for a shorter list. Keys that are merely invalidated are kept: one of those is a key nobody has made a decision about, and its row is what tells its owner to reissue it.',
        tags: ['System'],
        response: {
          200: {
            description: 'Revoked keys purged successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              count: {
                type: 'number',
                description: 'Keys deleted.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      const count = await CARDINAL.models.apiKeys.purgeRevoked()
      return {
        ok: true,
        message: `Purged ${count} revoked API key(s).`,
        count
      }
    }
  )

  /**
   * INVALIDATE USER SESSIONS
   */
  app.post(
    '/sessions/invalidate',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Rotate the session secret and end every session',
        description:
          'Logs everybody out, this caller included, and gives @fastify/session a new secret to sign cookies with. The two happen together on purpose: ending the sessions takes effect immediately and everywhere, since they are rows every instance shares, while the new secret is only picked up when an instance restarts — the plugins are handed it at startup. API keys are unaffected; their keypair carries its own passphrase.',
        tags: ['System'],
        response: {
          200: {
            description: 'Sessions invalidated successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              count: {
                type: 'number',
                description: 'Sessions that were open and have been ended.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The new session secret could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      const count = await CARDINAL.models.sessions.rotateSecret()
      if (count === null) {
        return reply.internalServerError('Failed to save the new session secret.')
      }

      // -> Resolved before `req.session.destroy()` below, which clears `req.session.user` this reads.
      await CARDINAL.models.auditLog.record({
        event: 'system.sessionsInvalidated',
        actor: actorFromRequest(req),
        detail: { count }
      })

      /*
        This request's own session, which the rows above no longer include but which would come
        straight back without this: @fastify/session writes the session it is holding as the response
        is sent, so deleting the row from under it only means it is written again a moment later, and
        the one account that would stay logged in is the one that asked for everybody to be logged
        out. Destroying it detaches it from the request, which is what that hook skips on.
      */
      await req.session.destroy()

      return {
        ok: true,
        message: `Ended ${count} session(s) and rotated the session secret.`,
        count
      }
    }
  )

  /**
   * PURGE PAGE HISTORY
   */
  app.post<{ Body: { olderThan: PurgeTimeframe } }>(
    '/history/purge',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Purge page history older than a timeframe',
        description:
          'Deletes every version older than the cutoff, on every site. Pages themselves are untouched — a page row holds what it says now — so this shortens timelines and takes away what a page can be rolled back to, nothing more. With one exception: the versions of a page that was DELETED are all that is left of it, so purging past the day it went is what finally discards it. Nothing here can be undone.',
        tags: ['System'],
        body: {
          type: 'object',
          required: ['olderThan'],
          properties: {
            olderThan: {
              type: 'string',
              enum: Object.keys(purgeTimeframes),
              description: 'How far back to keep. Everything older than this is deleted.'
            }
          }
        },
        response: {
          200: {
            description: 'Page history purged successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              count: {
                type: 'number',
                description: 'Versions deleted.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      const count = await CARDINAL.models.pageHistory.purge(req.body.olderThan)

      await CARDINAL.models.auditLog.record({
        event: 'system.pageHistoryPurged',
        actor: actorFromRequest(req),
        detail: { olderThan: req.body.olderThan, count }
      })

      return {
        ok: true,
        message: `Purged ${count} page version(s).`,
        count
      }
    }
  )

  /**
   * CONVERT LEGACY WYSIWYG JSON ROWS
   */
  app.post(
    '/wysiwyg/convert',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Convert legacy WYSIWYG Tiptap-JSON rows to markdown',
        description:
          "Queues a background job that finds every page still holding the old WYSIWYG editor's raw Tiptap JSON (a `contentType: 'html'` row whose content actually starts with `{`, from before OpenProject #3395 moved that editor onto markdown storage), converts each through a headless copy of the editor, and writes the result back as `contentType: 'markdown'` with one history version per page. Runs in the background across every site. A row this can't convert (malformed JSON, or JSON that isn't a Tiptap document) is reported, not silently skipped -- opening it in the editor still converts it lazily on its next save. Poll `GET /wysiwyg/convert/:jobId` for the result.",
        tags: ['System'],
        response: {
          200: {
            description: 'Conversion queued successfully',
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
                description: 'ID of the queued job. Pass it to the status route below.'
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
        task: 'convertWysiwygJson',
        payload: { actorId: req.session.user!.id }
      })
      if (!added?.id) {
        return reply.internalServerError('The scheduler could not queue the conversion.')
      }

      await CARDINAL.models.auditLog.record({
        event: 'system.wysiwygJsonConverted',
        actor: actorFromRequest(req),
        detail: { jobId: added.id }
      })

      return {
        ok: true,
        message: 'Legacy WYSIWYG JSON conversion queued successfully.',
        id: added.id
      }
    }
  )

  /**
   * GET LEGACY WYSIWYG JSON CONVERSION RESULT
   */
  app.get<{ Params: { jobId: string } }>(
    '/wysiwyg/convert/:jobId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get a legacy WYSIWYG JSON conversion job',
        description:
          "The job's current state, and its report once `state` is `completed`. 404s when no such conversion job exists.",
        tags: ['System'],
        params: {
          type: 'object',
          properties: {
            jobId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['jobId']
        },
        response: {
          200: {
            description: 'Conversion job state and, once completed, its report',
            type: 'object',
            properties: {
              state: {
                type: 'string',
                enum: ['queued', ...JOB_STATES],
                description:
                  '`queued` while still waiting to be picked up — it has not reached job history yet.'
              },
              result: {
                type: 'object',
                nullable: true,
                description: 'Null until the job has completed.',
                properties: {
                  convertedCount: {
                    type: 'integer',
                    description: 'Rows converted successfully.'
                  },
                  failed: {
                    type: 'array',
                    description: 'Rows that could not be converted, not silently skipped.',
                    items: {
                      type: 'object',
                      properties: {
                        siteId: { type: 'string', format: 'uuid' },
                        id: { type: 'string', format: 'uuid' },
                        path: { type: 'string' },
                        locale: { type: 'string' },
                        reason: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const entry = await CARDINAL.models.jobs.getHistoryEntry(req.params.jobId)
      if (entry) {
        if (entry.task !== 'convertWysiwygJson') {
          return reply.notFound('No such conversion job.')
        }
        return {
          state: entry.state,
          result: entry.result ?? null
        }
      }

      // -> Not in history yet: it may simply not have been picked up off the queue by any instance
      //    yet, which is not the same as not existing (see `Jobs#getPendingEntry`)
      const pending = await CARDINAL.models.jobs.getPendingEntry(req.params.jobId)
      if (!pending || pending.task !== 'convertWysiwygJson') {
        return reply.notFound('No such conversion job.')
      }
      return { state: 'queued', result: null }
    }
  )
}

export default routes
