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

export default {
  /**
   * Load root config from disk
   */
  async init(silent = false): Promise<void> {
    const confPaths = {
      config: path.join(WIKI.ROOTPATH, 'config.yml'),
      data: path.join(WIKI.SERVERPATH, 'base.yml')
    }

    if (process.env.CONFIG_FILE) {
      confPaths.config = path.resolve(WIKI.ROOTPATH, process.env.CONFIG_FILE)
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

    appconfig = toMerged(appdata.defaults.config, appconfig)

    // Override port

    if (appconfig.port < 1) {
      appconfig.port = process.env.PORT || 80
    }

    if (process.env.WIKI_PORT) {
      appconfig.port = process.env.WIKI_PORT || 80
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
  },

  /**
   * Load config from DB
   */
  async loadFromDb(): Promise<boolean> {
    WIKI.logger.info('Loading settings from DB...')
    const conf = await WIKI.models.settings.getConfig()
    if (conf) {
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
      WIKI.logger.error(`Failed to save configuration to DB: ${err.message}`)
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
      if (await this.loadFromDb()) {
        WIKI.logger.info('Settings merged with DB successfully [ OK ]')
        return false
      }

      WIKI.logger.warn('No settings found in DB. Initializing with defaults...')
      await this.initDbValues()

      if (!(await this.loadFromDb())) {
        throw new Error('Settings table is empty! Could not initialize [ ERROR ]')
      }

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
