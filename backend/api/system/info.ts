import path from 'node:path'
import os from 'node:os'
import { filesize } from 'filesize'
import { isNil } from 'es-toolkit/predicate'
import { gte, sql } from 'drizzle-orm'
import {
  groups as groupsTable,
  hooks as hooksTable,
  pages as pagesTable,
  users as usersTable
} from '../../db/schema.ts'
import type { FastifyInstance } from 'fastify'

/**
 * Every node of this cluster connected to this database, with how it is using the connection pool.
 *
 * There is no node registry: a node is only known by the connections it holds, which it labels
 * `Wiki.js - <instance id>:<purpose>`. Two of those purposes hold a listener rather than doing query
 * work, so they are counted apart.
 *
 * Shared by the list route and the dashboard count, so that the number on the dashboard is the
 * number of rows the cluster page shows. Also exported so `controllers/metrics.ts` can source
 * `instancesTotal` from the same query rather than inventing a second one.
 */
export async function getClusterNodes(): Promise<Record<string, any>[]> {
  const instRaw = await WIKI.db.execute(
    sql`SELECT usename, client_addr, application_name, backend_start, state_change FROM pg_stat_activity WHERE datname = ${WIKI.dbManager.dbName} AND application_name LIKE 'Wiki.js%'`
  )
  const insts: Record<string, any> = {}
  for (const inst of instRaw.rows as any[]) {
    const instId = inst.application_name.substring(10, 20)
    const conType = [':MAIN', ':WORKER'].some((ct) => inst.application_name.endsWith(ct))
      ? 'main'
      : 'sub'
    // -> `db.execute()` with a raw SQL template returns timestamps as postgres-format strings
    //    (e.g. `2026-07-25 13:17:36.230177+00`) rather than Dates, which is what the previous
    //    `DateTime.fromSQL()` call was for. Temporal.Instant.from parses that format as-is,
    //    including the space separator and the hour-only `+00` offset. Rendered with
    //    millisecond precision to match the timestamps produced elsewhere.
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

/**
 * Read-only system information: the instance/database/runtime summary the admin dashboard opens
 * with, the cluster-node listing behind it, and the upstream version check.
 */
async function routes(app: FastifyInstance) {
  /**
   * SYSTEM INFO
   */
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
        activeWorkers: await WIKI.models.jobs.countActive(),
        clusterTotal: clusterNodesTotal,
        configFile: path.join(process.cwd(), 'config.yml'),
        cpuCores: os.cpus().length,
        currentVersion: WIKI.version,
        dbHost: WIKI.config.db.host,
        dbVersion: WIKI.dbManager.VERSION,
        groupsTotal: await WIKI.db.$count(groupsTable),
        hostname: os.hostname(),
        httpPort: WIKI.config.port,
        instancesTotal: clusterNodesTotal,
        isApiEnabled: WIKI.config.api.isEnabled === true,
        isMailConfigured: WIKI.config?.mail?.host?.length > 2,
        isMetricsEnabled: WIKI.config.metrics.isEnabled === true,
        isPageviewsEnabled: WIKI.config.pageviews.isEnabled === true,
        isSchedulerHealthy: await WIKI.models.jobs.isHealthy(),
        latestVersion: WIKI.config.update.version,
        latestVersionReleaseDate: WIKI.config.update.versionDate,
        loginsPastDay: await WIKI.db.$count(
          usersTable,
          gte(usersTable.lastLoginAt, sql`NOW() - INTERVAL '1 DAY'`)
        ),
        nodeVersion: process.version.substring(1),
        operatingSystem: `${os.type()} (${os.platform()}) ${os.release()} ${os.arch()}`,
        pagesTotal: await WIKI.db.$count(pagesTable),
        platform: os.platform(),
        ramTotal: filesize(os.totalmem()),
        upgradeCapable: !isNil(process.env.UPGRADE_COMPANION),
        usersTotal: await WIKI.db.$count(usersTable),
        webhooksTotal: await WIKI.db.$count(hooksTable),
        workingDirectory: process.cwd()
      }
    }
  )

  /**
   * LIST CLUSTER NODES
   */
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

  /**
   * CHECK FOR UPDATE
   */
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
      const renderJob = await WIKI.scheduler.addJob({
        task: 'checkVersion',
        maxRetries: 0,
        promise: true
      })
      // NOTE: `addJob` resolves to undefined if enqueueing failed, in which case this throws —
      // preserving the existing behavior.
      await renderJob!.promise
      return {
        current: WIKI.version,
        latest: WIKI.config.update.version,
        latestDate: WIKI.config.update.versionDate
      }
    }
  )
}

export default routes
