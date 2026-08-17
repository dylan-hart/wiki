import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { filesize } from 'filesize'
import { isNil } from 'es-toolkit/predicate'
import { gte, sql } from 'drizzle-orm'
import {
  groups as groupsTable,
  hooks as hooksTable,
  pages as pagesTable,
  tags as tagsTable,
  users as usersTable
} from '../db/schema.ts'
import maintenance from '../core/maintenance.ts'
import { purgeTimeframes } from '../models/pageHistory.ts'
import type { PurgeTimeframe } from '../models/pageHistory.ts'
import { JOB_STATES } from '../models/jobs.ts'
import type { FastifyInstance } from 'fastify'

/**
 * Every instance connected to this database, with how it is using the connection pool.
 *
 * There is no instance registry: an instance is only known by the connections it holds, which it
 * labels `Wiki.js - <instance id>:<purpose>`. Two of those purposes hold a listener rather than
 * doing query work, so they are counted apart.
 *
 * Shared by the list route and the dashboard count, so that the number on the dashboard is the
 * number of rows the instances page shows.
 */
async function getInstances(): Promise<Record<string, any>[]> {
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

/** How large an uploaded content archive may be — a whole site's worth of asset bytes, not one image. */
const importUploadLimit = 500 * 1024 * 1024

/**
 * System API Routes
 */
async function routes(app: FastifyInstance) {
  // -> An import upload is the raw archive rather than a multipart form, same reasoning and same
  //    pattern as `PUT /sites/:siteId/images/:kind`: one file, no fields, no dependency to add.
  //    Registered inside this plugin, so every other route keeps rejecting this body outright. The
  //    accepted types cover what a browser reports for a `.tar.gz` across platforms.
  app.addContentTypeParser(
    ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: importUploadLimit },
    (req, body, done) => {
      done(null, body)
    }
  )

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
              tagsTotal: {
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
          }
        }
      }
    },
    async () => {
      return {
        activeWorkers: await WIKI.models.jobs.countActive(),
        configFile: path.join(process.cwd(), 'config.yml'),
        cpuCores: os.cpus().length,
        currentVersion: WIKI.version,
        dbHost: WIKI.config.db.host,
        dbVersion: WIKI.dbManager.VERSION,
        groupsTotal: await WIKI.db.$count(groupsTable),
        hostname: os.hostname(),
        httpPort: 0,
        instancesTotal: (await getInstances()).length,
        isApiEnabled: WIKI.config.api.isEnabled === true,
        isMailConfigured: WIKI.config?.mail?.host?.length > 2,
        isMetricsEnabled: WIKI.config.metrics.isEnabled === true,
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
        tagsTotal: await WIKI.db.$count(tagsTable),
        upgradeCapable: !isNil(process.env.UPGRADE_COMPANION),
        usersTotal: await WIKI.db.$count(usersTable),
        webhooksTotal: await WIKI.db.$count(hooksTable),
        workingDirectory: process.cwd()
      }
    }
  )

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
          }
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
          200: { $ref: 'SecurityConfig#' }
        }
      }
    },
    async () => {
      return WIKI.models.security.getConfig()
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
          }
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

      return {
        ok: true,
        message: 'Security configuration updated successfully.'
      }
    }
  )

  /**
   * GET SEARCH CONFIGURATION
   */
  app.get(
    '/search',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get the search configuration',
        description:
          'Search is postgres full-text. `availableDictionaries` lists the text search configurations this database has, which is what a locale may be mapped to.',
        tags: ['System'],
        response: {
          200: {
            description: 'Search configuration',
            type: 'object',
            properties: {
              termHighlighting: {
                type: 'boolean'
              },
              dictOverrides: {
                type: 'object',
                description:
                  'Locale code to postgres dictionary, e.g. `{ "en": "english" }`. Overrides the built-in mapping.',
                additionalProperties: { type: 'string' }
              },
              availableDictionaries: {
                type: 'array',
                description: 'Dictionary names this postgres installation knows.',
                items: { type: 'string' }
              }
            }
          }
        }
      }
    },
    async () => {
      return {
        ...WIKI.models.search.getConfig(),
        availableDictionaries: await WIKI.models.search.getAvailableDictionaries()
      }
    }
  )

  /**
   * UPDATE SEARCH CONFIGURATION
   */
  app.put<{ Body: { termHighlighting?: boolean; dictOverrides?: Record<string, string> } }>(
    '/search',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Update the search configuration',
        description:
          'Every dictionary named in `dictOverrides` must exist in this database, otherwise indexing would fail later, long after the setting was accepted. Changing a mapping affects pages the next time they are indexed — rebuild the index to apply it to existing content.',
        tags: ['System'],
        body: {
          type: 'object',
          properties: {
            termHighlighting: {
              type: 'boolean'
            },
            dictOverrides: {
              type: 'object',
              description: 'Locale code to postgres dictionary. Replaces the stored mapping.',
              additionalProperties: { type: 'string' }
            }
          }
        },
        response: {
          200: {
            description: 'Search configuration updated successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      if (req.body.termHighlighting === undefined && req.body.dictOverrides === undefined) {
        return reply.badRequest('No search settings provided to update.')
      }

      if (req.body.dictOverrides) {
        const available = await WIKI.models.search.getAvailableDictionaries()
        for (const [locale, dictionary] of Object.entries(req.body.dictOverrides)) {
          if (!/^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/.test(locale)) {
            return reply.badRequest(`"${locale}" is not a valid locale code.`)
          }
          if (!available.includes(dictionary)) {
            return reply.badRequest(
              `"${dictionary}" is not a text search dictionary in this database.`
            )
          }
        }
      }

      const previousConfig = WIKI.config.search
      WIKI.config.search = {
        ...previousConfig,
        ...(req.body.termHighlighting !== undefined && {
          termHighlighting: req.body.termHighlighting
        }),
        ...(req.body.dictOverrides !== undefined && { dictOverrides: req.body.dictOverrides })
      }

      if (!(await WIKI.configSvc.saveToDb(['search']))) {
        WIKI.config.search = previousConfig
        return reply.internalServerError('Failed to save the search configuration.')
      }

      return {
        ok: true,
        message: 'Search configuration updated successfully.'
      }
    }
  )

  /**
   * REBUILD SEARCH INDEX
   */
  app.post(
    '/search/rebuild',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Rebuild the search index',
        description:
          'Queues a job that recomputes the search vector of every page from its stored content, using the dictionary mapping in force. Runs in the background: the response only says the job was queued.',
        tags: ['System'],
        response: {
          200: {
            description: 'Rebuild queued successfully',
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
                description: 'ID of the queued job, which the scheduler view lists.'
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const added = await WIKI.scheduler.addJob({ task: 'rebuildSearchIndex' })
      if (!added?.id) {
        return reply.internalServerError('The scheduler could not queue the rebuild.')
      }
      return {
        ok: true,
        message: 'Search index rebuild queued successfully.',
        id: added.id
      }
    }
  )

  /**
   * LIST EXTENSIONS
   */
  app.get(
    '/extensions',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List optional extensions',
        description:
          'Third-party tooling that unlocks extra functionality, with whether each one is present on this system. Detection runs per request, so installing a tool shows up without a restart.',
        tags: ['System'],
        response: {
          200: {
            description: 'List of extensions',
            type: 'array',
            items: { $ref: 'Extension#' }
          }
        }
      }
    },
    async () => {
      return WIKI.models.extensions.getExtensions()
    }
  )

  /**
   * INSTALL EXTENSION
   */
  app.post<{ Params: { extensionKey: string } }>(
    '/extensions/:extensionKey/install',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Install or reinstall an extension',
        description:
          'Only extensions flagged `isInstallable` can be installed from here — the npm packages, which are Sharp and Puppeteer. For Sharp this is mostly a repair: it already ships as an optional dependency, and refetching it replaces a prebuilt binary that is missing or does not match this OS and architecture. Puppeteer is not shipped at all, so this is a first install, and it fetches a Chromium build of a few hundred megabytes unless the server points at one it already has through `PUPPETEER_EXECUTABLE_PATH`. Git and Pandoc come from the operating system and answer 409 pointing at the documentation. Runs npm and can take minutes — allow the request a correspondingly long timeout.',
        tags: ['System'],
        params: {
          type: 'object',
          properties: {
            extensionKey: {
              type: 'string',
              maxLength: 255
            }
          },
          required: ['extensionKey']
        },
        response: {
          200: {
            description: 'Extension installed successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              restartRequired: {
                type: 'boolean',
                description:
                  'True when this server already tried and failed to load the module. Node replays a failed module load for the life of the process, so the repaired files cannot be used until the server restarts.'
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const definition = WIKI.models.extensions.getDefinition(req.params.extensionKey)
      if (!definition) {
        return reply.notFound('Extension does not exist.')
      }
      if (!WIKI.models.extensions.isCompatible(definition)) {
        return reply.conflict('This extension is not compatible with this system.')
      }
      if (definition.isInstallable !== true) {
        return reply.conflict(
          `${definition.title} must be installed manually. See the documentation for instructions.`
        )
      }

      try {
        await WIKI.models.extensions.install(definition)
      } catch (err: any) {
        // -> The message carries npm's own output, which is the only thing that explains a failure
        //    like a missing build toolchain. An administrator is the only caller.
        return reply.internalServerError(err.message)
      }

      // -> A fresh install is usable at once, since nothing has tried to load it yet. Repairing one this
      //    process already choked on is a different story, and saying so beats leaving an administrator
      //    to wonder why nothing changed.
      const restartRequired = WIKI.models.extensions.hasLoadFailed(definition)

      return {
        ok: true,
        message: restartRequired
          ? `${definition.title} was reinstalled, but this server has to be restarted before it can use it.`
          : `${definition.title} installed successfully.`,
        restartRequired
      }
    }
  )

  /**
   * GET API STATE
   */
  app.get(
    '/api',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get the API state',
        description:
          'Whether API keys are accepted. While this is off, every request presenting a key is rejected, no matter how valid the key is.',
        tags: ['System'],
        response: {
          200: {
            description: 'API state',
            type: 'object',
            properties: {
              isEnabled: {
                type: 'boolean'
              }
            }
          }
        }
      }
    },
    async () => {
      return { isEnabled: WIKI.config.api.isEnabled === true }
    }
  )

  /**
   * SET API STATE
   */
  app.put<{ Body: { isEnabled: boolean } }>(
    '/api',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Turn the API on or off',
        description:
          'Turning it off stops every API key from authenticating, without revoking any of them. Session-authenticated requests, i.e. the admin area itself, are unaffected.',
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
            description: 'API state updated successfully',
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
          }
        }
      }
    },
    async (req, reply) => {
      const previousConfig = WIKI.config.api
      WIKI.config.api = { ...previousConfig, isEnabled: req.body.isEnabled }

      if (!(await WIKI.configSvc.saveToDb(['api']))) {
        WIKI.config.api = previousConfig
        return reply.internalServerError('Failed to save the API state.')
      }

      return {
        ok: true,
        message: req.body.isEnabled ? 'API enabled successfully.' : 'API disabled successfully.',
        isEnabled: req.body.isEnabled
      }
    }
  )

  /**
   * GET METRICS ENDPOINT STATE
   */
  app.get(
    '/metrics',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get the metrics endpoint state',
        description:
          'Whether the Prometheus metrics endpoint is turned on. The endpoint itself is not implemented yet — see the description of the PUT counterpart.',
        tags: ['System'],
        response: {
          200: {
            description: 'Metrics endpoint state',
            type: 'object',
            properties: {
              isEnabled: {
                type: 'boolean'
              }
            }
          }
        }
      }
    },
    async () => {
      return { isEnabled: WIKI.config.metrics.isEnabled === true }
    }
  )

  /**
   * SET METRICS ENDPOINT STATE
   */
  app.put<{ Body: { isEnabled: boolean } }>(
    '/metrics',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Turn the metrics endpoint on or off',
        description:
          'Stores the state and nothing more, for now: the `/metrics` endpoint it governs is not implemented, and its documented `read:metrics` bearer authentication depends on API keys, which are not implemented either.',
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
            description: 'Metrics endpoint state updated successfully',
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
          }
        }
      }
    },
    async (req, reply) => {
      const previousConfig = WIKI.config.metrics
      WIKI.config.metrics = { ...previousConfig, isEnabled: req.body.isEnabled }

      if (!(await WIKI.configSvc.saveToDb(['metrics']))) {
        WIKI.config.metrics = previousConfig
        return reply.internalServerError('Failed to save the metrics endpoint state.')
      }

      return {
        ok: true,
        message: req.body.isEnabled
          ? 'Metrics endpoint enabled successfully.'
          : 'Metrics endpoint disabled successfully.',
        isEnabled: req.body.isEnabled
      }
    }
  )

  /**
   * LIST SYSTEM INSTANCES
   */
  app.get(
    '/instances',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'List System Instances',
        tags: ['System'],
        response: {
          200: {
            description: 'List of all system instances',
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
          }
        }
      }
    },
    async () => {
      return getInstances()
    }
  )

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
          }
        }
      }
    },
    async () => {
      const count = maintenance.disconnectWebsockets()
      WIKI.events.outbound.emit('disconnectWebsockets')
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
          }
        }
      }
    },
    async () => {
      await maintenance.flushCaches()
      WIKI.events.outbound.emit('flushCaches')
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
          }
        }
      }
    },
    async () => {
      return { generatedAt: WIKI.models.apiKeys.certificatesGeneratedAt() }
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
          }
        }
      }
    },
    async (req, reply) => {
      const invalidatedKeys = await WIKI.models.apiKeys.regenerateCertificates()
      if (invalidatedKeys === null) {
        return reply.internalServerError('Failed to save the new certificates.')
      }
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
          }
        }
      }
    },
    async () => {
      const count = await WIKI.models.apiKeys.purgeRevoked()
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
          }
        }
      }
    },
    async (req, reply) => {
      const count = await WIKI.models.sessions.rotateSecret()
      if (count === null) {
        return reply.internalServerError('Failed to save the new session secret.')
      }

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
          }
        }
      }
    },
    async (req) => {
      const count = await WIKI.models.pageHistory.purge(req.body.olderThan)
      return {
        ok: true,
        message: `Purged ${count} page version(s).`,
        count
      }
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
          }
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

  /**
   * EXPORT CONTENT
   */
  app.post<{ Body: { siteId: string } }>(
    '/export',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: "Export a site's content",
        description:
          'Queues a background job that serializes the pages, tree, assets (with their stored bytes) and groups into a single tarball under `<dataPath>/exports/`. Mirrors `POST /extensions/:key/install`: a large site can take a while to serialize, so allow the request a correspondingly long timeout even though the response itself only says the job was queued — poll the scheduler view for completion, then call the download route below.',
        tags: ['System'],
        body: {
          type: 'object',
          required: ['siteId'],
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            }
          }
        },
        response: {
          200: {
            description: 'Export queued successfully',
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
                description:
                  'ID of the queued job. Pass it to the download route once it completes.'
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const added = await WIKI.scheduler.addJob({
        task: 'exportContent',
        payload: { siteId: req.body.siteId }
      })
      if (!added?.id) {
        return reply.internalServerError('The scheduler could not queue the export.')
      }
      return {
        ok: true,
        message: 'Content export queued successfully.',
        id: added.id
      }
    }
  )

  /**
   * DOWNLOAD CONTENT EXPORT
   */
  app.get<{ Params: { jobId: string } }>(
    '/export/:jobId/download',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Download a finished content export',
        description:
          "404s when no such export job exists (or its file has already been cleaned up), 409 when the job exists but has not completed yet. The file is deleted once it has finished streaming, so a job's tarball can only be downloaded once — queue a fresh export for another copy.",
        tags: ['System'],
        params: {
          type: 'object',
          required: ['jobId'],
          properties: {
            jobId: {
              type: 'string',
              format: 'uuid'
            }
          }
        },
        response: {
          200: {
            description: 'The tarball',
            content: {
              'application/gzip': {
                schema: {
                  type: 'string',
                  format: 'binary'
                }
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const entry = await WIKI.models.jobs.getHistoryEntry(req.params.jobId)
      if (!entry || entry.task !== 'exportContent') {
        return reply.notFound('No such export job.')
      }
      if (entry.state !== 'completed') {
        return reply.conflict('This export has not finished yet.')
      }

      const result = entry.result as { filePath: string; fileSize: number } | null
      if (!result?.filePath) {
        return reply.notFound('This export left no file behind.')
      }

      let stat
      try {
        stat = await fsp.stat(result.filePath)
      } catch {
        return reply.notFound('This export file is no longer available.')
      }

      const stream = fs.createReadStream(result.filePath)
      // -> Best-effort cleanup once the bytes are actually on the wire, not before: deleting on the
      //    happy path here is what keeps a downloaded export from sitting in `<dataPath>/exports/`
      //    until `purgeExports` gets to it on its own schedule.
      stream.on('close', () => {
        WIKI.models.export.deleteExport(result.filePath).catch(() => {})
      })

      reply.header('Content-Disposition', `attachment; filename="export-${entry.id}.tar.gz"`)
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Content-Length', stat.size)
      return reply.type('application/gzip').send(stream)
    }
  )

  /**
   * IMPORT CONTENT
   */
  app.post<{ Querystring: { targetSiteId: string } }>(
    '/import',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Import content into a site',
        description:
          "The body is the raw archive produced by `POST /export`'s download, not a multipart form — send the file itself with its `Content-Type`. At most " +
          `${importUploadLimit / 1024 / 1024} MB. Queues a background job, mirroring \`POST /export\`: reading a whole archive back apart and restoring it is not something a request thread should be blocked on, so the response only confirms the job was queued — poll the scheduler view for completion.\n\n` +
          "**This replaces the target site's content, it does not merge with it.** Every page, tree entry (folder/page/asset) and asset already on `targetSiteId` is deleted before the archive's own are restored — an import puts the site back to exactly what the archive describes. Groups are the one exception: being global rather than site-scoped, each imported group updates one already on this instance if its id matches, or is added as a new one otherwise, rather than the whole `groups` table being replaced. The target site's own config, hostname and enabled state are left untouched — only pages, tree entries, assets and groups are restored. Every restored page's and asset's author/creator/owner is rewritten to the account performing the import, since accounts are not part of the archive, and every restored page/tree entry/asset gets a freshly generated id rather than reusing the one it had in the archive — that id space is instance-wide, not per-site, so reusing it would collide with the source site's own rows the moment that site still exists in the same database (restoring onto a *different* site than the one exported, or restoring a backup while the original is still around, are both ordinary uses of this). Groups are the one exception, matched by id on purpose.\n\nThe restore runs inside a single database transaction: a failure partway through — a malformed archive, a constraint violation — leaves the target site exactly as it was, never half-restored. An archive whose format version this instance does not recognize is refused outright before anything is touched, the same way.",
        tags: ['System'],
        consumes: ['application/gzip', 'application/x-gzip', 'application/octet-stream'],
        querystring: {
          type: 'object',
          required: ['targetSiteId'],
          properties: {
            targetSiteId: {
              type: 'string',
              format: 'uuid',
              description: 'The site whose content is replaced by this archive.'
            }
          }
        },
        response: {
          200: {
            description: 'Import queued successfully',
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
                description: 'ID of the queued job.'
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const data = req.body
      if (!Buffer.isBuffer(data) || data.length < 1) {
        return reply.badRequest('No archive was sent.')
      }
      // -> The declared content type got the request this far; the gzip magic number is a cheap
      //    sanity check before saving it to disk at all. The archive's actual structure and format
      //    version are validated inside the queued job, which is where it is really read apart.
      if (data[0] !== 0x1f || data[1] !== 0x8b) {
        return reply.badRequest('Not a gzip archive, whatever the request said it was.')
      }

      const targetSite = await WIKI.models.sites.getSiteById({ id: req.query.targetSiteId })
      if (!targetSite) {
        return reply.notFound('Target site does not exist.')
      }

      const filePath = await WIKI.models.import.saveUpload(data)
      const added = await WIKI.scheduler.addJob({
        task: 'importContent',
        payload: {
          filePath,
          targetSiteId: req.query.targetSiteId,
          importedById: req.session.user!.id
        }
      })
      if (!added?.id) {
        return reply.internalServerError('The scheduler could not queue the import.')
      }
      return {
        ok: true,
        message: 'Content import queued successfully.',
        id: added.id
      }
    }
  )

  /**
   * SCAN FOR PAGE PROBLEMS
   */
  app.post(
    '/pages/scan',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Scan for page problems',
        description:
          'Queues a background job that runs four integrity checks across every site: pages whose stored hash has drifted from their path, tree entries and pages that have diverged from each other, duplicate (site, locale, path) tuples, and page relations pointing at a page that no longer exists. Runs in the background — a full scan is not instant on a large wiki — and only reports; nothing is repaired automatically. Poll `GET /pages/scan/:jobId` for the result.',
        tags: ['System'],
        response: {
          200: {
            description: 'Scan queued successfully',
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
          }
        }
      }
    },
    async (req, reply) => {
      const added = await WIKI.scheduler.addJob({ task: 'scanPageProblems' })
      if (!added?.id) {
        return reply.internalServerError('The scheduler could not queue the scan.')
      }
      return {
        ok: true,
        message: 'Page problems scan queued successfully.',
        id: added.id
      }
    }
  )

  /**
   * GET PAGE PROBLEMS SCAN RESULT
   */
  app.get<{ Params: { jobId: string } }>(
    '/pages/scan/:jobId',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Get a page problems scan job',
        description:
          "The job's current state, and its report once `state` is `completed`. 404s when no such scan job exists.",
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
            description: 'Scan job state and, once completed, its report',
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
                  hashDrift: {
                    type: 'object',
                    description:
                      'Pages whose stored hash no longer matches generatePathHash(path).',
                    properties: {
                      count: { type: 'integer' },
                      entries: { type: 'array', items: { type: 'object' } }
                    }
                  },
                  treeDivergence: {
                    type: 'object',
                    description:
                      'Tree entries and pages that have diverged from each other, matched by id.',
                    properties: {
                      count: { type: 'integer' },
                      entries: { type: 'array', items: { type: 'object' } }
                    }
                  },
                  duplicatePaths: {
                    type: 'object',
                    description: 'Groups of pages sharing the same (siteId, locale, path).',
                    properties: {
                      count: { type: 'integer' },
                      entries: { type: 'array', items: { type: 'object' } }
                    }
                  },
                  brokenRelations: {
                    type: 'object',
                    description: 'Page relations pointing at a page that no longer exists.',
                    properties: {
                      count: { type: 'integer' },
                      entries: { type: 'array', items: { type: 'object' } }
                    }
                  },
                  scannedAt: {
                    type: 'string',
                    format: 'date-time'
                  }
                }
              }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const entry = await WIKI.models.jobs.getHistoryEntry(req.params.jobId)
      if (entry) {
        if (entry.task !== 'scanPageProblems') {
          return reply.notFound('No such scan job.')
        }
        return {
          state: entry.state,
          result: entry.result ?? null
        }
      }

      // -> Not in history yet: it may simply not have been picked up off the queue by any instance
      //    yet, which is not the same as not existing (see `Jobs#getPendingEntry`)
      const pending = await WIKI.models.jobs.getPendingEntry(req.params.jobId)
      if (!pending || pending.task !== 'scanPageProblems') {
        return reply.notFound('No such scan job.')
      }
      return { state: 'queued', result: null }
    }
  )
}

export default routes
