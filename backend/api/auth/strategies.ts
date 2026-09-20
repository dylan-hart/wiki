import { actorFromRequest } from '../../models/auditLog.ts'
import type { FastifyInstance } from 'fastify'

/**
 * `GET /authentication/synced-groups` is deliberately not `manage:system`: it carries no strategy
 * secrets — just group and strategy ids/display names — so user and group administrators can reach
 * it too, for the group-assignment warning UIs.
 */
async function routes(app: FastifyInstance) {
  app.get(
    '/authentication/modules',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List the authentication modules available on this server',
        description:
          'Read from `modules/authentication` at startup, so installing a module means dropping it on disk and restarting. Modules that declare themselves unavailable are not listed.',
        tags: ['Authentication'],
        response: {
          200: {
            description: 'List of authentication modules',
            type: 'array',
            items: { $ref: 'AuthModule#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return CARDINAL.models.authentication.getModules()
    }
  )

  app.get(
    '/authentication/strategies',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List the configured authentication strategies',
        description:
          'Instance-wide, i.e. every strategy regardless of which sites offer it. Which of them a given site shows on its login screen, and in what order, is part of that site’s configuration. Configuration values include any secrets a module stores, hence the `manage:system` requirement.',
        tags: ['Authentication'],
        response: {
          200: {
            description: 'List of configured strategies',
            type: 'array',
            items: { $ref: 'AuthStrategy#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return CARDINAL.models.authentication.getActiveStrategies({ mask: true })
    }
  )

  app.get(
    '/authentication/strategies/visible-site-counts',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Count how many sites currently show each configured strategy',
        description:
          'One entry per strategy id that at least one site currently marks visible on its login screen -- an id absent from the list has a count of zero. Meant to back a warning when an enabled strategy is not reachable from any site (OpenProject #2557).',
        tags: ['Authentication'],
        response: {
          200: { $ref: 'AuthVisibleSiteCounts#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      const counts = await CARDINAL.models.authentication.getVisibleSiteCounts()
      return Object.entries(counts).map(([id, visibleSiteCount]) => ({ id, visibleSiteCount }))
    }
  )

  app.get<{ Params: { strategyId: string } }>(
    '/authentication/strategies/:strategyId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get a single configured authentication strategy',
        tags: ['Authentication'],
        params: {
          type: 'object',
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['strategyId']
        },
        response: {
          200: { $ref: 'AuthStrategy#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const strategy = await CARDINAL.models.authentication.getStrategyById(req.params.strategyId, {
        mask: true
      })
      if (!strategy) {
        return reply.notFound('Authentication strategy does not exist.')
      }
      return strategy
    }
  )

  app.post<{ Body: Record<string, any> }>(
    '/authentication/strategies',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Configure a new authentication strategy',
        description:
          'A module can be configured more than once, so that two instances of the same provider can coexist. A new strategy is not offered by any site until that site adds it to its login screen.',
        tags: ['Authentication'],
        body: {
          allOf: [{ $ref: 'AuthStrategyInput#' }, { type: 'object', required: ['module'] }]
        },
        response: {
          200: {
            description: 'Strategy created successfully',
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
      const mod = CARDINAL.models.authentication.getModule(req.body.module)
      if (!mod) {
        return reply.badRequest('ERR_UNKNOWN_AUTH_MODULE')
      }

      const invalid =
        (await CARDINAL.models.authentication.validateStrategy({
          module: req.body.module,
          displayName: req.body.displayName,
          isEnabled: req.body.isEnabled,
          allowedEmailRegex: req.body.allowedEmailRegex,
          allowedEmailDomains: req.body.allowedEmailDomains,
          autoEnrollGroups: req.body.autoEnrollGroups,
          mappableGroups: req.body.mappableGroups
        })) ?? CARDINAL.models.authentication.validateConfig(req.body.module, req.body.config)
      if (invalid) {
        return reply.badRequest(invalid)
      }

      const id = await CARDINAL.models.authentication.createStrategy(req.body as any)

      return {
        ok: true,
        message: 'Authentication strategy created successfully.',
        id
      }
    }
  )

  app.put<{ Params: { strategyId: string }; Body: Record<string, any> }>(
    '/authentication/strategies/:strategyId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Update an authentication strategy',
        description:
          'Accepts any subset of the fields, except `module`, which is fixed once a strategy exists. The strategies are reloaded on success, so a configuration change applies to the next login rather than after a restart.',
        tags: ['Authentication'],
        params: {
          type: 'object',
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['strategyId']
        },
        body: { $ref: 'AuthStrategyInput#' },
        response: {
          200: {
            description: 'Strategy updated successfully',
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
          404: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'The strategy update could not be saved.' }
        }
      }
    },
    async (req, reply) => {
      const current = await CARDINAL.models.authentication.getStrategyById(req.params.strategyId)
      if (!current) {
        return reply.notFound('Authentication strategy does not exist.')
      }
      if (req.body.module !== undefined && req.body.module !== current.module) {
        return reply.badRequest('The module of an existing strategy cannot be changed.')
      }

      const patch: Record<string, any> = {}
      for (const field of [
        'displayName',
        'isEnabled',
        'selfRegistration',
        'autoProvision',
        'allowedEmailRegex',
        'allowedEmailDomains',
        'autoEnrollGroups',
        'trustEmailForLinking',
        'mappableGroups',
        'config'
      ] as const) {
        if (req.body[field] !== undefined) {
          patch[field] = req.body[field]
        }
      }
      if (Object.keys(patch).length < 1) {
        return reply.badRequest('No strategy fields provided to update.')
      }

      const invalid =
        (await CARDINAL.models.authentication.validateStrategy({
          id: current.id,
          module: current.module,
          ...patch
        })) ?? CARDINAL.models.authentication.validateConfig(current.module, patch.config)
      if (invalid) {
        return reply.badRequest(invalid)
      }

      if (!(await CARDINAL.models.authentication.updateStrategy(req.params.strategyId, patch))) {
        return reply.internalServerError('Failed to update the authentication strategy.')
      }

      // -> Config holds OAuth client secrets and LDAP bind passwords, so `detail` names which
      //    top-level fields changed, never their values
      await CARDINAL.models.auditLog.record({
        event: 'auth.strategyUpdated',
        actor: actorFromRequest(req),
        targetType: 'authStrategy',
        targetId: current.id,
        targetLabel: current.displayName,
        detail: { module: current.module, changedFields: Object.keys(patch) }
      })

      return {
        ok: true,
        message: 'Authentication strategy updated successfully.'
      }
    }
  )

  app.delete<{ Params: { strategyId: string } }>(
    '/authentication/strategies/:strategyId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Delete an authentication strategy',
        description:
          'Also removes it from every site’s login screen. The built-in local strategy cannot be deleted: every account stores its password under that strategy ID, so removing it would leave no way in.',
        tags: ['Authentication'],
        params: {
          type: 'object',
          properties: {
            strategyId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['strategyId']
        },
        response: {
          204: {
            description: 'Strategy deleted successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            $ref: 'ApiError#',
            description: 'The built-in local strategy cannot be deleted.'
          }
        }
      }
    },
    async (req, reply) => {
      const strategy = await CARDINAL.models.authentication.getStrategyById(req.params.strategyId)
      if (!strategy) {
        return reply.notFound('Authentication strategy does not exist.')
      }
      if (strategy.id === CARDINAL.data.systemIds.localAuthId) {
        return reply.conflict('The built-in local strategy cannot be deleted.')
      }

      await CARDINAL.models.authentication.deleteStrategy(req.params.strategyId)
      return reply.code(204).send()
    }
  )

  app.get(
    '/authentication/synced-groups',
    {
      config: {
        permissions: ['read:users', 'manage:users', 'read:groups', 'manage:groups']
      },
      schema: {
        summary: 'List groups an enabled provider-sync strategy could currently revoke on login',
        description:
          'One entry per group that is on an enabled, `mapGroups`-on strategy’s `mappableGroups` allow-list and not otherwise protected (not the guests group, not a group the same strategy also `autoEnrollGroups`, not a group carrying `manage:system`, not the root administrators group) — i.e. exactly the groups `syncProviderGroups()` could take away from an account on its next login through that strategy. Meant to warn an admin before a manual grant of one of these groups, which may not survive the user’s next provider login.',
        tags: ['Authentication'],
        response: {
          200: {
            description: 'Groups currently at risk of provider-sync reversion',
            $ref: 'AuthGroupSyncWarnings#'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      return CARDINAL.models.authentication.getGroupSyncWarnings()
    }
  )
}

export default routes
