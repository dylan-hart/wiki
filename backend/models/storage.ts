import fs from 'node:fs/promises'
import path from 'node:path'
import { load } from 'js-yaml'
import { and, eq, inArray } from 'drizzle-orm'
import { parseModuleProps } from '../helpers/common.ts'
import { sites as sitesTable, storage as storageTable } from '../db/schema.ts'
import type { ModuleProp } from '../helpers/common.ts'
import type { HookEvent } from './hooks.ts'

/** The kinds of content a target can be asked to hold. */
export const CONTENT_TYPES = ['pages', 'images', 'documents', 'others', 'large'] as const

/**
 * The module every site stores its content in, and the only one that is guaranteed to work: assets
 * and pages live in the wiki database. It cannot be disabled, as that would leave content nowhere.
 */
const DB_MODULE = 'db'

/** An ISO-8601 duration such as `PT5M` or `P1DT12H`, requiring at least one date or time component. */
const ISO_DURATION_PATTERN = /^P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/

/**
 * The `/actions/:action` handlers that pull or push a whole target rather than completing
 * synchronously: `api/storage.ts` queues these through the scheduler instead of running them inline
 * on the request thread, the same way `tickScheduledSyncs()` queues a scheduled sync. An action such
 * as `purge` is expected to be fast and stays synchronous.
 */
export const SYNC_SHAPED_ACTIONS = ['sync', 'syncUntracked', 'importAll'] as const

/**
 * The storage-module handler each write-path event dispatches to, named to mirror 2.5.x's storage
 * module contract (`created` / `updated` / `deleted` / `renamed` / `assetUploaded` / `assetDeleted` /
 * `assetRenamed` — see `StorageModule`). Only the events listed here are ever dispatched; anything
 * else `hooks.ts` carries (comments, user login/logout) has no storage-side meaning.
 *
 * `asset:edit` reuses `assetUploaded` rather than getting its own `assetUpdated`: to a storage module,
 * writing new bytes for a file that already exists is the same operation as writing them for a new
 * one — a git commit or an S3 `PUT` does not care whether the key existed before — which is exactly
 * why 2.5.x never had a separate "asset updated" handler.
 */
const STORAGE_HANDLERS: Partial<Record<HookEvent, string>> = {
  'page:create': 'created',
  'page:edit': 'updated',
  'page:rename': 'renamed',
  'page:delete': 'deleted',
  'asset:upload': 'assetUploaded',
  'asset:edit': 'assetUploaded',
  'asset:rename': 'assetRenamed',
  'asset:delete': 'assetDeleted'
}

/** Byte multiplier per unit of a `contentTypes.largeThreshold` string, e.g. `"5MB"`. */
const SIZE_MULTIPLIERS: Record<string, number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4
}

/** Parses a `largeThreshold`-shaped size string to bytes. Unparsable input never counts as "large". */
function parseSizeToBytes(size: string): number {
  const match = /^(\d+(?:\.\d+)?)\s?(B|KB|MB|GB|TB)$/i.exec(size)
  if (!match) {
    return Number.POSITIVE_INFINITY
  }
  return Number.parseFloat(match[1]) * SIZE_MULTIPLIERS[match[2].toUpperCase()]
}

/** An action a module knows how to run on demand, as declared by its `definition.yml`. */
export interface StorageAction {
  /** Key of the handler on the module implementation, i.e. what gets called. */
  handler: string
  label: string
  hint: string
  /** Shown in red, and turned into a confirmation prompt by the admin area. */
  warn?: string
  icon: string
}

/** A storage module, as declared by its `definition.yml`. */
export interface StorageDefinition {
  key: string
  title: string
  description: string
  icon: string
  banner: string
  vendor: string
  website: string
  contentTypes: {
    defaultTypesEnabled: string[]
    defaultLargeThreshold: string
  }
  assetDelivery: {
    isStreamingSupported: boolean
    isDirectAccessSupported: boolean
    defaultStreamingEnabled: boolean
    defaultDirectAccessEnabled: boolean
  }
  versioning: {
    isSupported: boolean
    /** Versioning is inherent to the module and cannot be turned off, as in a git history. */
    isForceEnabled: boolean
    defaultEnabled: boolean
  }
  /** The sync modes this module knows how to run in, e.g. `['sync', 'push', 'pull']`. */
  supportedModes: string[]
  /** The mode a newly-created target for this module starts in. */
  defaultMode: string
  /**
   * How often the module syncs on its own, as an ISO-8601 duration (e.g. `PT5M`), or `false` for a
   * module that only ever acts on write — nothing to schedule.
   */
  schedule: string | false
  /** Declared by modules that cannot be configured by hand, e.g. an app installed on a provider. */
  setup?: {
    handler: string
    defaultValues: Record<string, any>
  }
  props: Record<string, ModuleProp>
  actions: StorageAction[]
  /**
   * Whether a `storage.ts` sits next to the definition.
   *
   * No module ships one yet, so every target is configuration-only for now: nothing reads or writes
   * content through a module. Actions and setup are gated on this, so that the admin area never
   * offers to run something that has no implementation behind it.
   */
  hasImplementation: boolean
}

/** A configured target: the module definition, plus how this site has it set up. */
export interface StorageTarget {
  id: string
  /**
   * The site this target belongs to. Not projected onto the API response (the JSON schema in
   * `api/schemas/storage.ts` doesn't list it, and every route it's needed on is already scoped to a
   * site of its own), but a module implementation needs it: `executeAction()` hands a module only the
   * target, never the site, and an action such as `exportAll` has to know whose assets to read.
   */
  siteId: string
  module: string
  isEnabled: boolean
  title: string
  description: string
  icon: string
  banner: string
  vendor: string
  website: string
  contentTypes: {
    activeTypes: string[]
    largeThreshold: string
  }
  assetDelivery: {
    isStreamingSupported: boolean
    isDirectAccessSupported: boolean
    streaming: boolean
    directAccess: boolean
  }
  versioning: {
    isSupported: boolean
    isForceEnabled: boolean
    enabled: boolean
  }
  sync: {
    supportedModes: string[]
    schedule: string | false
    mode: string
    scheduleOverride: string | null
  }
  setup?: {
    handler: string
    state: string
    values: Record<string, any>
  }
  props: Record<string, ModuleProp>
  config: Record<string, any>
  actions: StorageAction[]
}

/** The shape a target is written with. Every field is optional, i.e. it doubles as a patch. */
export interface StorageTargetInput {
  id: string
  isEnabled?: boolean
  contentTypes?: {
    activeTypes?: string[]
    largeThreshold?: string
  }
  assetDelivery?: {
    streaming?: boolean
    directAccess?: boolean
  }
  versioning?: {
    enabled?: boolean
  }
  sync?: {
    mode?: string
    scheduleOverride?: string | null
  }
  config?: Record<string, any>
}

/**
 * What a module implementation is expected to export, once any of them do.
 *
 * The content-dispatch handlers below are called by the `dispatchStorage` task — never directly —
 * one per write-path event this target's `contentTypes.activeTypes` covers; see `Storage.dispatch()`
 * and `STORAGE_HANDLERS` for how an event picks its handler. Named to mirror 2.5.x's storage module
 * contract: pages get the bare verb, assets are prefixed because `renamed` would otherwise collide
 * between the two content types. `data` is the same object the write-path call passed to `dispatch()`
 * (id, path/fileName, siteId, ...) — a handler that needs the actual page render or asset bytes fetches
 * them itself via `WIKI.models.pages` / `WIKI.models.assets`, so the queued job stays small and
 * JSON-serializable rather than carrying content through the job table.
 */
export interface StorageModule {
  /** Advance a multi-step setup process, returning what the admin area should do next. */
  setup?: (targetId: string, state: Record<string, any>) => Promise<Record<string, any>>
  /** Undo whatever `setup` configured, so that it can be started over. */
  setupDestroy?: (targetId: string) => Promise<void>
  /** A page was created. */
  created?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  /** A page's content, title or metadata changed. */
  updated?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  /** A page moved to a new path. */
  renamed?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  /** A page was deleted. */
  deleted?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  /** An asset was created, or an existing one had its bytes replaced. */
  assetUploaded?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  /** An asset moved to a new name or folder. */
  assetRenamed?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  /** An asset was deleted. */
  assetDeleted?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  /** Handlers named by the definition's actions. */
  [handler: string]: any
}

/**
 * Storage model
 *
 * A storage target is one module configured for one site — S3 for assets, git for pages, and so on.
 * Each module lives in `modules/storage/<key>/definition.yml`, which declares what it supports and
 * what it needs configured. Every site gets a row per module (see `syncSite`), so a target always
 * has a stable ID whether or not it has ever been enabled.
 *
 * `dispatch()` queues a sync job on every write-path change, but no module ships an implementation yet
 * — pages and assets are still read and written straight from the database, and `ensureModule()`
 * returns null for every one of them, so every queued job resolves to a no-op logged by the
 * `dispatchStorage` task. What this model handles beyond that is the configuration those modules will
 * read once they exist.
 */
class Storage {
  /** Definitions read from disk, refreshed by `refreshFromDisk()`. */
  definitions: StorageDefinition[] = []

  /** Implementations loaded by `ensureModule()`, keyed by module. */
  modules: Record<string, StorageModule> = {}

  /**
   * Load the storage module definitions from disk.
   */
  async refreshFromDisk(): Promise<void> {
    const storagePath = path.join(WIKI.SERVERPATH, 'modules/storage')
    const definitions: StorageDefinition[] = []
    try {
      for (const dir of await fs.readdir(storagePath)) {
        const raw = await fs.readFile(path.join(storagePath, dir, 'definition.yml'), 'utf8')
        const parsed = load(raw) as Record<string, any>
        // -> The directory name is the key, as it is for every other module type
        parsed.key = dir
        // -> Props carry a display `order`, applied once here so that every consumer — the admin
        //    area included — reads them in the order the module meant them to be shown in
        parsed.props = Object.fromEntries(
          Object.entries(parseModuleProps(parsed.props ?? {})).sort(
            ([, a], [, b]) => a.order - b.order
          )
        )
        // -> Declared as a map keyed by handler, which is far more readable in YAML than a list of
        //    objects, but the handler has to travel with the action for it to be callable
        parsed.actions = Object.entries(parsed.actions ?? {}).map(([handler, action]) => ({
          handler,
          ...(action as Omit<StorageAction, 'handler'>)
        }))
        parsed.versioning = {
          isSupported: false,
          isForceEnabled: false,
          defaultEnabled: false,
          ...parsed.versioning
        }
        // -> A module that declares nothing about sync only ever acts on write, in one mode
        parsed.supportedModes = parsed.supportedModes ?? ['push']
        parsed.defaultMode = parsed.defaultMode ?? parsed.supportedModes[0]
        parsed.schedule = parsed.schedule ?? false
        parsed.hasImplementation = await this.hasImplementation(dir)
        definitions.push(parsed as StorageDefinition)
      }
      // -> The database target first, then alphabetically: it is the one every site starts with
      this.definitions = definitions.sort((a, b) =>
        a.key === DB_MODULE ? -1 : b.key === DB_MODULE ? 1 : a.title.localeCompare(b.title)
      )
      WIKI.logger.info(`Found ${this.definitions.length} storage modules [ OK ]`)
    } catch (err: any) {
      this.definitions = []
      WIKI.logger.error(
        `Could not read the storage module definitions at ${storagePath} [ FAILED ]`
      )
      WIKI.logger.error(err.message)
    }
  }

  /**
   * Whether the module has any code to run, as opposed to only a definition
   */
  async hasImplementation(key: string): Promise<boolean> {
    try {
      await fs.access(path.join(WIKI.SERVERPATH, 'modules/storage', key, 'storage.ts'))
      return true
    } catch {
      return false
    }
  }

  /**
   * A single definition, or null when nothing on disk declares that key
   */
  getDefinition(key: string): StorageDefinition | null {
    return this.definitions.find((d) => d.key === key) ?? null
  }

  /**
   * Give a site a row per installed module, and drop rows for modules no longer on disk.
   *
   * Existing rows are left alone: their settings belong to the site, whereas everything the
   * definition declares is read from disk on every request rather than copied into the row.
   */
  async syncSite(siteId: string): Promise<void> {
    const existing = await WIKI.db
      .select({ module: storageTable.module })
      .from(storageTable)
      .where(eq(storageTable.siteId, siteId))
    const existingKeys = existing.map((t) => t.module)
    const definedKeys = this.definitions.map((d) => d.key)

    for (const definition of this.definitions) {
      if (existingKeys.includes(definition.key)) {
        continue
      }
      await WIKI.db.insert(storageTable).values({
        siteId,
        module: definition.key,
        // -> Content has to land somewhere from the moment a site exists
        isEnabled: definition.key === DB_MODULE,
        contentTypes: {
          activeTypes: definition.contentTypes?.defaultTypesEnabled ?? [],
          largeThreshold: definition.contentTypes?.defaultLargeThreshold ?? '5MB'
        },
        assetDelivery: {
          streaming: definition.assetDelivery?.defaultStreamingEnabled ?? false,
          directAccess: definition.assetDelivery?.defaultDirectAccessEnabled ?? false
        },
        versioning: {
          enabled: definition.versioning.isForceEnabled || definition.versioning.defaultEnabled
        },
        syncMode: definition.defaultMode,
        config: this.buildConfig(definition.key),
        state: definition.setup ? { setup: 'notconfigured' } : {}
      })
    }

    // -> A module removed from disk should not linger in the admin list
    const orphaned = existingKeys.filter((key) => !definedKeys.includes(key))
    if (orphaned.length > 0) {
      await WIKI.db
        .delete(storageTable)
        .where(and(eq(storageTable.siteId, siteId), inArray(storageTable.module, orphaned)))
    }
  }

  /**
   * Register the installed storage modules for every site. Called at boot, after the sites cache.
   */
  async syncAllSites(): Promise<void> {
    WIKI.logger.info('Registering storage targets for all sites...')
    const sites = await WIKI.db.select({ id: sitesTable.id }).from(sitesTable)
    for (const site of sites) {
      await WIKI.models.storage.syncSite(site.id)
    }
    WIKI.logger.info(`Registered storage targets for ${sites.length} sites [ OK ]`)
  }

  /**
   * The stored target rows, without anything merged in from disk
   */
  async getTargets({
    siteId,
    enabledOnly = false
  }: { siteId?: string; enabledOnly?: boolean } = {}) {
    const conditions = [
      siteId ? eq(storageTable.siteId, siteId) : undefined,
      enabledOnly ? eq(storageTable.isEnabled, true) : undefined
    ].filter(Boolean)
    return WIKI.db
      .select()
      .from(storageTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
  }

  /**
   * Every target of a site, in the order the admin area lists them.
   *
   * Config values are completed from the module's declared defaults, so a prop added to a module
   * after a target was configured is returned with its default rather than as a missing key.
   */
  async getSiteTargets(siteId: string): Promise<StorageTarget[]> {
    const rows = await this.getTargets({ siteId })
    const targets: StorageTarget[] = []
    // -> Driven by the definitions rather than by the rows, so that the list is ordered the same way
    //    and a module dropped on disk without a restart is simply absent instead of half-present
    for (const definition of this.definitions) {
      const row = rows.find((t) => t.module === definition.key)
      if (!row) {
        continue
      }
      const contentTypes = (row.contentTypes ?? {}) as Record<string, any>
      const assetDelivery = (row.assetDelivery ?? {}) as Record<string, any>
      const versioning = (row.versioning ?? {}) as Record<string, any>
      targets.push({
        id: row.id,
        siteId: row.siteId,
        module: definition.key,
        isEnabled: row.isEnabled,
        title: definition.title,
        description: definition.description,
        icon: definition.icon,
        banner: definition.banner,
        vendor: definition.vendor,
        website: definition.website,
        contentTypes: {
          activeTypes: contentTypes.activeTypes ?? [],
          largeThreshold: contentTypes.largeThreshold ?? '5MB'
        },
        assetDelivery: {
          isStreamingSupported: definition.assetDelivery?.isStreamingSupported ?? false,
          isDirectAccessSupported: definition.assetDelivery?.isDirectAccessSupported ?? false,
          streaming: assetDelivery.streaming ?? false,
          directAccess: assetDelivery.directAccess ?? false
        },
        versioning: {
          isSupported: definition.versioning.isSupported,
          isForceEnabled: definition.versioning.isForceEnabled,
          enabled: versioning.enabled ?? false
        },
        sync: {
          supportedModes: definition.supportedModes,
          schedule: definition.schedule,
          mode: row.syncMode,
          scheduleOverride: row.scheduleOverride
        },
        // -> Only offered for a module that can actually run its setup process
        ...(definition.setup &&
          definition.hasImplementation && {
            setup: {
              handler: definition.setup.handler,
              state: ((row.state ?? {}) as Record<string, any>).setup ?? 'notconfigured',
              values: this.buildSetupValues(definition, row.config as Record<string, any>)
            }
          }),
        props: definition.props,
        config: this.buildConfig(definition.key, {}, row.config as Record<string, any>),
        // -> Same reasoning as setup: an action with nothing behind it cannot be run
        actions: definition.hasImplementation ? definition.actions : []
      })
    }
    return targets
  }

  /**
   * A single target of a site, or null if there is no such target
   */
  async getSiteTargetById(siteId: string, id: string): Promise<StorageTarget | null> {
    return (await this.getSiteTargets(siteId)).find((t) => t.id === id) ?? null
  }

  /**
   * The values the setup form starts from: whatever the module stored, else its declared defaults.
   */
  buildSetupValues(
    definition: StorageDefinition,
    stored: Record<string, any> = {}
  ): Record<string, any> {
    const values: Record<string, any> = {}
    for (const [key, value] of Object.entries(definition.setup?.defaultValues ?? {})) {
      values[key] = stored[key] ?? value
    }
    return values
  }

  /**
   * Merge incoming config values onto the ones already stored, keeping only what the module declares.
   *
   * Read-only props are never taken from the client: they are declarations of something the server
   * does not support changing, so the stored value (or the module default) always wins.
   */
  buildConfig(
    moduleKey: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): Record<string, any> {
    const props = this.getDefinition(moduleKey)?.props ?? {}
    const config: Record<string, any> = {}
    for (const [key, prop] of Object.entries(props)) {
      const current = existing[key] !== undefined ? existing[key] : prop.default
      config[key] = prop.readOnly || incoming[key] === undefined ? current : incoming[key]
    }
    return config
  }

  /**
   * Check incoming config values against what the module declares.
   *
   * The props are a runtime declaration read from a YAML file, so no JSON Schema can cover them —
   * without this, a boolean prop would happily store the string `"maybe"`.
   *
   * @returns The reason it is invalid, or null when it is fine
   */
  validateConfig(moduleKey: string, incoming: Record<string, any> = {}): string | null {
    const props = this.getDefinition(moduleKey)?.props ?? {}
    for (const [key, value] of Object.entries(incoming)) {
      const prop = props[key]
      // -> Unknown keys are dropped by buildConfig rather than refused: a module losing a prop must
      //    not make the admin area unable to save
      if (!prop || prop.readOnly || value === undefined) {
        continue
      }
      if (prop.enum) {
        // -> Enum entries are declared as `value` or `value|label`
        const allowed = prop.enum.map((entry) => entry.split('|')[0])
        if (!allowed.includes(`${value}`)) {
          return `"${value}" is not a valid value for ${prop.title}.`
        }
        continue
      }
      switch (prop.type) {
        case 'boolean':
          if (typeof value !== 'boolean') {
            return `${prop.title} must be true or false.`
          }
          break
        case 'number':
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            return `${prop.title} must be a number.`
          }
          break
        default:
          if (typeof value !== 'string') {
            return `${prop.title} must be a string.`
          }
      }
    }
    return null
  }

  /**
   * Check a target patch against what its module supports.
   *
   * @returns The reason it is invalid, or null when it is fine
   */
  validateTarget(target: StorageTarget, patch: StorageTargetInput): string | null {
    const definition = this.getDefinition(target.module)!
    if (patch.isEnabled === false && target.module === DB_MODULE) {
      return 'The database storage target cannot be disabled, as content would have nowhere to live.'
    }
    if (patch.isEnabled === true && target.setup && target.setup.state !== 'configured') {
      return `${definition.title} cannot be enabled until its setup process is completed.`
    }
    const activeTypes = patch.contentTypes?.activeTypes
    if (activeTypes) {
      const unknown = activeTypes.find(
        (type) => !(CONTENT_TYPES as readonly string[]).includes(type)
      )
      if (unknown) {
        return `"${unknown}" is not a valid content type.`
      }
      if (target.module === DB_MODULE && !activeTypes.includes('pages')) {
        return 'The database storage target must keep holding pages.'
      }
    }
    const largeThreshold = patch.contentTypes?.largeThreshold
    if (largeThreshold !== undefined && !/^\d+(\.\d+)?\s?(B|KB|MB|GB|TB)$/i.test(largeThreshold)) {
      return `"${largeThreshold}" is not a valid size threshold. Use a size such as "5MB".`
    }
    if (patch.sync?.mode !== undefined) {
      // -> A module with only one supported mode offers no choice, so there is nothing to change
      if (definition.supportedModes.length <= 1) {
        return `${definition.title} does not support changing its sync mode.`
      }
      if (!definition.supportedModes.includes(patch.sync.mode)) {
        return `"${patch.sync.mode}" is not a valid sync mode for ${definition.title}.`
      }
    }
    if (patch.sync?.scheduleOverride !== undefined && patch.sync.scheduleOverride !== null) {
      if (definition.schedule === false) {
        return `${definition.title} does not sync on a schedule.`
      }
      if (!ISO_DURATION_PATTERN.test(patch.sync.scheduleOverride)) {
        return `"${patch.sync.scheduleOverride}" is not a valid ISO-8601 duration.`
      }
    }
    return this.validateConfig(target.module, patch.config)
  }

  /**
   * Apply a patch to a target.
   *
   * Capabilities the module does not have are stored as off whatever was asked for, and versioning it
   * forces on is stored as on — the admin area disables those controls, but the values are the
   * module's to decide, not the client's.
   *
   * @param target The target as it currently stands, which the caller already has from validating
   * @returns Whether the target was written
   */
  async updateTarget(
    siteId: string,
    target: StorageTarget,
    patch: StorageTargetInput
  ): Promise<boolean> {
    const definition = this.getDefinition(target.module)!

    const values: Partial<typeof storageTable.$inferInsert> = {}
    if (patch.isEnabled !== undefined) {
      values.isEnabled = patch.isEnabled
    }
    if (patch.contentTypes) {
      values.contentTypes = {
        activeTypes: patch.contentTypes.activeTypes ?? target.contentTypes.activeTypes,
        largeThreshold: patch.contentTypes.largeThreshold ?? target.contentTypes.largeThreshold
      }
    }
    if (patch.assetDelivery) {
      values.assetDelivery = {
        streaming:
          definition.assetDelivery.isStreamingSupported &&
          (patch.assetDelivery.streaming ?? target.assetDelivery.streaming),
        directAccess:
          definition.assetDelivery.isDirectAccessSupported &&
          (patch.assetDelivery.directAccess ?? target.assetDelivery.directAccess)
      }
    }
    if (patch.versioning) {
      values.versioning = {
        enabled:
          definition.versioning.isForceEnabled ||
          (definition.versioning.isSupported &&
            (patch.versioning.enabled ?? target.versioning.enabled))
      }
    }
    if (patch.sync?.mode !== undefined) {
      values.syncMode = patch.sync.mode
    }
    if (patch.sync?.scheduleOverride !== undefined) {
      values.scheduleOverride = patch.sync.scheduleOverride
    }
    if (patch.config !== undefined) {
      values.config = this.buildConfig(target.module, patch.config, target.config)
    }
    if (Object.keys(values).length < 1) {
      return false
    }

    const result = await WIKI.db
      .update(storageTable)
      .set(values)
      .where(and(eq(storageTable.siteId, siteId), eq(storageTable.id, target.id)))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * Whether a target's `contentTypes.activeTypes` covers the content behind one dispatch event.
   *
   * A page is always the `pages` bucket. An asset is classified by `data.kind` (`image` / `document`
   * / `other`, mirroring `models/assets.ts`'s `AssetKind`) into `images` / `documents` / `others` —
   * unless `data.fileSize` is given and clears *this target's own* `largeThreshold`, in which case the
   * target is asked about `large` instead of its kind-based bucket. The threshold lives on the target,
   * not the module, so the same file can be "large" for one target and not another.
   */
  targetCoversEvent(target: StorageTarget, event: HookEvent, data: Record<string, any>): boolean {
    if (event.startsWith('page:')) {
      return target.contentTypes.activeTypes.includes('pages')
    }
    if (!event.startsWith('asset:')) {
      return false
    }
    const base =
      data.kind === 'image'
        ? 'images'
        : data.kind === 'document'
          ? 'documents'
          : data.kind === 'other'
            ? 'others'
            : null
    if (!base) {
      // -> No kind on the payload: this event cannot be classified, so no target can claim it
      return false
    }
    if (
      typeof data.fileSize === 'number' &&
      data.fileSize > parseSizeToBytes(target.contentTypes.largeThreshold)
    ) {
      return target.contentTypes.activeTypes.includes('large')
    }
    return target.contentTypes.activeTypes.includes(base)
  }

  /**
   * Queue a sync job on every enabled target that syncs this event's content in `push` or `sync` mode
   * — never a `pull`-only target, which never writes out.
   *
   * Mirrors `hooks.emit()`: safe to call from anywhere, including request handlers, because it only
   * writes scheduler jobs and never throws — a broken or unconfigured target must not fail the write
   * that triggered it. Delivery itself happens in the `dispatchStorage` task, never inline here.
   *
   * @param data Must include `siteId` and the content's own `id`. Asset events should also carry
   *             `kind` and, when known, `fileSize` — see `targetCoversEvent`.
   * @returns How many syncs were queued
   */
  async dispatch(event: HookEvent, data: Record<string, any> = {}): Promise<number> {
    const handler = STORAGE_HANDLERS[event]
    if (!handler || !data.siteId || !data.id) {
      return 0
    }
    try {
      const targets = await this.getSiteTargets(data.siteId)
      const contentType: 'page' | 'asset' = event.startsWith('page:') ? 'page' : 'asset'

      let queued = 0
      for (const target of targets) {
        if (!target.isEnabled || target.sync.mode === 'pull') {
          continue
        }
        if (!this.targetCoversEvent(target, event, data)) {
          continue
        }
        const added = await WIKI.scheduler.addJob({
          task: 'dispatchStorage',
          payload: {
            targetId: target.id,
            siteId: data.siteId,
            contentType,
            contentId: data.id,
            handler,
            data
          }
        })
        if (added?.id) {
          queued++
        }
      }
      return queued
    } catch (err: any) {
      WIKI.logger.warn(`Failed to queue storage dispatch for ${event}: ${err.message}`)
      return 0
    }
  }

  /**
   * Queue a sync for every enabled pull/two-way target whose schedule has elapsed since its last
   * tick -- the scheduled counterpart to `dispatch()`'s write-path one. Run by the `storageSyncTick`
   * task, on the cron entry `models/jobs.ts` seeds for it.
   *
   * A target is skipped, never ticked at all, when:
   *  - its module declares no `schedule` (`false`) -- a push-only module such as disk/s3, which only
   *    ever moves content out through `dispatch()`'s write-path hook;
   *  - its own `sync.mode` is `push` -- even on a module that supports scheduling (git can run in
   *    `push` mode too), a push-only target already gets everything it needs from the write-path
   *    hook, and ticking it again here would risk a spurious inbound sync.
   *
   * For everything else, the effective interval is the target's own `scheduleOverride` when set, else
   * the module's declared `schedule` -- the same precedence `validateTarget` enforces when accepting
   * one. It is parsed with `Temporal.Duration.from()` and, since `Temporal.Instant.add()` only accepts
   * exact time units (no calendar-relative days -- see `total()` below), converted to a millisecond
   * count via `Duration.prototype.total()`, which -- with no `relativeTo` -- treats `days` as exactly
   * 24 hours, the same UTC-exact convention this codebase already uses elsewhere. A schedule this
   * can't parse (or that has a `years`/`months` component, which genuinely has no fixed length without
   * a calendar) is logged and skipped rather than thrown, so one bad target cannot fail the whole tick.
   *
   * A due target's `lastTickAt` only advances once the sync job is actually queued -- a failure to
   * enqueue (e.g. a transient scheduler/db error) leaves it due again next tick. Whether the queued job
   * itself goes on to succeed is irrelevant to the schedule: ticking answers "did we ask for a sync",
   * not "did the sync work" -- a target stuck failing every attempt still gets exactly one queued job
   * per interval rather than a growing backlog.
   *
   * @returns How many syncs were queued
   */
  async tickScheduledSyncs(now: Temporal.Instant = Temporal.Now.instant()): Promise<number> {
    const rows = await this.getTargets({ enabledOnly: true })
    let queued = 0
    for (const row of rows) {
      const definition = this.getDefinition(row.module)
      if (!definition || definition.schedule === false) {
        continue
      }
      if (row.syncMode === 'push') {
        continue
      }
      const scheduleStr = row.scheduleOverride ?? definition.schedule
      let intervalMs: number
      try {
        intervalMs = Math.round(Temporal.Duration.from(scheduleStr).total({ unit: 'milliseconds' }))
      } catch (err: any) {
        WIKI.logger.warn(
          `Storage target ${row.id} has an unparseable sync schedule "${scheduleStr}", skipping: ${err.message}`
        )
        continue
      }
      const lastTick = row.lastTickAt ? row.lastTickAt.toTemporalInstant() : null
      const due =
        !lastTick || Temporal.Instant.compare(now, lastTick.add({ milliseconds: intervalMs })) >= 0
      if (!due) {
        continue
      }
      const added = await WIKI.scheduler.addJob({
        task: 'dispatchStorage',
        payload: { targetId: row.id, siteId: row.siteId, handler: 'sync', data: {} }
      })
      if (!added?.id) {
        continue
      }
      await WIKI.db
        .update(storageTable)
        .set({ lastTickAt: new Date(now.epochMilliseconds) })
        .where(eq(storageTable.id, row.id))
      queued++
    }
    return queued
  }

  /**
   * Ensure a module's implementation is loaded
   *
   * @returns The implementation, or null when the module has none or it failed to load
   */
  async ensureModule(key: string): Promise<StorageModule | null> {
    if (this.modules[key]) {
      return this.modules[key]
    }
    if (!this.getDefinition(key)?.hasImplementation) {
      return null
    }
    try {
      // -> Extension-sensitive dynamic import, invisible to the type checker
      this.modules[key] = (await import(`../modules/storage/${key}/storage.ts`)).default
      WIKI.logger.debug(`Activated storage module ${key} [ OK ]`)
      return this.modules[key]
    } catch (err: any) {
      WIKI.logger.warn(`Failed to load storage module ${key} [ FAILED ]`)
      WIKI.logger.warn(err)
      return null
    }
  }

  /**
   * Run one of the actions a module declares.
   *
   * @throws When the module cannot be loaded or does not implement the handler
   */
  async executeAction(target: StorageTarget, handler: string): Promise<void> {
    const mod = await this.ensureModule(target.module)
    if (!mod) {
      throw new Error(`The ${target.title} storage module has no implementation installed.`)
    }
    if (typeof mod[handler] !== 'function') {
      throw new Error(`The ${target.title} storage module does not implement "${handler}".`)
    }
    await mod[handler](target)
  }

  /**
   * Advance a module's setup process.
   *
   * @returns What the admin area should do next, as decided by the module
   * @throws When the module cannot be loaded or has no setup process
   */
  async runSetup(target: StorageTarget, state: Record<string, any>): Promise<Record<string, any>> {
    const mod = await this.ensureModule(target.module)
    if (!mod?.setup) {
      throw new Error(`The ${target.title} storage module has no setup process.`)
    }
    return mod.setup(target.id, state)
  }

  /**
   * Undo a module's setup, so that it can be started over.
   *
   * @throws When the module cannot be loaded or has no setup process
   */
  async destroySetup(target: StorageTarget): Promise<void> {
    const mod = await this.ensureModule(target.module)
    if (!mod?.setupDestroy) {
      throw new Error(`The ${target.title} storage module has no setup process.`)
    }
    await mod.setupDestroy(target.id)
  }
}

export const storage = new Storage()
