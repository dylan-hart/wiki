import { toMerged } from 'es-toolkit/object'
import { isPlainObject } from 'es-toolkit/predicate'
import { styleText } from 'node:util'
import cfgHelper from '../helpers/config.ts'
import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import crypto from 'node:crypto'
import { withAdvisoryLock } from '../helpers/advisoryLock.ts'

/**
 * Config is assembled at runtime from config.yml + base.yml + the `settings` DB table, so its shape
 * is only known dynamically. Kept loose on purpose.
 */
type ConfigObject = Record<string, any>

/**
 * Recursively walks a parsed config.yml against base.yml's `defaults.config` shape and warns once
 * per key that has no counterpart there — the only signal a mistyped key (`logLvel:`, `sceduler:`)
 * ever gets, since `toMerged()` otherwise accepts it silently and it does nothing.
 *
 * Only descends into a key present on both sides as a plain object; anything else either matches
 * (nothing to walk further) or is already reported as unknown at that path.
 *
 * Uses `console.warn`, not `WIKI.logger.warn`: this runs inside `init()`, which every call site
 * (index.ts, worker.ts, migration/bootstrap.ts, mcp/bootstrap.ts, scripts/audit-site-scoped-rules.ts)
 * awaits before `WIKI.logger` is set up — `logger.init()` itself reads `WIKI.config.logLevel`, so it
 * can only run after config is loaded, not before.
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
 * The environment variables that can override what `config.yml` says, in the order `init()` reads
 * them. Closed on purpose: `overrides=` on the `boot starting` line names members of this list and
 * nothing else, so an operator reading it knows the whole set of things that could have been
 * overridden without going to the source.
 */
export const CONFIG_OVERRIDE_VARS = ['CONFIG_FILE', 'PORT', 'WIKI_PORT', 'DB_PASS_FILE'] as const

export type ConfigOverrideVar = (typeof CONFIG_OVERRIDE_VARS)[number]

/**
 * What `init()` learned about where the configuration came from.
 *
 * Returned rather than logged: `init()` runs before `WIKI.logger` exists — `logger.init()` reads
 * `WIKI.config.logLevel`, so config has to be loaded first — which is also why the unknown-key
 * warnings above go through `console.warn`. `index.ts` puts these on the `boot starting` line.
 */
export interface ConfigProvenance {
  /** The resolved absolute path actually read, `CONFIG_FILE` already applied. */
  configPath: string
  /**
   * Which of `CONFIG_OVERRIDE_VARS` were *honoured* — set AND on the branch that reads them. `PORT`
   * is only consulted when the configured port is below 1, so merely exporting it does not count:
   * the line would otherwise claim an override that changed nothing.
   */
  overrides: ConfigOverrideVar[]
}

export default {
  /**
   * Number of top-level keys in the `settings` blob the last successful `loadFromDb()` read.
   *
   * Kept here rather than returned, so `loadFromDb()`'s boolean contract — which `ensureSeeded()`
   * and `subscribeToEvents()` both branch on — stays a boolean. Only the `config loaded` line reads
   * it.
   */
  dbKeyCount: 0,
  /**
   * Load root config from disk
   */
  async init(silent = false): Promise<ConfigProvenance> {
    const overrides: ConfigOverrideVar[] = []
    const confPaths = {
      config: path.join(WIKI.ROOTPATH, 'config.yml'),
      data: path.join(WIKI.SERVERPATH, 'base.yml')
    }

    if (process.env.CONFIG_FILE) {
      confPaths.config = path.resolve(WIKI.ROOTPATH, process.env.CONFIG_FILE)
      overrides.push('CONFIG_FILE')
    }

    if (!silent) {
      process.stdout.write(styleText('blue', `Loading configuration from ${confPaths.config}... `))
    }

    let appconfig: ConfigObject = {}
    let appdata: ConfigObject = {}

    try {
      appconfig = load(
        cfgHelper.parseConfigValue(await fs.readFile(confPaths.config, 'utf8'))
      ) as ConfigObject
      appdata = load(await fs.readFile(confPaths.data, 'utf8')) as ConfigObject
      if (!silent) {
        console.info(styleText(['green', 'bold'], 'OK'))
      }
    } catch (err: any) {
      console.error(styleText(['red', 'bold'], 'FAILED'))
      console.error(err.message)

      console.error(
        styleText(
          ['red', 'bold'],
          '>>> Unable to read configuration file! Did you create the config.yml file?'
        )
      )
      process.exit(1)
    }

    // Merge with defaults

    const rawConfig = appconfig
    appconfig = toMerged(appdata.defaults.config, appconfig)

    // Warn about any config.yml key with no counterpart in base.yml's schema -- checked against the
    // pre-merge parse so only what the file itself specified is walked, not the merged result (which
    // would have every default key present and nothing left to flag).
    warnUnknownConfigKeys(rawConfig, appdata.defaults.config)

    // Override port

    if (appconfig.port < 1) {
      appconfig.port = process.env.PORT || 80
      // -> Only counted here, not merely on `process.env.PORT` being set: this is the one branch
      //    that reads it, so anywhere else it is present but inert.
      if (process.env.PORT) {
        overrides.push('PORT')
      }
    }

    if (process.env.WIKI_PORT) {
      appconfig.port = process.env.WIKI_PORT || 80
      overrides.push('WIKI_PORT')
    }

    // Load package info

    const packageInfo = JSON.parse(
      await fs.readFile(path.join(WIKI.SERVERPATH, 'package.json'), 'utf-8')
    )

    // Load DB Password from Docker Secret File
    if (process.env.DB_PASS_FILE) {
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

    WIKI.config = appconfig
    WIKI.data = appdata
    WIKI.version = packageInfo.version
    WIKI.releaseDate = packageInfo.releaseDate
    WIKI.devMode = packageInfo.dev === true

    return { configPath: confPaths.config, overrides }
  },

  /**
   * Load config from DB
   */
  async loadFromDb(): Promise<boolean> {
    const conf = await WIKI.models.settings.getConfig()
    if (conf) {
      this.dbKeyCount = Object.keys(conf).length
      WIKI.config = toMerged(WIKI.config, conf)
      return true
    } else {
      return false
    }
  },
  /**
   * Save config to DB
   *
   * @param keys Array of keys to save
   * @returns Promise
   */
  async saveToDb(keys: string[], propagate = true): Promise<boolean> {
    try {
      for (const key of keys) {
        let value = WIKI.config[key] ?? null
        if (!isPlainObject(value)) {
          value = { v: value }
        }
        await WIKI.models.settings.updateConfig(key, value)
      }
      if (propagate) {
        WIKI.events.outbound.emit('reloadConfig')
      }
    } catch (err: any) {
      WIKI.logger.error('config', 'failed to save configuration', { keys, error: err })
      return false
    }

    return true
  },
  /**
   * Initialize DB tables with default values
   */
  async initDbValues(): Promise<void> {
    const ids = {
      groupAdminId: crypto.randomUUID(),
      groupUserId: WIKI.data.systemIds.usersGroupId,
      groupGuestId: WIKI.data.systemIds.guestsGroupId,
      siteId: crypto.randomUUID(),
      authModuleId: WIKI.data.systemIds.localAuthId,
      userAdminId: crypto.randomUUID(),
      userGuestId: crypto.randomUUID(),
      classificationPublicId: WIKI.data.systemIds.classificationPublicId,
      classificationInternalId: WIKI.data.systemIds.classificationInternalId,
      classificationRestrictedId: WIKI.data.systemIds.classificationRestrictedId
    }

    await WIKI.models.settings.init(ids)
    await WIKI.models.sites.init(ids)
    await WIKI.models.groups.init(ids)
    await WIKI.models.classificationLevels.init(ids)
    await WIKI.models.authentication.init(ids)
    await WIKI.models.users.init(ids)
    await WIKI.models.jobs.init()
    await WIKI.models.icons.init()
  },
  /**
   * Ensure the DB carries default values, treating the is-empty check and the seed itself as one
   * atomic boot decision rather than two.
   *
   * `loadFromDb()` returns `true` on the mere *presence* of any `settings` row, and `initDbValues()`
   * writes several tables (`settings` first, then `sites`/`groups`/`classificationLevels`/
   * `authentication`/`users`/`jobs`/`icons`) across several separate `await`s — so, unlocked, a second
   * concurrently-booting instance can call `loadFromDb()` in the window after the first has committed
   * `settings.init()` but before it has finished the rest, see that presence check pass, and proceed
   * straight to `postBoot()` reloading caches from a half-seeded database (zero sites, no groups) with
   * no crash to signal it.
   *
   * Holding a session-scoped advisory lock (`helpers/advisoryLock.ts`) across the whole check-then-seed
   * sequence closes that window: the loser blocks until the winner has fully released the lock, then
   * re-runs its own `loadFromDb()` *inside* the lock and observes a fully-seeded database, correctly
   * skipping `initDbValues()` rather than racing it. The lock key (`wiki:migrate`) is the same one the
   * migration lock around `db.ts#syncSchemas` uses (or will use), so the two compose into sequential
   * sections under one key rather than fighting over separate ones.
   *
   * @returns Whether this call performed the seed (`false` means another holder already had, or the
   *   database was already seeded from a previous boot).
   */
  async ensureSeeded(): Promise<boolean> {
    return withAdvisoryLock('wiki:migrate', async () => {
      // -> `keys=` is the top-level count of the `settings` blob itself, not of the merged
      //    `WIKI.config`: what the operator wants to know here is how much of the running
      //    configuration came from the database rather than from base.yml/config.yml. `seeded=`
      //    says whether this boot is the one that wrote it.
      if (await this.loadFromDb()) {
        WIKI.logger.info('config', 'loaded', { keys: this.dbKeyCount, seeded: false })
        return false
      }

      WIKI.logger.warn('config', 'no settings in db, seeding defaults')
      await this.initDbValues()

      if (!(await this.loadFromDb())) {
        throw new Error('Settings table is still empty after seeding defaults.')
      }

      WIKI.logger.info('config', 'loaded', { keys: this.dbKeyCount, seeded: true })
      return true
    })
  },
  /**
   * Subscribe to HA propagation events
   */
  subscribeToEvents(): void {
    WIKI.events.inbound.on('reloadConfig', async () => {
      await WIKI.configSvc.loadFromDb()
    })
  }
}
