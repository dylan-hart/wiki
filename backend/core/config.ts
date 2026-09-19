/* eslint-disable no-console -- config resolves before `CARDINAL.logger` is built, so stderr is the only sink it has (see `warnUnknownConfigKeys`'s own doc comment). */
import { toMerged } from 'es-toolkit/object'
import { isPlainObject } from 'es-toolkit/predicate'
import { styleText } from 'node:util'
import cfgHelper from '../helpers/config.ts'
import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import crypto from 'node:crypto'
import { acquireAdvisoryLock } from '../helpers/advisoryLock.ts'
import type { Pool } from 'pg'

/**
 * Assembled at runtime from config.yml + base.yml + the `settings` DB table, so it has no static
 * shape.
 */
type ConfigObject = Record<string, any>

/**
 * Warns once per config.yml key with no counterpart in base.yml's `defaults.config` — the only
 * signal a mistyped key (`logLvel:`) gets, since `toMerged()` accepts it silently.
 *
 * `console.warn`, not `CARDINAL.logger`: `init()` runs before the logger exists, because
 * `logger.init()` itself reads `CARDINAL.config.logLevel`.
 */
function warnUnknownConfigKeys(config: ConfigObject, schema: ConfigObject, pathPrefix = ''): void {
  for (const key of Object.keys(config)) {
    const keyPath = pathPrefix ? `${pathPrefix}.${key}` : key
    if (!Object.hasOwn(schema, key)) {
      console.warn(
        styleText(
          ['yellow', 'bold'],
          `Unknown configuration key \`${keyPath}\` in config.yml — ignored.`
        )
      )
      continue
    }
    if (isPlainObject(config[key]) && isPlainObject(schema[key])) {
      warnUnknownConfigKeys(config[key], schema[key], keyPath)
    }
  }
}

/**
 * Every environment variable that can override `config.yml`, in the order `init()` reads them.
 * Closed on purpose: `overrides=` on the `boot starting` line names members of this list only.
 */
export const CONFIG_OVERRIDE_VARS = ['CONFIG_FILE', 'PORT', 'WIKI_PORT', 'DB_PASS_FILE'] as const

export type ConfigOverrideVar = (typeof CONFIG_OVERRIDE_VARS)[number]

/**
 * Returned rather than logged: `init()` runs before `CARDINAL.logger` exists. `index.ts` puts these
 * on the `boot starting` line.
 */
export interface ConfigProvenance {
  configPath: string
  /**
   * Only the vars that were honoured — set AND on the branch that reads them. `PORT` is consulted
   * only when the configured port is below 1, so merely exporting it does not count.
   */
  overrides: ConfigOverrideVar[]
}

export default {
  /**
   * Top-level key count of the `settings` blob the last successful `loadFromDb()` read. A property
   * rather than a return value so `loadFromDb()` stays boolean.
   */
  dbKeyCount: 0,
  async init(silent = false): Promise<ConfigProvenance> {
    const overrides: ConfigOverrideVar[] = []
    const confPaths = {
      config: path.join(CARDINAL.ROOTPATH, 'config.yml'),
      data: path.join(CARDINAL.SERVERPATH, 'base.yml')
    }

    if (process.env.CONFIG_FILE) {
      confPaths.config = path.resolve(CARDINAL.ROOTPATH, process.env.CONFIG_FILE)
      overrides.push('CONFIG_FILE')
    }

    let appconfig: ConfigObject = {}
    let appdata: ConfigObject = {}

    try {
      appconfig = load(
        cfgHelper.parseConfigValue(await fs.readFile(confPaths.config, 'utf8'))
      ) as ConfigObject
      appdata = load(await fs.readFile(confPaths.data, 'utf8')) as ConfigObject
    } catch (err: any) {
      console.error(err.message)

      console.error(
        styleText(
          ['red', 'bold'],
          '>>> Unable to read configuration file! Did you create the config.yml file?'
        )
      )
      process.exit(1)
    }

    const rawConfig = appconfig
    appconfig = toMerged(appdata.defaults.config, appconfig)

    warnUnknownConfigKeys(rawConfig, appdata.defaults.config)

    if (appconfig.port < 1) {
      appconfig.port = process.env.PORT || 80
      if (process.env.PORT) {
        overrides.push('PORT')
      }
    }

    if (process.env.WIKI_PORT) {
      appconfig.port = process.env.WIKI_PORT || 80
      overrides.push('WIKI_PORT')
    }

    const packageInfo = JSON.parse(
      await fs.readFile(path.join(CARDINAL.SERVERPATH, 'package.json'), 'utf-8')
    )

    if (process.env.DB_PASS_FILE) {
      // -> `silent` is for worker threads and the MCP stdio transport, whose stdout must stay pure
      //    JSON-RPC.
      if (!silent) {
        console.info(styleText('blue', 'DB_PASS_FILE is defined. Will use secret from file.'))
      }
      try {
        appconfig.db.pass = (await fs.readFile(process.env.DB_PASS_FILE, 'utf8')).trim()
        overrides.push('DB_PASS_FILE')
      } catch (err: any) {
        console.error(
          styleText(
            ['red', 'bold'],
            '>>> Failed to read Docker Secret File using path defined in DB_PASS_FILE env variable!'
          )
        )
        console.error(err.message)
        process.exit(1)
      }
    }

    CARDINAL.config = appconfig
    CARDINAL.data = appdata
    CARDINAL.version = packageInfo.version
    CARDINAL.releaseDate = packageInfo.releaseDate
    CARDINAL.devMode = packageInfo.dev === true

    return { configPath: confPaths.config, overrides }
  },

  async loadFromDb(): Promise<boolean> {
    const conf = await CARDINAL.models.settings.getConfig()
    if (conf) {
      this.dbKeyCount = Object.keys(conf).length
      CARDINAL.config = toMerged(CARDINAL.config, conf)
      return true
    } else {
      return false
    }
  },
  async saveToDb(keys: string[], propagate = true): Promise<boolean> {
    try {
      for (const key of keys) {
        let value = CARDINAL.config[key] ?? null
        if (!isPlainObject(value)) {
          value = { v: value }
        }
        await CARDINAL.models.settings.updateConfig(key, value)
      }
      if (propagate) {
        CARDINAL.events.outbound.emit('reloadConfig')
      }
    } catch (err: any) {
      CARDINAL.logger.error('config', 'failed to save configuration', { keys, error: err })
      return false
    }

    return true
  },
  async initDbValues(): Promise<void> {
    const ids = {
      groupAdminId: crypto.randomUUID(),
      groupUserId: CARDINAL.data.systemIds.usersGroupId,
      groupGuestId: CARDINAL.data.systemIds.guestsGroupId,
      siteId: crypto.randomUUID(),
      authModuleId: CARDINAL.data.systemIds.localAuthId,
      userAdminId: crypto.randomUUID(),
      userGuestId: crypto.randomUUID(),
      classificationPublicId: CARDINAL.data.systemIds.classificationPublicId,
      classificationInternalId: CARDINAL.data.systemIds.classificationInternalId,
      classificationRestrictedId: CARDINAL.data.systemIds.classificationRestrictedId
    }

    await CARDINAL.models.settings.init(ids)
    await CARDINAL.models.sites.init(ids)
    await CARDINAL.models.groups.init(ids)
    await CARDINAL.models.classificationLevels.init(ids)
    await CARDINAL.models.authentication.init(ids)
    await CARDINAL.models.users.init(ids)
    await CARDINAL.models.jobs.init()
    await CARDINAL.models.icons.init()
  },
  /**
   * Runs the is-empty check and the seed under one advisory lock. `loadFromDb()` only checks that a
   * `settings` row exists, and `initDbValues()` writes `settings` first, so an unlocked second
   * instance booting mid-seed would pass the check and boot against a half-seeded database with no
   * error.
   *
   * The key is the one `db.ts#syncSchemas` uses, so migration and seeding serialise under it.
   * Blocking `acquireAdvisoryLock`, not `withAdvisoryLock`: a fresh seed can outlast that helper's
   * bounded backoff, and its give-up here would `process.exit(1)` an instance that only had to
   * wait. The lock is session-scoped, so a crashed holder's dropped connection releases it.
   */
  async ensureSeeded(): Promise<boolean> {
    const lock = await acquireAdvisoryLock(CARDINAL.db.$client as Pool, 'wiki:migrate')
    try {
      if (await this.loadFromDb()) {
        CARDINAL.logger.info('config', 'loaded', { keys: this.dbKeyCount, seeded: false })
        return false
      }

      CARDINAL.logger.warn('config', 'no settings in db, seeding defaults')
      await this.initDbValues()

      if (!(await this.loadFromDb())) {
        throw new Error('Settings table is still empty after seeding defaults.')
      }

      CARDINAL.logger.info('config', 'loaded', { keys: this.dbKeyCount, seeded: true })
      return true
    } finally {
      await lock.release()
    }
  },
  subscribeToEvents(): void {
    CARDINAL.events.inbound.on('reloadConfig', async () => {
      await CARDINAL.configSvc.loadFromDb()
    })
  }
}
