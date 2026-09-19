import path from 'node:path'
import os from 'node:os'
import { isNil } from 'es-toolkit/predicate'
import { gte, sql } from 'drizzle-orm'
import { formatByteSize } from '../../helpers/common.ts'
import {
  groups as groupsTable,
  hooks as hooksTable,
  pages as pagesTable,
  users as usersTable
} from '../../db/schema.ts'
import type { FastifyInstance } from 'fastify'

/**
 * There is no node registry: a node is known only by the connections it holds, which it labels
 * `Cardinal.js - <instance id>:<purpose>`. Every purpose but `MAIN`/`WORKER` holds a listener
 * rather than doing query work, so it is counted apart.
 */
export async function getClusterNodes(): Promise<Record<string, any>[]> {
  const instRaw = await CARDINAL.db.execute(
    sql`SELECT usename, client_addr, application_name, backend_start, state_change FROM pg_stat_activity WHERE datname = ${CARDINAL.dbManager.dbName} AND application_name LIKE 'Cardinal.js%'`
  )
  const insts: Record<string, any> = {}
  for (const inst of instRaw.rows as any[]) {
    // -> By separator, never by fixed offset: an offset silently returns the wrong slice the moment
    //    the product-name prefix changes length.
    const instId = inst.application_name.split(' - ')[1]?.split(':')[0] ?? ''
    const conType = [':MAIN', ':WORKER'].some((ct) => inst.application_name.endsWith(ct))
      ? 'main'
      : 'sub'
    // -> Raw `db.execute()` returns timestamps as postgres-format strings
    //    (`2026-07-25 13:17:36.230177+00`), not Dates. `Temporal.Instant.from` parses that as-is,
    //    space separator and hour-only offset included.
    inst.backend_start = Temporal.Instant.from(inst.backend_start).toString({
      smallestUnit: 'millisecond'
    })
    inst.state_change = Temporal.Instant.from(inst.state_change).toString({
      smallestUnit: 'millisecond'
    })
    const curInst = insts[instId] ?? {
      activeConnections: 0,
      activeListeners: 0,
      dbFirstSeen: inst.backend_start,
      dbLastSeen: inst.state_change
    }
    insts[instId] = {
      id: instId,
      activeConnections:
        conType === 'main' ? curInst.activeConnections + 1 : curInst.activeConnections,
      activeListeners: conType === 'sub' ? curInst.activeListeners + 1 : curInst.activeListeners,
      dbUser: inst.usename,
      dbFirstSeen:
        curInst.dbFirstSeen > inst.backend_start ? inst.backend_start : curInst.dbFirstSeen,
      dbLastSeen: curInst.dbLastSeen < inst.state_change ? inst.state_change : curInst.dbLastSeen,
      ip: inst.client_addr
    }
  }
  return Object.values(insts)
}

async function routes(app: FastifyInstance) {
  app.get(
    '/info',
    {
      config: {
        permissions: ['access:admin']
      },
      schema: {
        summary: 'System Info',
        tags: ['System'],
        response: {
          200: {
            description: 'System Info',
            type: 'object',
            properties: {
              activeWorkers: {
                type: 'number',
                description:
                  'Jobs running right now on every instance combined, one worker slot each.'
              },
              clusterTotal: {
                type: 'number',
                description: 'Cluster nodes currently connected to this database.'
              },
              configFile: {
                type: 'string'
              },
              cpuCores: {
                type: 'number'
              },
              currentVersion: {
                type: 'string'
              },
              dbHost: {
                type: 'string'
              },
              dbVersion: {
                type: 'string'
              },
              groupsTotal: {
                type: 'number'
              },
              hostname: {
                type: 'string'
              },
              httpPort: {
                type: 'number'
              },
              instancesTotal: {
                type: 'number',
                description: 'Instances currently connected to this database.'
              },
              isMailConfigured: {
                type: 'boolean'
              },
              isMailBaseURLConfigured: {
                type: 'boolean',
                description:
                  'Whether any mail link this instance sends would resolve to a real host: `mail.defaultBaseURL` is set, or at least one site has a real (non-`*`) hostname (OpenProject #3386).'
              },
              isApiEnabled: {
                type: 'boolean',
                description: 'Whether API keys are accepted.'
              },
              isMetricsEnabled: {
                type: 'boolean',
                description: 'Whether the Prometheus metrics endpoint is turned on.'
              },
              isPageviewsEnabled: {
                type: 'boolean',
                description: 'Whether page views are logged (OpenProject #1238).'
              },
              isReplicationEnabled: {
                type: 'boolean',
                description:
                  'Whether scheduled instance replication is turned on (OpenProject #2491).'
              },
              isSchedulerHealthy: {
                type: 'boolean',
                description:
                  'False when no instance has refreshed the scheduler cron lock recently, i.e. scheduled jobs are no longer being queued.'
              },
              latestVersion: {
                type: 'string'
              },
              latestVersionReleaseDate: {
                type: 'string',
                format: 'date-time'
              },
              loginsPastDay: {
                type: 'number'
              },
              nodeVersion: {
                type: 'string'
              },
              operatingSystem: {
                type: 'string'
              },
              pagesTotal: {
                type: 'number'
              },
              platform: {
                type: 'string'
              },
              ramTotal: {
                type: 'string'
              },
              upgradeCapable: {
                type: 'boolean'
              },
              usersTotal: {
                type: 'number'
              },
              webhooksTotal: {
                type: 'number'
              },
              workingDirectory: {
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
      const clusterNodesTotal = (await getClusterNodes()).length
      return {
        activeWorkers: await CARDINAL.models.jobs.countActive(),
        clusterTotal: clusterNodesTotal,
        configFile: path.join(process.cwd(), 'config.yml'),
        cpuCores: os.cpus().length,
        currentVersion: CARDINAL.version,
        dbHost: CARDINAL.config.db.host,
        dbVersion: CARDINAL.dbManager.VERSION,
        groupsTotal: await CARDINAL.db.$count(groupsTable),
        hostname: os.hostname(),
        httpPort: CARDINAL.config.port,
        instancesTotal: clusterNodesTotal,
        isApiEnabled: CARDINAL.config.api.isEnabled === true,
        isMailConfigured: CARDINAL.config?.mail?.host?.length > 2,
        isMailBaseURLConfigured: CARDINAL.models.mail.hasResolvableBaseURL(),
        isMetricsEnabled: CARDINAL.config.metrics.isEnabled === true,
        isPageviewsEnabled: CARDINAL.config.pageviews.isEnabled === true,
        isReplicationEnabled: CARDINAL.config.replication?.isEnabled === true,
        isSchedulerHealthy: await CARDINAL.models.jobs.isHealthy(),
        latestVersion: CARDINAL.config.update.version,
        latestVersionReleaseDate: CARDINAL.config.update.versionDate,
        loginsPastDay: await CARDINAL.db.$count(
          usersTable,
          gte(usersTable.lastLoginAt, sql`NOW() - INTERVAL '1 DAY'`)
        ),
        nodeVersion: process.version.substring(1),
        operatingSystem: `${os.type()} (${os.platform()}) ${os.release()} ${os.arch()}`,
        pagesTotal: await CARDINAL.db.$count(pagesTable),
        platform: os.platform(),
        ramTotal: formatByteSize(os.totalmem()),
        upgradeCapable: !isNil(process.env.UPGRADE_COMPANION),
        usersTotal: await CARDINAL.db.$count(usersTable),
        webhooksTotal: await CARDINAL.db.$count(hooksTable),
        workingDirectory: process.cwd()
      }
    }
  )

  app.get(
    '/cluster',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List Cluster Nodes',
        tags: ['System'],
        response: {
          200: {
            description: 'List of all cluster nodes',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string'
                },
                activeConnections: {
                  type: 'number'
                },
                activeListeners: {
                  type: 'number'
                },
                dbUser: {
                  type: 'string'
                },
                dbFirstSeen: {
                  type: 'string',
                  format: 'date-time'
                },
                dbLastSeen: {
                  type: 'string',
                  format: 'date-time'
                },
                ip: {
                  type: 'string'
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
      return getClusterNodes()
    }
  )

  app.post(
    '/checkForUpdate',
    {
      config: {
        permissions: ['access:admin']
      },
      schema: {
        summary: 'Check for Updates',
        tags: ['System'],
        response: {
          200: {
            description: 'Update Info',
            type: 'object',
            properties: {
              current: {
                type: 'string'
              },
              latest: {
                type: 'string'
              },
              latestDate: {
                type: 'string',
                format: 'date-time'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async () => {
      const renderJob = await CARDINAL.scheduler.addJob({
        task: 'checkVersion',
        maxRetries: 0,
        promise: true
      })
      // -> `addJob` resolves to undefined when enqueueing failed, and this then throws into a 500.
      await renderJob!.promise
      return {
        current: CARDINAL.version,
        latest: CARDINAL.config.update.version,
        latestDate: CARDINAL.config.update.versionDate
      }
    }
  )
}

export default routes
