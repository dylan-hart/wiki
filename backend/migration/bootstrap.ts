/**
 * Shared boot sequence for the standalone migration CLI entry points under `../tasks/`
 * (`migrate.ts`, `verify-migration.ts`). Modeled on `worker.ts`'s minimal `CARDINAL`, not
 * `index.ts`'s full boot: no HTTP server, real scheduler, cache backend or collab websockets.
 * `CARDINAL.events`/`cache`/`scheduler` are stubs rather than undefined because the models loaded
 * here reach for all three unconditionally on their normal write paths.
 */

import crypto from 'node:crypto'
import path from 'node:path'
import configSvc from '../core/config.ts'
import dbManager from '../core/db.ts'
import logger from '../core/logger.ts'
import { jobs as jobsTable } from '../db/schema.ts'
import { ExportBundleSourceConnector } from './connectors/export-bundle.ts'
import { PostgresSourceConnector } from './connectors/postgres.ts'
import type { ParsedSource } from './source-args.ts'
import type { SourceConnector } from './connector.ts'
import type { SystemGroupIds } from './importers/users-groups.ts'

/**
 * Only the models an import/verify phase reaches, not the full `models/index.ts` registry: a
 * one-shot process pays the import cost of everything it pulls in. Sized against transitive calls
 * too — `pages.createPage()` and `assets.upload()` reach most of these, not the importers themselves.
 *
 * A call through an unloaded model throws a `TypeError` at runtime, not a type error
 * (`types/global.d.ts` types `CARDINAL.models` as fully populated), and `--dry-run` never reaches the
 * real write paths, so only a live run proves this set complete. `glossary` is deliberately absent:
 * no write path an importer calls reaches it.
 */
export async function loadModels(): Promise<CardinalGlobal['models']> {
  const [
    { sites },
    { settings },
    { users },
    { groups },
    { authentication },
    { storage },
    { tags },
    { tree },
    { pages },
    { pageHistory },
    { pageClassification },
    { extensions },
    { blocks },
    { assets },
    { comments },
    { locales },
    { renderQueue },
    { rendering },
    { search },
    { hooks },
    { flags },
    { classificationLevels },
    { navigation },
    { security }
  ] = await Promise.all([
    import('../models/sites.ts'),
    import('../models/settings.ts'),
    import('../models/users.ts'),
    import('../models/groups.ts'),
    import('../models/authentication.ts'),
    import('../models/storage.ts'),
    import('../models/tags.ts'),
    import('../models/tree.ts'),
    import('../models/pages.ts'),
    import('../models/pageHistory.ts'),
    import('../models/pageClassification.ts'),
    import('../models/extensions.ts'),
    import('../models/blocks.ts'),
    import('../models/assets.ts'),
    import('../models/comments.ts'),
    import('../models/locales.ts'),
    import('../models/renderQueue.ts'),
    import('../models/rendering.ts'),
    import('../models/search.ts'),
    import('../models/hooks.ts'),
    import('../models/flags.ts'),
    import('../models/classificationLevels.ts'),
    import('../models/navigation.ts'),
    import('../models/security.ts')
  ])
  return {
    sites,
    settings,
    users,
    groups,
    authentication,
    storage,
    tags,
    tree,
    pages,
    pageHistory,
    pageClassification,
    extensions,
    blocks,
    assets,
    comments,
    locales,
    renderQueue,
    rendering,
    search,
    hooks,
    flags,
    classificationLevels,
    navigation,
    security
  } as CardinalGlobal['models']
}

export function createEventsStub(): CardinalGlobal['events'] {
  const bus = () => ({
    emit: async () => {},
    on: () => {},
    onAny: () => {},
    offAny: () => {},
    clearListeners: () => {}
  })
  return { inbound: bus(), outbound: bus() } as unknown as CardinalGlobal['events']
}

export function createCacheStub(): CardinalGlobal['cache'] {
  const store = new Map<string, unknown>()
  const stub = {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value)
      return stub
    },
    has: (key: string) => store.has(key),
    delete: (key: string) => store.delete(key),
    getRemainingTTL: () => 0,
    clear: () => store.clear()
  }
  return stub as unknown as CardinalGlobal['cache']
}

/**
 * `CARDINAL.scheduler` stand-in with no piscina pool and no registered task-function map, so unlike
 * the real `core/scheduler.ts` it cannot execute a job: it inserts the same `jobs` row the real
 * `addJob()` would, best-effort, and the operator's already-running server claims it on its next
 * poll.
 *
 * Only `renderPages` is supported — a real scheduler decides a job's `useWorker` from its registered
 * task-function map, so guessing for an unlisted task would misroute the row on whichever live server
 * picks it up. `embedPage` queues no row at all: `models/pages.ts#createPage()` enqueues one per page,
 * so a real corpus means thousands of identical calls; the admin area's "rebuild embeddings index"
 * action re-embeds a whole site in one pass and is the supported way to populate semantic search
 * after a migration.
 */
export function createSchedulerStub(): CardinalGlobal['scheduler'] {
  const USE_WORKER: Record<string, boolean> = { renderPages: false }
  let notedDeferredEmbed = false
  return {
    async addJob({
      task,
      payload = {},
      maxRetries,
      isScheduled = false,
      waitUntil
    }: {
      task: string
      payload?: any
      maxRetries?: number
      isScheduled?: boolean
      waitUntil?: Date
    }) {
      if (task === 'embedPage') {
        if (!notedDeferredEmbed) {
          notedDeferredEmbed = true
          CARDINAL.logger.info(
            'migrate',
            "migrated pages are not individually queued for embedding — run the admin area's " +
              '"rebuild embeddings index" action for this site after the migration completes to ' +
              'populate semantic search'
          )
        }
        return undefined
      }
      if (!(task in USE_WORKER)) {
        CARDINAL.logger.warn(
          'migrate',
          'cannot queue this task, the CLI scheduler stub only supports renderPages',
          { task }
        )
        return undefined
      }
      try {
        await CARDINAL.db.insert(jobsTable).values({
          id: crypto.randomUUID(),
          task,
          useWorker: USE_WORKER[task]!,
          payload,
          maxRetries: maxRetries ?? 0,
          isScheduled,
          waitUntil,
          createdBy: 'migrate-cli'
        })
      } catch (err: any) {
        CARDINAL.logger.warn('migrate', 'queueing a task failed', { task, error: err })
      }
      return undefined
    }
  } as unknown as CardinalGlobal['scheduler']
}

/**
 * The synchronous, no-I/O part of `CARDINAL` that `bootstrapMigrationRuntime()` builds before any of
 * `configSvc.init()`/`dbManager.init()`/`loadModels()` run — its own pure function so a fast, DB-free
 * unit test can assert the shape.
 *
 * `auth` is the load-bearing member: `models/authentication.ts#activateStrategies()`, called
 * unconditionally at the end of every `createStrategy()`/`updateStrategy()`/`deleteStrategy()`,
 * assigns `CARDINAL.auth.strategies` with no guard for `auth` being unset. `--dry-run` never invokes a
 * write callback, so omitting it fails only on a real run, never the rehearsal.
 */
export function buildWikiShell(
  instanceId: string
): Pick<
  CardinalGlobal,
  'IS_DEBUG' | 'ROOTPATH' | 'INSTANCE_ID' | 'SERVERPATH' | 'configSvc' | 'auth'
> {
  return {
    IS_DEBUG: process.env.NODE_ENV === 'development',
    ROOTPATH: process.cwd(),
    INSTANCE_ID: instanceId,
    SERVERPATH: path.join(process.cwd(), 'backend'),
    configSvc,
    auth: { groups: {}, strategies: {} }
  }
}

/**
 * Sets up the ambient `CARDINAL` global and connects it to the 3.0 destination database.
 * `dbManager.init()` leaves `workerMode` at `false`, so this legitimately runs `syncSchemas()` ->
 * `checkForLegacyInstall()` + migrations against the destination: the *destination* must be a current
 * 3.0 schema, so refusing a 2.x-shaped one is exactly the right check here.
 */
export async function bootstrapMigrationRuntime(instanceId: string): Promise<CardinalGlobal> {
  const CARDINAL = buildWikiShell(instanceId) as unknown as CardinalGlobal
  global.CARDINAL = CARDINAL

  await CARDINAL.configSvc.init()
  CARDINAL.logger = logger.init()

  CARDINAL.dbManager = dbManager
  CARDINAL.db = await dbManager.init()
  CARDINAL.models = await loadModels()
  CARDINAL.events = createEventsStub()
  CARDINAL.cache = createCacheStub()
  CARDINAL.scheduler = createSchedulerStub()

  // The `settings` phase's `AuthModuleResolver`/`StorageModuleResolver` resolve every module through
  // `CARDINAL.data.authentication`/`CARDINAL.models.storage.definitions`, which start out empty until
  // something loads them from disk. Left unpopulated, every authentication/storage row the migration
  // reads resolves `getModule()`/`getDefinition()` as `null` and gets misreported `unsupported`,
  // regardless of the source module's real 3.0 support.
  await CARDINAL.models.authentication.refreshStrategiesFromDisk()
  await CARDINAL.models.storage.refreshFromDisk()

  // Same gap, for `extensions`: `helpers/puppeteer.ts#isPuppeteerAvailable()` — and therefore
  // `tasks/migrate.ts`'s `resolveRenderMode()`, which decides `--render-mode auto` — reads
  // `CARDINAL.models.extensions.getDefinition('puppeteer')`, which answers `null` ("not available")
  // until `refreshFromDisk()` has populated `definitions` at least once. Left uncalled, `auto`
  // resolves to `'passthrough'` even on a destination that does have Puppeteer installed.
  await CARDINAL.models.extensions.refreshFromDisk()

  // Same shape of gap, for a `ClusterReloaded` cache instead of a disk read:
  // `CARDINAL.models.pages.createPage()` -> `pageClassification.resolveCreateClassification()` reads
  // `classificationLevels`' in-memory `levels` array, which starts empty and is only ever populated by
  // `reloadCache()` (a real server boot calls it during `preBoot()`). Left unpopulated,
  // `defaultLevel()` throws on the very first page a live `content` phase writes — invisible to
  // `--dry-run`, which never reaches `createPage()`.
  await CARDINAL.models.classificationLevels.reloadCache()

  // The `users` phase needs `CARDINAL.config.auth.rootAdminGroupId`/`rootAdminUserId` — per-install
  // ids `Settings.init()` persisted to the `settings` table at seed time, not anything
  // `configSvc.init()` above (config.yml + base.yml only) ever populates. `loadFromDb()` rather than
  // `ensureSeeded()`: the destination is required to already be a previously-seeded 3.0 install, so
  // there is no "needs seeding" case for this CLI. Its boolean return (`false` means the `settings`
  // table was empty) must not be discarded, or `resolveUsersImportContext()` below silently resolves
  // `undefined` ids from an empty `CARDINAL.config.auth`, which `createUserGroupImporter()` treats as
  // "unresolvable" and quietly skips every source-Administrators/-Guests membership.
  if (!(await CARDINAL.configSvc.loadFromDb())) {
    throw new Error(
      'No settings found in the destination database. The destination must be a previously-booted ' +
        '3.0 install (run the main Wiki.js server against it at least once) before migrating into it.'
    )
  }

  return CARDINAL
}

/**
 * Resolves the three identifiers the `users` and `content` phases need from the destination install
 * but cannot derive from the 2.x source. `localStrategyId`/`guestsGroupId` are fixed `base.yml`
 * `systemIds` constants every 3.0 install seeds identically (no DB round trip);
 * `rootAdminGroupId`/`rootAdminUserId` are per-install ids under the `auth` settings key, so reading
 * them requires `bootstrapMigrationRuntime()`'s `configSvc.loadFromDb()` call.
 *
 * The target site's primary locale is deliberately NOT resolved here: a value captured before any
 * phase had run would leave the `content`/`assets` phases seeing the destination's PRE-migration
 * locale even after the `settings` phase had changed it. `context.ts#resolvePrimaryLocale()` reads it
 * fresh instead, at the point a phase actually needs it.
 */
export function resolveUsersImportContext(CARDINAL: CardinalGlobal): {
  localStrategyId: string
  systemGroupIds: SystemGroupIds
  operatorActorId: string
} {
  const localStrategyId = CARDINAL.data.systemIds.localAuthId
  const adminGroupId = CARDINAL.config.auth?.rootAdminGroupId
  const guestGroupId = CARDINAL.data.systemIds.guestsGroupId
  const operatorActorId = CARDINAL.config.auth?.rootAdminUserId

  // `CARDINAL.config.auth` is typed `any`, so a malformed `settings.auth` row would otherwise resolve
  // `undefined` here silently: `createUserGroupImporter()` treats an unresolved `systemGroupIds.admin`/
  // `.guest` as "not created" and quietly skips every membership pointing at the source's
  // Administrators/Guests group, and a `content` phase handed `operatorActorId: undefined` has no
  // working fallback author. `bootstrapMigrationRuntime()`'s `loadFromDb()` check already refuses an
  // empty `settings` table; this is the belt for a present-but-malformed one.
  if (!localStrategyId || !adminGroupId || !guestGroupId || !operatorActorId) {
    throw new Error(
      'Could not resolve one or more of localStrategyId/systemGroupIds/operatorActorId from the ' +
        'destination: base.yml systemIds or the settings.auth row is missing/malformed ' +
        `(localStrategyId=${String(localStrategyId)}, adminGroupId=${String(adminGroupId)}, ` +
        `guestGroupId=${String(guestGroupId)}, operatorActorId=${String(operatorActorId)}).`
    )
  }

  return {
    localStrategyId,
    systemGroupIds: { admin: adminGroupId, guest: guestGroupId },
    operatorActorId
  }
}

/** The returned connector is not connected — the caller owns `connect()`/`disconnect()`. */
export function buildSourceConnector(source: ParsedSource): SourceConnector {
  return source.kind === 'postgres'
    ? new PostgresSourceConnector(source.config)
    : new ExportBundleSourceConnector(source.path)
}
