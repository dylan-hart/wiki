import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { maskSensitiveConfig } from '../helpers/moduleProps.ts'
import {
  loadModule,
  mergeModuleConfig,
  moduleHasFile,
  readModuleDefinitions,
  syncSiteModuleRows,
  validateModuleConfig
} from '../helpers/moduleRegistry.ts'
import { parseLargeThreshold } from '../helpers/blobTarget.ts'
import {
  CONTENT_TYPE_EXTENSIONS,
  DEFAULT_CONTENT_TYPE_EXTENSION,
  fileExtensionForContentType
} from '../helpers/pageSerialization.ts'
import { sites as sitesTable, storage as storageTable } from '../db/schema.ts'
import type { ModuleProp } from '../helpers/moduleProps.ts'
import type { HookEvent } from './hooks.ts'

/** The kinds of content a target can be asked to hold. */
export const CONTENT_TYPES = ['pages', 'images', 'documents', 'others', 'large'] as const

/**
 * The file extension for a page's `contentType`, matching 2.5.x's `pageHelper.getFileExtension`.
 * The table itself is `helpers/pageSerialization.ts`'s `CONTENT_TYPE_EXTENSIONS` — one map shared by
 * every file-backed target rather than a copy per module.
 */
export function getFileExtension(contentType: string): string {
  return fileExtensionForContentType(contentType)
}

/**
 * The inverse of `CONTENT_TYPE_EXTENSIONS`, e.g. `md` -> `markdown`. Built only from the content types
 * with an extension of their own: `text` and `redirect` both write the default `txt`, which is a
 * fallback rather than a reverse-mapping target (see `getContentTypeFromExtension`).
 */
const EXTENSION_CONTENT_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(CONTENT_TYPE_EXTENSIONS)
    .filter(([, ext]) => ext !== DEFAULT_CONTENT_TYPE_EXTENSION)
    .map(([contentType, ext]) => [ext, contentType])
)

/**
 * The page `contentType` a file extension maps back to, matching 2.5.x's
 * `pageHelper.getContentType`, or `null` when the extension is not one a page is ever written under
 * (i.e. this is an asset, not a page) — `txt` included: it is `getFileExtension`'s fallback for an
 * unrecognized content type, not a real reverse mapping target, so a bare `.txt` file found in the
 * repo is treated as an asset here, exactly as 2.5.x's `extToContent` (built the same way, by
 * inverting the forward map) would.
 */
export function getContentTypeFromExtension(ext: string): string | null {
  return EXTENSION_CONTENT_TYPES[ext] ?? null
}

/**
 * The module every site stores its content in, and the only one that is guaranteed to work: assets
 * and pages live in the wiki database. It cannot be disabled, as that would leave content nowhere.
 *
 * Exported for `models/assets.ts`'s `readContent()`, which resolves this target specifically to read
 * its `assetDelivery` settings — disk and db are the only implemented targets, and content still
 * physically lives in the assets table either way, so the db target is what governs serving.
 */
export const DB_MODULE = 'db'

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
 *
 * `asset:move` has deliberately no entry: no storage module relocates a blob-target's copy of a file
 * on a folder reparent yet — the same gap `renameFolder`'s bulk folder move already has for the
 * assets it drags along (`docs/variances.md`, "folder renames don't sync" item 3, OpenProject
 * #2817). `dispatch()` no-ops for an event missing here, so this is safe rather than a crash risk;
 * the webhook side (`HOOK_EVENTS`/`EMITTED_EVENTS`) still fires for `asset:move`, since that half has
 * nothing storage-shaped to get wrong.
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
  props: Record<string, ModuleProp>
  actions: StorageAction[]
  /**
   * Whether a `storage.ts` sits next to the definition.
   *
   * No module ships one yet, so every target is configuration-only for now: nothing reads or writes
   * content through a module. Actions are gated on this, so that the admin area never offers to run
   * something that has no implementation behind it.
   */
  hasImplementation: boolean
  /**
   * Whether the module implements any of `STORAGE_HANDLERS`' write-path content handlers — as
   * opposed to being configuration- and manual-action-only, like `disk` (`dump`/`backup`/`importAll`)
   * and `sftp` (`exportAll`). `dispatch()` uses this per-handler to decide whether a write-path event
   * is even worth queuing a job for; the admin area uses the aggregate to tell an author that a
   * `push`-capable target such as these does not actually sync on every page/asset change — only its
   * listed actions write anything.
   */
  supportsContentSync: boolean
}

/** A configured target: the module definition, plus how this site has it set up. */
export interface StorageTarget {
  id: string
  /**
   * The site this target belongs to. Not projected onto the API response (the JSON schema in
   * `api/schemas/storage.ts` doesn't list it, and every route it's needed on is already scoped to a
   * site of its own), but a module implementation needs it: `executeAction()` hands a module only the
   * target, never the site, so an action handler that needs to reach
   * `WIKI.models.pages`/`WIKI.models.assets` (a two-way `sync`, chiefly, or `exportAll`) has no other
   * way to learn whose content it is looking at.
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
    /** See `StorageDefinition.supportsContentSync` — surfaced per-target for the admin area. */
    supportsContentSync: boolean
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
 * Every handler here — the content-dispatch handlers, and any custom `[handler]` an action names —
 * receives the *full* `StorageTarget`, never a bare id. That target includes `siteId`, which is
 * therefore the one reliable way for a handler to learn which site's pages/assets/tree rows it is
 * scoped to: nothing else is passed alongside it. `executeAction()` already fetches the target via
 * `getSiteTargetById()` before calling in, so a handler never has to ask the model for it again.
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
  /**
   * Extra, module-specific config validation beyond what `Storage.validateConfig()`'s generic
   * type/enum check can do from the props declaration alone — e.g. the disk module confirming its
   * `path` prop is an absolute, existing, writable directory rather than merely a non-empty string.
   * Called by `validateTarget()`, with the config the patch being validated would result in — see
   * that method's doc for exactly when.
   *
   * @returns The reason it is invalid, or null when it is fine
   */
  validateConfig?: (config: Record<string, any>, target: StorageTarget) => Promise<string | null>
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
  /**
   * A direct URL to an asset's bytes on this target — e.g. a signed S3 URL — that lets a reader fetch
   * the file straight from the target instead of proxying it through this instance.
   *
   * Checked by `models/assets.ts`'s `readContent()` before it falls into its own disk-cache/database
   * proxy path, and only consulted when the target's `assetDelivery.directAccess` is on, the module's
   * definition declares `assetDelivery.isDirectAccessSupported`, and `governingTarget()` picked this
   * target for the asset being served (i.e. its `contentTypes` cover the asset — see
   * `helpers/blobTarget.ts`'s `belongsInTarget`). Neither `disk` nor `db` implements this — a local
   * disk path and a database row are not URLs anything else can fetch — `s3`, `azure` and `gcs` do.
   *
   * @param asset `folderPath` is required alongside `fileName` to rebuild the object key a blob
   *   target stored the file under (`helpers/blobTarget.ts`'s `objectKeyFor`) — the two together are
   *   what `s3`/`azure`/`gcs`'s own `getDirectUrl` key off.
   * @returns The URL to redirect the request to, or null/undefined to fall through to the normal path
   */
  getDirectUrl?: (
    asset: { id: string; updatedAt: Date; fileName: string; folderPath: string },
    target: StorageTarget
  ) => Promise<string | null | undefined>
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
 * `dispatch()` queues a sync job on every write-path change for a target whose module implements the
 * write path (see `supportsContentSync` — `disk` and `sftp` only implement their own explicit actions,
 * not the write-path handlers `dispatch()` queues for). `ensureModule()` loads each module's
 * `storage.ts` on first use and caches it; pages and assets are still read and written straight from
 * the database first, with a target's own sync/mirror happening asynchronously through the queued job.
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
    try {
      const definitions = await readModuleDefinitions<StorageDefinition>(storagePath, {
        parseProps: true,
        sortPropsByOrder: true,
        decorate: async (parsed, key) => {
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
          parsed.hasImplementation = await this.hasImplementation(key)
          return parsed as StorageDefinition
        }
      })
      // -> The database target first, then alphabetically: it is the one every site starts with
      this.definitions = definitions.sort((a, b) =>
        a.key === DB_MODULE ? -1 : b.key === DB_MODULE ? 1 : a.title.localeCompare(b.title)
      )
      // -> Loaded now (rather than deferred to `dispatch()`'s first call) so the flag is ready for
      //    the admin area the moment the definitions are: `ensureModule()` reads `this.definitions`
      //    itself, which is why this pass comes after the assignment above rather than inside the
      //    loop that built it.
      for (const definition of this.definitions) {
        definition.supportsContentSync = definition.hasImplementation
          ? await this.moduleSupportsContentSync(definition.key)
          : false
      }
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
    return moduleHasFile(WIKI.SERVERPATH, 'modules/storage', key, 'storage.ts')
  }

  /**
   * Whether a module (already known to have a `storage.ts`) implements at least one of
   * `STORAGE_HANDLERS`' write-path content handlers — see `StorageDefinition.supportsContentSync`.
   *
   * A module that fails to load answers `false` here the same way `ensureModule()` itself does for
   * every other caller: a broken module has no working handlers, which is exactly this question's
   * answer too.
   */
  async moduleSupportsContentSync(key: string): Promise<boolean> {
    const mod = await this.ensureModule(key)
    if (!mod) {
      return false
    }
    return Object.values(STORAGE_HANDLERS).some((handler) => typeof mod[handler] === 'function')
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
    await syncSiteModuleRows(
      storageTable,
      siteId,
      this.definitions,
      (definition): Omit<typeof storageTable.$inferInsert, 'siteId' | 'module'> => ({
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
        config: this.buildConfig(definition.key)
      })
    )
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
   *
   * @param opts.mask When true, a `sensitive` prop's stored value (an S3 secret key, an sftp
   *   password, ...) is replaced with a mask before being returned -- see
   *   `helpers/moduleProps.ts#maskSensitiveConfig`. Defaults to false: this is the *only* place a
   *   target's config is assembled, so `dispatch()`, `executeAction()` and `runDailyBackups()` all
   *   call this with the default and need the real values to actually connect.
   *   Only an admin-facing read that serializes `config` straight into an HTTP response should ever
   *   pass `{ mask: true }`.
   */
  async getSiteTargets(
    siteId: string,
    { mask = false }: { mask?: boolean } = {}
  ): Promise<StorageTarget[]> {
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
      const config = this.buildConfig(definition.key, {}, row.config as Record<string, any>)
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
          scheduleOverride: row.scheduleOverride,
          supportsContentSync: definition.supportsContentSync
        },
        props: definition.props,
        config: mask ? maskSensitiveConfig(definition.props, config) : config,
        // -> An action with nothing behind it cannot be run
        actions: definition.hasImplementation ? definition.actions : []
      })
    }
    return targets
  }

  /**
   * A single target of a site, or null if there is no such target
   */
  async getSiteTargetById(
    siteId: string,
    id: string,
    opts?: { mask?: boolean }
  ): Promise<StorageTarget | null> {
    return (await this.getSiteTargets(siteId, opts)).find((t) => t.id === id) ?? null
  }

  /**
   * Merge incoming config values onto the ones already stored, keeping only what the module declares
   * — see `helpers/moduleRegistry.ts#mergeModuleConfig`.
   */
  buildConfig(
    moduleKey: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): Record<string, any> {
    return mergeModuleConfig(this.getDefinition(moduleKey)?.props ?? {}, incoming, existing)
  }

  /**
   * Check incoming config values against what the module declares — see
   * `helpers/moduleRegistry.ts#validateModuleConfig`. An unknown key is dropped by `buildConfig`
   * rather than refused here, so a module losing a prop can never make the admin area unable to save.
   *
   * @returns The reason it is invalid, or null when it is fine
   */
  validateConfig(moduleKey: string, incoming: Record<string, any> = {}): string | null {
    return validateModuleConfig(this.getDefinition(moduleKey)?.props ?? {}, incoming)
  }

  /**
   * Check a target patch against what its module supports.
   *
   * Async because of its last step: a module-specific deep check (see `StorageModule.validateConfig`)
   * runs whenever the patch touches `config` or is turning the target on, which means loading the
   * module (`ensureModule()`) and, for one like disk, hitting the filesystem. Skipped for any other
   * patch — a sync-mode or schedule change re-validating an unrelated config on every save would be
   * pure overhead.
   *
   * @returns The reason it is invalid, or null when it is fine
   */
  async validateTarget(target: StorageTarget, patch: StorageTargetInput): Promise<string | null> {
    const definition = this.getDefinition(target.module)!
    if (patch.isEnabled === false && target.module === DB_MODULE) {
      return 'The database storage target cannot be disabled, as content would have nowhere to live.'
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
    const configInvalid = this.validateConfig(target.module, patch.config)
    if (configInvalid) {
      return configInvalid
    }

    if (patch.config !== undefined || patch.isEnabled === true) {
      const mod = await this.ensureModule(target.module)
      if (mod?.validateConfig) {
        const effectiveConfig = this.buildConfig(target.module, patch.config ?? {}, target.config)
        const deepInvalid = await mod.validateConfig(effectiveConfig, target)
        if (deepInvalid) {
          return deepInvalid
        }
      }
    }
    return null
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
   * unless `data.fileSize` is given and is at or above *this target's own* `largeThreshold`, in which
   * case the target is asked about `large` instead of its kind-based bucket. The threshold lives on
   * the target, not the module, so the same file can be "large" for one target and not another.
   *
   * Threshold parsing and the at-or-above comparison both go through `helpers/blobTarget.ts`'s
   * `parseLargeThreshold` — the single parser every `largeThreshold` reader shares (OpenProject #927)
   * — so this size-aware classification, the one the blob targets' own `exportAll`/`belongsInTarget`
   * gate on, and the git module's `syncUntracked` (`actions.ts`) all agree on exactly the same file.
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
      data.fileSize >=
        parseLargeThreshold(target.contentTypes.largeThreshold, Number.POSITIVE_INFINITY)
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
        // -> A module with no write-path handlers at all (disk, sftp — config/manual-action only)
        //    can never do anything with a queued job; skip it here rather than let every job land in
        //    `dispatchStorage`'s "no handler installed, skipping" no-op branch
        if (!this.getDefinition(target.module)?.supportsContentSync) {
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
   * That statelessness is also what answers OpenProject #823 item 5 (upstream #2082, open: "once the
   * remote goes unreachable then recovers, sync never resumes automatically -- only a manual Force
   * Sync works, and even that doesn't restore the schedule"). There is no per-target "suspended" state
   * for a run of failures to set, and therefore nothing a recovery needs to clear: this method re-reads
   * every enabled target's row on every tick and queues whichever are due, regardless of how many of
   * their previous jobs failed. A remote that comes back reachable is simply due again at its next
   * regular interval, automatically, with no administrator action required -- see
   * `storage.test.ts`'s "re-queues a target on schedule regardless of how many prior ticks were never
   * actually retried" test. Item 4 (upstream #2443: "sync-interval setting doesn't actually take
   * effect once changed") is the same statelessness from a different angle: `scheduleOverride` is read
   * fresh off the row every tick too, so a shortened interval takes effect on the very next tick, not
   * after a restart -- see "picks up a shortened scheduleOverride on its very next tick".
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
   * Run the `dailyBackup` handler for every enabled target, across every site, whose module declares
   * one and whose `config.createDailyBackups` is on -- the scheduled counterpart to `dispatch()`'s
   * write-path syncs, run by the `storageDailyBackup` task on the cron entry `models/jobs.ts` seeds
   * for it.
   *
   * Only the `disk` module implements `dailyBackup` today (see `modules/storage/disk/storage.ts`),
   * but the check here is deliberately generic: any target whose module exports a `dailyBackup`
   * handler and whose config opts in is run, no matter which module. A target is skipped, not run,
   * when:
   *  - it is disabled (`isEnabled` false) -- a target an admin turned off should not keep backing up;
   *  - `config.createDailyBackups` is not exactly `true` -- the whole point of the prop;
   *  - its module has no `dailyBackup` handler -- nothing to call.
   *
   * A single target's failure (e.g. its path became unwritable) is logged and does not stop the rest,
   * for the same reason `tickScheduledSyncs()` isolates its own per-target loop: one bad target must
   * not turn into every other site's backup silently not running tonight.
   *
   * @returns How many targets' backups ran successfully, and how many failed
   */
  async runDailyBackups(): Promise<{ ran: number; failed: number }> {
    const sites = await WIKI.db.select({ id: sitesTable.id }).from(sitesTable)
    let ran = 0
    let failed = 0
    for (const site of sites) {
      const targets = await this.getSiteTargets(site.id)
      for (const target of targets) {
        if (!target.isEnabled || target.config.createDailyBackups !== true) {
          continue
        }
        const mod = await this.ensureModule(target.module)
        if (!mod || typeof mod.dailyBackup !== 'function') {
          continue
        }
        try {
          await mod.dailyBackup(target)
          ran++
        } catch (err: any) {
          failed++
          WIKI.logger.warn(
            `Daily backup failed for storage target ${target.title} (site ${site.id}): ${err.message}`
          )
        }
      }
    }
    return { ran, failed }
  }

  /**
   * Ensure a module's implementation is loaded
   *
   * @returns The implementation, or null when the module has none or it failed to load
   */
  async ensureModule(key: string): Promise<StorageModule | null> {
    return loadModule(
      this.modules,
      key,
      // -> Extension-sensitive dynamic import, invisible to the type checker
      () => import(`../modules/storage/${key}/storage.ts`),
      'storage',
      () => this.getDefinition(key)?.hasImplementation === true
    )
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
}

export const storage = new Storage()
