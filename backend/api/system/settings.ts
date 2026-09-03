import { actorFromRequest } from '../../models/auditLog.ts'
import type { AuditEvent } from '../../models/auditLog.ts'
import type { FastifyInstance } from 'fastify'

/**
 * One boolean system flag, as the pair of routes it needs: a GET answering `{ isEnabled }` and a PUT
 * setting it (API-F7).
 *
 * `/api`, `/metrics` and `/pageviews` were three PUT handlers that were line-for-line identical
 * apart from a config key, an audit event name and three message strings, plus three near-identical
 * pairs of route schemas. Everything a reader of `/_api`'s Swagger UI sees is still written per
 * toggle -- summaries, descriptions, the state label every message is built from -- which is why
 * this takes an options object rather than three positional arguments. What is shared is only the
 * mechanism: merge onto the config object already in memory (so a sibling key survives), persist
 * that ONE config key, put the in-memory value back and answer 500 if the write failed, and record
 * the audit event with the new value.
 *
 * `GET /flags` and `GET|PUT /security` are deliberately NOT built from this: neither is a single
 * boolean, and both carry validation of their own.
 */
interface FlagToggleOptions {
  /** The path both halves answer on, e.g. `/api`. */
  path: string
  /** The `WIKI.config` key this flag lives under -- also the one key handed to `saveToDb`. */
  configKey: string
  /** The audit event the PUT records. */
  auditEvent: AuditEvent
  /** What the flag is called at the START of a sentence: `API`, `Metrics endpoint`, ... */
  label: string
  /** What it is called mid-sentence, state included: `API state`, `metrics endpoint state`, ... */
  stateLabel: string
  /** Swagger summary for each half. */
  summary: { get: string; put: string }
  /** Swagger description for each half. */
  description: { get: string; put: string }
  /**
   * Fields the GET answers ALONGSIDE `isEnabled`: `properties` is merged into its 200 schema (after
   * `isEnabled`, so the serialized key order is unchanged), `value()` produces them per request.
   * `/pageviews` is the one toggle that has any.
   */
  extraGet?: {
    properties: Record<string, any>
    value: () => Promise<Record<string, any>>
  }
}

function registerFlagToggle(app: FastifyInstance, opts: FlagToggleOptions): void {
  app.get(
    opts.path,
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: opts.summary.get,
        description: opts.description.get,
        tags: ['System'],
        response: {
          200: {
            description: `${opts.label} state`,
            type: 'object',
            properties: {
              isEnabled: {
                type: 'boolean'
              },
              ...opts.extraGet?.properties
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return {
        isEnabled: WIKI.config[opts.configKey].isEnabled === true,
        ...(opts.extraGet ? await opts.extraGet.value() : {})
      }
    }
  )

  app.put<{ Body: { isEnabled: boolean } }>(
    opts.path,
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: opts.summary.put,
        description: opts.description.put,
        tags: ['System'],
        body: {
          type: 'object',
          required: ['isEnabled'],
          properties: {
            isEnabled: {
              type: 'boolean'
            }
          }
        },
        response: {
          200: {
            description: `${opts.label} state updated successfully`,
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              isEnabled: {
                type: 'boolean'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: `The ${opts.stateLabel} could not be saved.` }
        }
      }
    },
    async (req, reply) => {
      const previousConfig = WIKI.config[opts.configKey]
      WIKI.config[opts.configKey] = { ...previousConfig, isEnabled: req.body.isEnabled }

      if (!(await WIKI.configSvc.saveToDb([opts.configKey]))) {
        WIKI.config[opts.configKey] = previousConfig
        return reply.internalServerError(`Failed to save the ${opts.stateLabel}.`)
      }

      await WIKI.models.auditLog.record({
        event: opts.auditEvent,
        actor: actorFromRequest(req),
        detail: { isEnabled: req.body.isEnabled }
      })

      return {
        ok: true,
        message: req.body.isEnabled
          ? `${opts.label} enabled successfully.`
          : `${opts.label} disabled successfully.`,
        isEnabled: req.body.isEnabled
      }
    }
  )
}

/**
 * Instance-wide settings: the feature flags, the security settings, and the three boolean toggles
 * (API, metrics endpoint, pageview tracking) plus the pageview hash-key rotation that sits with
 * them.
 */
async function routes(app: FastifyInstance) {
  /**
   * SYSTEM FLAGS
   */
  app.get(
    '/flags',
    {
      config: {
        publicAccess: true
      },
      schema: {
        summary: 'System Flags',
        description:
          'Readable without authentication: the frontend needs `experimental` before anyone has logged in, to know which unfinished features to reveal. A flag must therefore never carry anything sensitive.',
        tags: ['System'],
        response: {
          200: { $ref: 'SystemFlags#' }
        }
      }
    },
    async () => {
      return WIKI.models.flags.getFlags()
    }
  )

  /**
   * UPDATE SYSTEM FLAGS
   */
  app.put<{ Body: Record<string, any> }>(
    '/flags',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Update the system flags',
        description:
          'Accepts any subset of the flags. All of them take effect immediately, without a restart: `authDebug` and `sqlLog` write to the server log at info level, and `experimental` is picked up by the frontend on its next load.',
        tags: ['System'],
        body: { $ref: 'SystemFlags#' },
        response: {
          200: {
            description: 'System flags updated successfully',
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
          500: { $ref: 'ApiError#', description: 'The system flags could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      const patch = WIKI.models.flags.pickFlags(req.body)
      if (Object.keys(patch).length < 1) {
        return reply.badRequest('No system flags provided to update.')
      }
      if (!(await WIKI.models.flags.updateFlags(patch))) {
        return reply.internalServerError('Failed to save the system flags.')
      }

      await WIKI.models.auditLog.record({
        event: 'system.flagsUpdated',
        actor: actorFromRequest(req),
        detail: patch
      })

      return {
        ok: true,
        message: 'System flags updated successfully.'
      }
    }
  )

  /**
   * GET SECURITY CONFIGURATION
   */
  app.get(
    '/security',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get the security configuration',
        description:
          'Most of this is applied when the HTTP server starts, so changing it takes effect on the next restart.',
        tags: ['System'],
        response: {
          200: { $ref: 'SecurityConfig#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return {
        ...WIKI.models.security.getConfig(),
        insecureCookieRiskAt: WIKI.models.security.getInsecureCookieRiskAt()
      }
    }
  )

  /**
   * UPDATE SECURITY CONFIGURATION
   */
  app.put<{ Body: Record<string, any> }>(
    '/security',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Update the security configuration',
        description:
          'Accepts any subset of the fields. Header, CORS and proxy settings are read when the HTTP server starts and therefore apply after a restart.',
        tags: ['System'],
        body: { $ref: 'SecurityConfig#' },
        response: {
          200: {
            description: 'Security configuration updated successfully',
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
          500: { $ref: 'ApiError#', description: 'The security configuration could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      const patch = WIKI.models.security.pickFields(req.body)
      if (Object.keys(patch).length < 1) {
        return reply.badRequest('No security settings provided to update.')
      }

      const invalid = WIKI.models.security.validate(patch)
      if (invalid) {
        return reply.badRequest(invalid)
      }

      if (!(await WIKI.models.security.updateConfig(patch))) {
        return reply.internalServerError('Failed to save the security configuration.')
      }

      await WIKI.models.auditLog.record({
        event: 'system.securityUpdated',
        actor: actorFromRequest(req),
        detail: patch
      })

      return {
        ok: true,
        message: 'Security configuration updated successfully.'
      }
    }
  )
  /**
   * API ACCESS
   */
  registerFlagToggle(app, {
    path: '/api',
    configKey: 'api',
    auditEvent: 'system.apiStateUpdated',
    label: 'API',
    stateLabel: 'API state',
    summary: { get: 'Get the API state', put: 'Turn the API on or off' },
    description: {
      get: 'Whether API keys are accepted. While this is off, every request presenting a key is rejected, no matter how valid the key is.',
      put: 'Turning it off stops every API key from authenticating, without revoking any of them. Session-authenticated requests, i.e. the admin area itself, are unaffected.'
    }
  })

  /**
   * PROMETHEUS METRICS ENDPOINT
   */
  registerFlagToggle(app, {
    path: '/metrics',
    configKey: 'metrics',
    auditEvent: 'system.metricsUpdated',
    label: 'Metrics endpoint',
    stateLabel: 'metrics endpoint state',
    summary: {
      get: 'Get the metrics endpoint state',
      put: 'Turn the metrics endpoint on or off'
    },
    description: {
      get: 'Whether the Prometheus metrics endpoint is turned on. The endpoint itself lives at `GET /metrics`, outside `/_api`, and requires its own bearer API key with `manage:system` — see the description of the PUT counterpart.',
      put: 'Governs `GET /metrics`: while off, that route answers 404 for every caller regardless of credentials. While on, it requires a bearer API key carrying the `manage:system` global permission, verified the same way `/_api/*` verifies one.'
    }
  })

  /**
   * PAGEVIEW TRACKING
   */
  registerFlagToggle(app, {
    path: '/pageviews',
    configKey: 'pageviews',
    auditEvent: 'system.pageviewsUpdated',
    label: 'Pageview tracking',
    stateLabel: 'pageview tracking state',
    summary: {
      get: 'Get the pageview tracking state',
      put: 'Turn pageview tracking on or off'
    },
    description: {
      get: 'Whether page views are logged at all (OpenProject #1238). While this is off, neither write path -- the page-read route nor the MCP `get_page` tool -- inserts a row, so this is the switch behind the knowledge graph\'s "size by page visit volume" control (OpenProject #1140). Also returns instance-wide totals (OpenProject #2335) so the admin page can show real evidence tracking is working, not just the switch itself -- these are NOT gated on `isEnabled`, so a recently-disabled instance still shows what was already recorded.',
      put: "Turning it off stops the write path from inserting any new pageview row, immediately -- it does not merely stop a later read from counting what's already there. Existing rows are untouched (and still age out on the normal 2-year retention job) until tracking is turned back on."
    },
    // -> The only toggle whose GET answers more than `isEnabled`: the totals `AdminPageviews.vue`
    //    shows as evidence tracking is actually recording something.
    extraGet: {
      properties: {
        summary: {
          type: 'object',
          properties: {
            totalViews: { type: 'number' },
            last24h: { type: 'number' },
            last7d: { type: 'number' },
            distinctPages: { type: 'number' },
            mostRecentAt: { type: 'string', nullable: true }
          }
        }
      },
      value: async () => ({ summary: await WIKI.models.pageviews.summary() })
    }
  })

  /**
   * ROTATE PAGEVIEW HASH KEY
   */
  app.post(
    '/pageviews/rotate-key',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Rotate the key pageview visitor hashes are keyed with',
        description:
          'Generates a new `pageviews.hashKey` and swaps it in immediately. `visitorHash` is an HMAC keyed with this value (OpenProject #2285/#2286), so every pageview row logged from here on hashes the same raw session/API key id differently than rows logged before the rotation -- existing rows are left exactly as they are, they simply stop correlating with new ones, which is the point of rotating at all.',
        tags: ['System'],
        response: {
          200: {
            description: 'Pageview hash key rotated successfully',
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
          403: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The new pageview hash key could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      const rotated = await WIKI.models.pageviews.rotateHashKey()
      if (!rotated) {
        return reply.internalServerError('Failed to save the new pageview hash key.')
      }

      await WIKI.models.auditLog.record({
        event: 'system.pageviewsHashKeyRotated',
        actor: actorFromRequest(req)
      })

      return {
        ok: true,
        message: 'Pageview hash key rotated successfully.'
      }
    }
  )
}

export default routes
