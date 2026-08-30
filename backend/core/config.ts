import { toMerged } from 'es-toolkit/object'
import { isPlainObject } from 'es-toolkit/predicate'
import { styleText } from 'node:util'
import cfgHelper from '../helpers/config.ts'
import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import crypto from 'node:crypto'

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
 */
function warnUnknownConfigKeys(config: ConfigObject, schema: ConfigObject, pathPrefix = ''): void {
  for (const key of Object.keys(config)) {
    const keyPath = pathPrefix ? `${pathPrefix}.${key}` : key
    if (!Object.hasOwn(schema, key)) {
      WIKI.logger.warn(`Unknown configuration key \`${keyPath}\` in config.yml — ignored.`)
      continue
    }
    if (isPlainObject(config[key]) && isPlainObject(schema[key])) {
      warnUnknownConfigKeys(config[key], schema[key], keyPath)
    }
  }
}

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

    const rawConfig = appconfig
    appconfig = toMerged(appdata.defaults.config, appconfig)

    // Warn about any config.yml key with no counterpart in base.yml's schema -- checked against the
    // pre-merge parse so only what the file itself specified is walked, not the merged result (which
    // would have every default key present and nothing left to flag).
    warnUnknownConfigKeys(rawConfig, appdata.defaults.config)

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
   * Subscribe to HA propagation events
   */
  subscribeToEvents(): void {
    WIKI.events.inbound.on('reloadConfig', async () => {
      await WIKI.configSvc.loadFromDb()
    })
  }
}
