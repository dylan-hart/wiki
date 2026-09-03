import { actorFromRequest } from '../../models/auditLog.ts'
import type { FastifyInstance } from 'fastify'

/**
 * Authentication strategy administration (`manage:system`): the modules this instance ships, the
 * strategies configured from them, and creating, updating or deleting one.
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST AUTHENTICATION MODULES
   */
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
      return WIKI.models.authentication.getModules()
    }
  )

  /**
   * LIST CONFIGURED STRATEGIES
   */
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
      return WIKI.models.authentication.getActiveStrategies({ mask: true })
    }
  )

  /**
   * GET CONFIGURED STRATEGY
   */
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
      const strategy = await WIKI.models.authentication.getStrategyById(req.params.strategyId, {
        mask: true
      })
      if (!strategy) {
        return reply.notFound('Authentication strategy does not exist.')
      }
      return strategy
    }
  )

  /**
   * CREATE STRATEGY
   */
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
      const mod = WIKI.models.authentication.getModule(req.body.module)
      if (!mod) {
        return reply.badRequest('ERR_UNKNOWN_AUTH_MODULE')
      }

      const invalid =
        (await WIKI.models.authentication.validateStrategy({
          module: req.body.module,
          displayName: req.body.displayName,
          isEnabled: req.body.isEnabled,
          allowedEmailRegex: req.body.allowedEmailRegex,
          allowedEmailDomains: req.body.allowedEmailDomains,
          autoEnrollGroups: req.body.autoEnrollGroups,
          mappableGroups: req.body.mappableGroups
        })) ?? WIKI.models.authentication.validateConfig(req.body.module, req.body.config)
      if (invalid) {
        return reply.badRequest(invalid)
      }

      const id = await WIKI.models.authentication.createStrategy(req.body as any)

      return {
        ok: true,
        message: 'Authentication strategy created successfully.',
        id
      }
    }
  )

  /**
   * UPDATE STRATEGY
   */
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
      const current = await WIKI.models.authentication.getStrategyById(req.params.strategyId)
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
        (await WIKI.models.authentication.validateStrategy({
          id: current.id,
          module: current.module,
          ...patch
        })) ?? WIKI.models.authentication.validateConfig(current.module, patch.config)
      if (invalid) {
        return reply.badRequest(invalid)
      }

      if (!(await WIKI.models.authentication.updateStrategy(req.params.strategyId, patch))) {
        return reply.internalServerError('Failed to update the authentication strategy.')
      }

      // -> Config holds OAuth client secrets and LDAP bind passwords, so `detail` names which
      //    top-level fields changed rather than their values -- `changedFields` never descends into
      //    `patch.config` itself. Mirrors `storage.targetUpdated` in `api/storage.ts`.
      await WIKI.models.auditLog.record({
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

  /**
   * DELETE STRATEGY
   */
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
      const strategy = await WIKI.models.authentication.getStrategyById(req.params.strategyId)
      if (!strategy) {
        return reply.notFound('Authentication strategy does not exist.')
      }
      if (strategy.id === WIKI.data.systemIds.localAuthId) {
        return reply.conflict('The built-in local strategy cannot be deleted.')
      }

      await WIKI.models.authentication.deleteStrategy(req.params.strategyId)
      return reply.code(204).send()
    }
  )
}

export default routes
