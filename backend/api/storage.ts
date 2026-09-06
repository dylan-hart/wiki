import type { FastifyInstance } from 'fastify'
import { actorFromRequest } from '../models/auditLog.ts'
import { SYNC_SHAPED_ACTIONS } from '../models/storage.ts'
import type { StorageTargetInput } from '../models/storage.ts'

/**
 * Storage API Routes
 */
async function routes(app: FastifyInstance) {
  /**
   * LIST SITE STORAGE TARGETS
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/storage/targets',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List the storage targets of a site',
        description:
          'One target per storage module installed in `modules/storage`, whether or not it has ever been enabled. Configuration values include any credentials a module stores, hence the `manage:system` requirement. A module that only implements explicit actions (e.g. disk, sftp) never runs a background sync, but every module ships an implementation an enabled target can call.',
        tags: ['Storage'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'List of storage targets',
            type: 'array',
            items: { $ref: 'StorageTarget#' }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req) => {
      return WIKI.models.storage.getSiteTargets(req.params.siteId, { mask: true })
    }
  )

  /**
   * GET STORAGE TARGET SYNC STATUS
   */
  app.get<{ Params: { siteId: string; targetId: string } }>(
    '/sites/:siteId/storage/targets/:targetId/sync-status',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get the sync status of a storage target',
        description:
          'Read from the content sync state table every dispatched sync eventually writes to. Empty for a target nothing has ever synced to yet — either it has never been enabled, or its module only implements explicit actions and never runs a background sync (see `supportsContentSync`).',
        tags: ['Storage'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            targetId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId', 'targetId']
        },
        response: {
          200: { $ref: 'StorageSyncStatus#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const target = await WIKI.models.storage.getSiteTargetById(
        req.params.siteId,
        req.params.targetId
      )
      if (!target) {
        return reply.notFound('Storage target does not exist.')
      }
      return WIKI.models.contentSync.getTargetSummary(target.id, { siteId: req.params.siteId })
    }
  )

  /**
   * UPDATE SITE STORAGE TARGETS
   */
  app.put<{ Params: { siteId: string }; Body: { targets: StorageTargetInput[] } }>(
    '/sites/:siteId/storage/targets',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Update the storage targets of a site',
        description:
          'Only the targets listed are affected, and within each of them only the fields provided. Every target is validated before any of them is written, so a rejected request changes nothing.',
        tags: ['Storage'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['targets'],
          properties: {
            targets: {
              type: 'array',
              items: { $ref: 'StorageTargetInput#' }
            }
          }
        },
        response: {
          200: {
            description: 'Storage targets updated successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              updated: {
                type: 'integer',
                description:
                  'How many target rows were written. A target already in the requested state still counts.'
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
      // -> Validated as a whole first: a partially applied storage configuration is worse than a
      //    refused one, since the admin area saves every target at once
      const current = await WIKI.models.storage.getSiteTargets(req.params.siteId)
      const patches = []
      for (const patch of req.body.targets) {
        const target = current.find((t) => t.id === patch.id)
        if (!target) {
          return reply.notFound(`Storage target ${patch.id} does not exist.`)
        }
        const invalid = await WIKI.models.storage.validateTarget(target, patch)
        if (invalid) {
          return reply.badRequest(invalid)
        }
        patches.push({ target, patch })
      }

      let updated = 0
      const actor = actorFromRequest(req)
      for (const { target, patch } of patches) {
        if (await WIKI.models.storage.updateTarget(req.params.siteId, target, patch)) {
          updated++
          await WIKI.models.auditLog.record({
            event: 'storage.targetUpdated',
            actor,
            targetType: 'storageTarget',
            targetId: target.id,
            targetLabel: target.title,
            detail: { changedFields: Object.keys(patch) },
            siteId: req.params.siteId
          })
        }
      }

      return {
        ok: true,
        message: 'Storage targets updated successfully.',
        updated
      }
    }
  )

  /**
   * EXECUTE STORAGE TARGET ACTION
   */
  app.post<{
    Params: { siteId: string; targetId: string; action: string }
    Body: { confirmMassDelete?: boolean }
  }>(
    '/sites/:siteId/storage/targets/:targetId/actions/:action',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Run an action on a storage target',
        description:
          "The actions a target offers are listed with it. Only an enabled target can run one, and only a module with an implementation offers any. A sync-shaped action (`sync`, `syncUntracked`, `importAll`) is queued on the scheduler rather than run inline, since it may involve a network round-trip; the response confirms it was queued, not that it completed. Any other action (e.g. `purge`) is expected to be fast and runs synchronously.\n\n`confirmMassDelete` only matters for the `git` module's `sync` action: if a previous sync logged that it held back an unusually large fraction of page deletions (its configured safety threshold), pass `true` here to apply them anyway on this run.",
        tags: ['Storage'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            targetId: {
              type: 'string',
              format: 'uuid'
            },
            action: {
              type: 'string',
              maxLength: 255
            }
          },
          required: ['siteId', 'targetId', 'action']
        },
        response: {
          200: {
            description: 'Action completed successfully',
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
          409: { $ref: 'ApiError#', description: 'The target is disabled.' }
        }
      }
    },
    async (req, reply) => {
      const target = await WIKI.models.storage.getSiteTargetById(
        req.params.siteId,
        req.params.targetId
      )
      if (!target) {
        return reply.notFound('Storage target does not exist.')
      }
      if (!target.isEnabled) {
        return reply.conflict('The storage target must be enabled before running an action.')
      }
      if (!target.actions.some((act) => act.handler === req.params.action)) {
        return reply.badRequest('ERR_UNKNOWN_STORAGE_ACTION')
      }

      // -> A sync-shaped action may do a real network round-trip (a git push/pull, an S3 listing),
      //    which the request thread must not wait on -- queued the same way `dispatchStorage` events
      //    and `storageSyncTick` are, and delivered by the same task. Anything else (e.g. `purge`) is
      //    expected to be fast and stays synchronous.
      if ((SYNC_SHAPED_ACTIONS as readonly string[]).includes(req.params.action)) {
        // -> `confirmMassDelete` only means anything to the git module's `sync` handler (OpenProject
        //    #2429's mass-delete safety guard) — carried through unconditionally for every
        //    sync-shaped action anyway, the same way `data` already is, since a handler that doesn't
        //    read a key it doesn't recognize is simply ignoring it, not misbehaving.
        const added = await WIKI.scheduler.addJob({
          task: 'dispatchStorage',
          payload: {
            targetId: target.id,
            siteId: req.params.siteId,
            handler: req.params.action,
            data: { confirmMassDelete: req.body?.confirmMassDelete === true }
          }
        })
        if (!added?.id) {
          return reply.internalServerError('Failed to queue the action.')
        }
        return {
          ok: true,
          message: `${target.title} "${req.params.action}" action queued.`
        }
      }

      try {
        await WIKI.models.storage.executeAction(target, req.params.action)
      } catch (err: any) {
        WIKI.logger.warn('storage', 'a target action failed', {
          target: target.id,
          module: target.module,
          action: req.params.action,
          error: err
        })
        return reply.badRequest(err.message)
      }

      return {
        ok: true,
        message: 'Action completed successfully.'
      }
    }
  )
}

export default routes
