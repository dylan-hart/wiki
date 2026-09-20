import path from 'node:path'
import { CronExpressionParser } from 'cron-parser'
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

export const CONTENT_TYPES = ['pages', 'images', 'documents', 'others', 'large'] as const

export function getFileExtension(contentType: string): string {
  return fileExtensionForContentType(contentType)
}

/**
 * The inverse of `CONTENT_TYPE_EXTENSIONS`. `text` and `redirect` both write the default `txt`, so
 * it maps back to neither: an extension that is only the fallback is not a reverse-mapping target.
 */
const EXTENSION_CONTENT_TYPES: Record<string, string> = Object.fromEntries(
  Object.entries(CONTENT_TYPE_EXTENSIONS)
    .filter(([, ext]) => ext !== DEFAULT_CONTENT_TYPE_EXTENSION)
    .map(([contentType, ext]) => [ext, contentType])
)

/**
 * `null` when no page is ever written under that extension — a bare `.txt` file found in a repo is
 * therefore an asset, since `txt` is only `getFileExtension`'s fallback.
 */
export function getContentTypeFromExtension(ext: string): string | null {
  return EXTENSION_CONTENT_TYPES[ext] ?? null
}

/** Pages and assets live in the wiki database, so this target cannot be disabled. */
export const DB_MODULE = 'db'

/** An ISO-8601 duration such as `PT5M` or `P1DT12H`, requiring at least one date or time component. */
const ISO_DURATION_PATTERN = /^P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/

/**
 * A `scheduleOverride` is either an ISO-8601 duration (`PT5M`) or a cron expression, parsed with the
 * same `cron-parser` `core/scheduler.ts` already uses for `jobSchedule` entries. The duration shape
 * is tried first: it needs no external parse.
 */
function isValidScheduleOverride(value: string): boolean {
  if (ISO_DURATION_PATTERN.test(value)) {
    return true
  }
  try {
    CronExpressionParser.parse(value)
    return true
  } catch {
    return false
  }
}

/**
 * A cron expression is due when it has an occurrence in `(lastTick, now]`, and `cron-parser` gives
 * that half-open window for free: `next()` always steps strictly past `currentDate`, and `endDate`
 * is validated inclusively -- so neither bound needs an off-by-one adjustment here.
 *
 * `Instant.add()` takes exact time units only, so a duration is flattened to milliseconds instead;
 * with no `relativeTo`, `total()` throws on a `years`/`months` component, which genuinely has no
 * fixed length without a calendar.
 *
 * @throws When `scheduleStr` is neither shape -- the caller (`tickScheduledSyncs`) logs and skips
 *   the target rather than letting this escape.
 */
function isScheduleDue(
  scheduleStr: string,
  lastTick: Temporal.Instant | null,
  now: Temporal.Instant
): boolean {
  if (ISO_DURATION_PATTERN.test(scheduleStr)) {
    const intervalMs = Math.round(
      Temporal.Duration.from(scheduleStr).total({ unit: 'milliseconds' })
    )
    return (
      !lastTick || Temporal.Instant.compare(now, lastTick.add({ milliseconds: intervalMs })) >= 0
    )
  }
  if (!lastTick) {
    CronExpressionParser.parse(scheduleStr) // -> throws on a genuinely invalid schedule string
    return true
  }
  const interval = CronExpressionParser.parse(scheduleStr, {
    currentDate: lastTick.toString({ smallestUnit: 'millisecond' }),
    endDate: now.toString({ smallestUnit: 'millisecond' }),
    tz: 'UTC'
  })
  return interval.hasNext()
}

/**
 * Actions that move a whole target's content, so `api/storage.ts` queues them through the scheduler
 * rather than running them inline on the request thread. A fast action such as `purge` stays
 * synchronous.
 */
export const SYNC_SHAPED_ACTIONS = ['sync', 'syncUntracked', 'importAll'] as const

/**
 * The storage-module handler each write-path event dispatches to, named to mirror 2.5.x's storage
 * module contract: pages get the bare verb, assets are prefixed so `renamed` cannot collide between
 * the two content types.
 *
 * `asset:edit` reuses `assetUploaded` rather than getting its own `assetUpdated`: to a storage
 * module, writing new bytes for a file that already exists is the same operation as writing them
 * for a new one — a git commit or an S3 `PUT` does not care whether the key existed before.
 */
const STORAGE_HANDLERS: Partial<Record<HookEvent, string>> = {
  'page:create': 'created',
  'page:edit': 'updated',
  'page:rename': 'renamed',
  'page:delete': 'deleted',
  'asset:upload': 'assetUploaded',
  'asset:edit': 'assetUploaded',
  'asset:rename': 'assetRenamed',
  'asset:move': 'assetMoved',
  'asset:delete': 'assetDeleted'
}

export interface StorageAction {
  handler: string
  label: string
  hint: string
  /** Turned into a confirmation prompt by the admin area. */
  warn?: string
  icon: string
}

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
  /** The modes a target may be set to: `sync`, `push`, `pull`. */
  supportedModes: string[]
  defaultMode: string
  /**
   * How often the module syncs on its own, as an ISO-8601 duration (`PT5M`); `false` for a module
   * that only ever acts on write.
   */
  schedule: string | false
  props: Record<string, ModuleProp>
  actions: StorageAction[]
  /** Whether a `storage.ts` sits next to the definition. */
  hasImplementation: boolean
  /**
   * Whether the module implements any of `STORAGE_HANDLERS`' write-path handlers, as opposed to
   * being configuration- and manual-action-only like `disk` and `sftp`. `dispatch()` skips queuing
   * a job for a target that could not act on one, and the admin area uses it to tell an author that
   * such a target does not sync on every page/asset change — only its listed actions write anything.
   */
  supportsContentSync: boolean
}

export interface StorageTarget {
  id: string
  /**
   * Not projected onto the API response, but a module implementation needs it: `executeAction()`
   * hands a module only the target, never the site, so an action handler reaching for
   * `CARDINAL.models.pages`/`CARDINAL.models.assets` has no other way to learn whose content it is
   * looking at.
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
    supportsContentSync: boolean
  }
  props: Record<string, ModuleProp>
  config: Record<string, any>
  actions: StorageAction[]
}

/** A patch: an absent field is left as it stands. */
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
 * Every handler here — the content-dispatch handlers, and any custom `[handler]` an action names —
 * receives the *full* `StorageTarget`, never a bare id: its `siteId` is the only way a handler
 * learns which site's pages/assets/tree rows it is scoped to.
 *
 * The content-dispatch handlers are called by the `dispatchStorage` task, never directly. `data`
 * carries only what the write-path call passed to `dispatch()` (id, path/fileName, siteId, ...) — a
 * handler needing the page render or asset bytes fetches them itself, so the queued job stays small
 * and JSON-serializable rather than carrying content through the job table.
 */
export interface StorageModule {
  /**
   * Module-specific validation beyond the generic type/enum check `Storage.validateConfig()` can do
   * from the props declaration alone — e.g. disk confirming its `path` prop is an absolute,
   * existing, writable directory rather than merely a non-empty string.
   *
   * @returns The reason it is invalid, or null when it is fine
   */
  validateConfig?: (config: Record<string, any>, target: StorageTarget) => Promise<string | null>
  created?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  updated?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  renamed?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  deleted?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  assetUploaded?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  /** A new name within the same folder; a move to a different one is `assetMoved`. */
  assetRenamed?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  /** Also fired once per descendant asset when an ancestor folder is renamed. */
  assetMoved?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  assetDeleted?: (target: StorageTarget, data: Record<string, any>) => Promise<void>
  /**
   * A direct URL to an asset's bytes on this target — e.g. a signed S3 URL — that lets a reader
   * fetch the file straight from the target instead of proxying it through this instance. `disk`
   * and `db` implement neither, a local path and a database row being no use to anything else.
   *
   * @param asset `folderPath` is required alongside `fileName` to rebuild the object key a blob
   *   target stored the file under (`helpers/blobTarget.ts`'s `objectKeyFor`)
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
 * A storage target is one module configured for one site — S3 for assets, git for pages, and so on.
 * Each module lives in `modules/storage/<key>/definition.yml`, which declares what it supports and
 * what it needs configured. Every site gets a row per module (see `syncSite`), so a target always
 * has a stable ID whether or not it has ever been enabled.
 *
 * Pages and assets are read and written straight from the database; a target's own sync/mirror
 * happens asynchronously, through the job `dispatch()` queues.
 */
class Storage {
  definitions: StorageDefinition[] = []

  modules: Record<string, StorageModule> = {}

  async refreshFromDisk(): Promise<void> {
    const storagePath = path.join(CARDINAL.SERVERPATH, 'modules/storage')
    try {
      const definitions = await readModuleDefinitions<StorageDefinition>(storagePath, {
        parseProps: true,
        sortPropsByOrder: true,
        decorate: async (parsed, key) => {
          // -> Declared in YAML as a map keyed by handler, which reads better there than a list of
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
      // -> After the assignment, not inside the loop that built it: `ensureModule()` reads
      //    `this.definitions` itself to decide whether the module has an implementation to load
      for (const definition of this.definitions) {
        definition.supportsContentSync = definition.hasImplementation
          ? await this.moduleSupportsContentSync(definition.key)
          : false
      }
      CARDINAL.logger.debug('storage', 'loaded module definitions', {
        modules: this.definitions.length
      })
    } catch (err: any) {
      this.definitions = []
      CARDINAL.logger.error('storage', 'reading the module definitions failed', {
        path: storagePath,
        error: err
      })
    }
  }

  async hasImplementation(key: string): Promise<boolean> {
    return moduleHasFile(CARDINAL.SERVERPATH, 'modules/storage', key, 'storage.ts')
  }

  async moduleSupportsContentSync(key: string): Promise<boolean> {
    const mod = await this.ensureModule(key)
    if (!mod) {
      return false
    }
    return Object.values(STORAGE_HANDLERS).some((handler) => typeof mod[handler] === 'function')
  }

  getDefinition(key: string): StorageDefinition | null {
    return this.definitions.find((d) => d.key === key) ?? null
  }

  /**
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

  async syncAllSites(): Promise<void> {
    const sites = await CARDINAL.db.select({ id: sitesTable.id }).from(sitesTable)
    for (const site of sites) {
      await CARDINAL.models.storage.syncSite(site.id)
    }
    CARDINAL.logger.info('storage', 'registered targets', { sites: sites.length })
  }

  /** The stored rows alone, with nothing merged in from the definitions on disk. */
  async getTargets({
    siteId,
    enabledOnly = false
  }: { siteId?: string; enabledOnly?: boolean } = {}) {
    const conditions = [
      siteId ? eq(storageTable.siteId, siteId) : undefined,
      enabledOnly ? eq(storageTable.isEnabled, true) : undefined
    ].filter(Boolean)
    return CARDINAL.db
      .select()
      .from(storageTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
  }

  /**
   * Config values are completed from the module's declared defaults, so a prop added to a module
   * after a target was configured is returned with its default rather than as a missing key.
   *
   * @param opts.mask Replaces a `sensitive` prop's stored value with a mask. Defaults to false:
   *   this is the *only* place a target's config is assembled, and every caller that actually
   *   connects needs the real values. Only an admin-facing read that serializes `config` straight
   *   into an HTTP response should pass `{ mask: true }`.
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

  async getSiteTargetById(
    siteId: string,
    id: string,
    opts?: { mask?: boolean }
  ): Promise<StorageTarget | null> {
    return (await this.getSiteTargets(siteId, opts)).find((t) => t.id === id) ?? null
  }

  buildConfig(
    moduleKey: string,
    incoming: Record<string, any> = {},
    existing: Record<string, any> = {}
  ): Record<string, any> {
    return mergeModuleConfig(this.getDefinition(moduleKey)?.props ?? {}, incoming, existing)
  }

  /**
   * An unknown key is dropped by `buildConfig` rather than refused here, so a module losing a prop
   * can never make the admin area unable to save.
   *
   * @returns The reason it is invalid, or null when it is fine
   */
  validateConfig(moduleKey: string, incoming: Record<string, any> = {}): string | null {
    return validateModuleConfig(this.getDefinition(moduleKey)?.props ?? {}, incoming)
  }

  /**
   * Async because of its last step: the module's own deep check (see `StorageModule.validateConfig`)
   * runs only when the patch touches `config` or turns the target on, since it loads the module and,
   * for one like disk, hits the filesystem — a sync-mode or schedule change re-validating an
   * unrelated config on every save would be pure overhead.
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
      if (!isValidScheduleOverride(patch.sync.scheduleOverride)) {
        return `"${patch.sync.scheduleOverride}" is not a valid ISO-8601 duration or cron expression.`
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
   * Capabilities the module does not have are stored as off whatever was asked for, and versioning
   * it forces on is stored as on — the admin area disables those controls, but the values are the
   * module's to decide, not the client's.
   *
   * @returns Whether anything was written
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

    const result = await CARDINAL.db
      .update(storageTable)
      .set(values)
      .where(and(eq(storageTable.siteId, siteId), eq(storageTable.id, target.id)))
    return (result.rowCount ?? 0) > 0
  }

  /**
   * An asset at or above *this target's own* `largeThreshold` is asked about as `large` rather than
   * its kind-based bucket: the threshold lives on the target, not the module, so the same file can
   * be "large" for one target and not another. Parsing and the at-or-above comparison go through
   * `helpers/blobTarget.ts`'s `parseLargeThreshold`, the single parser every `largeThreshold` reader
   * shares, so every size-aware classification agrees on exactly the same file.
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
   * Queue a sync job on every enabled target that syncs this event's content in `push` or `sync`
   * mode. Like `hooks.emit()`, it never throws — a broken or unconfigured target must not fail the
   * write that triggered it — and only writes scheduler jobs: delivery happens in the
   * `dispatchStorage` task, never inline here.
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
        // -> A module with no write-path handlers can do nothing with a queued job; skipping here
        //    beats having every one of them land in `dispatchStorage`'s no-op branch
        if (!this.getDefinition(target.module)?.supportsContentSync) {
          continue
        }
        if (!this.targetCoversEvent(target, event, data)) {
          continue
        }
        const added = await CARDINAL.scheduler.addJob({
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
      CARDINAL.logger.warn('storage', 'queueing the dispatch failed', { event, error: err })
      return 0
    }
  }

  /**
   * Queue a sync for every enabled pull/two-way target whose schedule has elapsed since its last
   * tick -- the scheduled counterpart to `dispatch()`'s write-path one.
   *
   * A target whose own `sync.mode` is `push` is skipped even on a module that supports scheduling
   * (git can run in `push` mode too): it already gets everything it needs from the write-path hook,
   * and ticking it here would risk a spurious inbound sync. An unparseable schedule is logged and
   * skipped rather than thrown, so one bad target cannot fail the whole tick.
   *
   * Nothing per-target is remembered but `lastTickAt`, and it advances only once the job is queued:
   * a failed enqueue leaves the target due next tick, a job that fails after being queued is not the
   * schedule's business, and a target whose remote has been unreachable for a week needs no
   * administrator action to resume -- it is simply due again at its next interval. `scheduleOverride`
   * is re-read every tick too, so a shortened interval takes effect on the next one, not on restart.
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
      const lastTick = row.lastTickAt ? row.lastTickAt.toTemporalInstant() : null
      let due: boolean
      try {
        due = isScheduleDue(scheduleStr as string, lastTick, now)
      } catch (err: any) {
        CARDINAL.logger.warn('storage', 'unparseable sync schedule, skipping the target', {
          target: row.id,
          schedule: scheduleStr,
          error: err
        })
        continue
      }
      if (!due) {
        continue
      }
      const added = await CARDINAL.scheduler.addJob({
        task: 'dispatchStorage',
        payload: { targetId: row.id, siteId: row.siteId, handler: 'sync', data: {} }
      })
      if (!added?.id) {
        continue
      }
      await CARDINAL.db
        .update(storageTable)
        .set({ lastTickAt: new Date(now.epochMilliseconds) })
        .where(eq(storageTable.id, row.id))
      queued++
    }
    return queued
  }

  /**
   * Run the `dailyBackup` handler for every enabled target, across every site, whose module declares
   * one and whose `config.createDailyBackups` is on. The check is deliberately generic rather than
   * hard-coded to the modules that implement the handler today.
   *
   * A single target's failure (e.g. its path became unwritable) is logged and does not stop the
   * rest, for the same reason `tickScheduledSyncs()` isolates its own per-target loop: one bad
   * target must not turn into every other site's backup silently not running tonight.
   */
  async runDailyBackups(): Promise<{ ran: number; failed: number }> {
    const sites = await CARDINAL.db.select({ id: sitesTable.id }).from(sitesTable)
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
          CARDINAL.logger.warn('storage', 'daily backup failed', {
            target: target.id,
            module: target.module,
            site: site.id,
            error: err
          })
        }
      }
    }
    return { ran, failed }
  }

  /**
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
   * @returns Whatever the handler resolves to — `undefined` for a fire-and-forget handler, or a
   *   result such as `purge`'s `{ purged, skipped }`, which `api/storage.ts`'s action route carries
   *   into the reply's `message` instead of a fixed string
   * @throws When the module cannot be loaded or does not implement the handler
   */
  async executeAction(target: StorageTarget, handler: string): Promise<unknown> {
    const mod = await this.ensureModule(target.module)
    if (!mod) {
      throw new Error(`The ${target.title} storage module has no implementation installed.`)
    }
    if (typeof mod[handler] !== 'function') {
      throw new Error(`The ${target.title} storage module does not implement "${handler}".`)
    }
    return await mod[handler](target)
  }
}

export const storage = new Storage()
