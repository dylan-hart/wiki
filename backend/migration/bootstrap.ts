/**
 * Shared boot sequence for every standalone migration-CLI entry point under `../tasks/` —
 * `migrate.ts` (the import) and `verify-migration.ts` (Feature 421 task 748's post-import
 * verification). Both need the exact same minimal runtime and nothing else: modeled on `worker.ts`'s
 * minimal `WIKI` global, not `index.ts`'s full boot — no HTTP server, no real scheduler, no real cache
 * backend, no collab websockets, just enough to talk to the 3.0 destination database and run the
 * model methods each script needs. `WIKI.events`/`WIKI.cache`/`WIKI.scheduler` are still populated,
 * with no-op-or-best-effort stubs (see `createEventsStub()`/`createCacheStub()`/
 * `createSchedulerStub()` below) rather than left undefined, because the models this bootstrap loads
 * unconditionally reach for all three on their normal write paths.
 *
 * Extracted out of `migrate.ts` (which originally inlined this) so `verify-migration.ts` does not
 * have to duplicate it — see task 748's own description, "sharing the harness's bootstrap".
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
 * Only the models an import/verify phase actually reads/writes through, never the full 27-model
 * registry `models/index.ts` exports. Same principle `worker.ts` follows for its one model: a
 * one-shot process pays the import cost of everything it pulls in, and the full registry drags in
 * cheerio, sanitize-html, bcrypt and the rest of the HTTP-server-only models for a script that never
 * serves a request.
 *
 * This set is sized against the model calls the built importers actually make, not just the ones
 * they call directly:
 * - `sites`, `settings`, `users`, `groups`, `authentication`, `storage`, `tags`, `tree`, `pages`,
 *   `pageHistory`, `assets` — called directly by `importers/users-groups.ts` and
 *   `importers/page-import.ts`.
 * - `comments` — called directly by `importers/comment-import.ts`, via `phases/assets.ts`'s
 *   `commentsModel.create()`.
 * - `locales`, `rendering`, `search`, `hooks`, `flags`, `classificationLevels`, `pageClassification`,
 *   `blocks` — reached transitively via `WIKI.models.pages.createPage()`
 *   (`models/pages.ts:681,688,697,728,766,825,878,918,919,927`), the only page write path an importer
 *   calls today. `pageClassification` specifically backs `createPage()`'s
 *   `resolveCreateClassification()` call (`models/pages.ts:878`); `blocks` backs
 *   `models/rendering.ts`'s `getEnabledKeys(siteId)` call in the render pipeline `createPage()` runs
 *   every new page through. `blocks.getEnabledKeys()` is a plain live `WIKI.db` read with no cache to
 *   warm — unlike `classificationLevels` below, adding it needed no companion reload call.
 * - `extensions` — reached transitively via `WIKI.models.assets.upload()`'s thumbnail generation
 *   (`helpers/images.ts`'s `resizeImageToSquareJpeg()`/`normalizeImage()`, both call
 *   `WIKI.models.extensions.getDefinition('sharp')`) AND via `helpers/puppeteer.ts#isPuppeteerAvailable()`
 *   (`WIKI.models.extensions.getDefinition('puppeteer')`), which `tasks/migrate.ts`'s
 *   `resolveRenderMode()` calls to resolve `--render-mode auto`. Its `definitions` array is only ever
 *   populated by an explicit `refreshFromDisk()` — this bootstrap calls it, same as the
 *   `authentication`/`storage` calls just below, specifically so the Puppeteer check answers for
 *   real rather than unconditionally `false` (a real instance without Sharp/Puppeteer installed looks
 *   identical to one this bootstrap never refreshed, which is exactly why the gap went unnoticed until
 *   a real migration run against an instance that DID have Puppeteer resolved `'auto'` to
 *   `'passthrough'` anyway).
 *
 * - `navigation` — called directly by `phases/content.ts` (`WIKI.models.navigation.ensureSiteNav`
 *   et al.).
 * - `security` — called directly by `phases/settings.ts`: the settings phase's
 *   `security`-keyed instance-settings patch goes through the real `WIKI.models.security.updateConfig()`
 *   (the same merge-then-`saveToDb()` path `api/system/settings.ts` uses), not a raw
 *   `WIKI.models.settings.updateConfig('security', ...)` — the latter is a wholesale JSONB replace
 *   that would silently delete every 3.0-only `security` field the 2.x mapper's patch doesn't produce.
 * - `eventSubscriptions` — reached transitively via `models/hooks.ts`'s
 *   `notifyEventSubscriptionSubscribers()` (`WIKI.models.eventSubscriptions.listSubscribers(event)`),
 *   itself called unconditionally by `createPage()`'s own `announce('page:create', ...)`. Unreachable
 *   on a migration into a fresh site in practice (no subscriber rows exist yet to notify), but
 *   `hooks.ts` calls `.listSubscribers()` before checking whether any exist, so the unloaded-model
 *   `TypeError` fired on every single page anyway — caught by `hooks.ts`'s own try/catch (a warning
 *   per page, not a failed import), but 158 warnings is still worth not shipping.
 *
 * `pageClassification`, `extensions`, `blocks` and `eventSubscriptions` were each omitted here once —
 * every one threw `Cannot read properties of undefined` on every real (non-dry-run) write that reached
 * it, while a dry run stayed silent, since `--dry-run` never reaches the real `createPage()`/
 * `upload()` paths. `pageClassification`/`blocks`/`extensions`(Puppeteer) failed the whole page;
 * `eventSubscriptions` only warned, since `hooks.ts` already wraps that call — the reason a live
 * migration run is the only thing that can prove this model set is actually complete; a dry run
 * cannot, and neither can a clean phase report alone, since a caught-and-logged failure like this one
 * leaves `wouldCreate` looking correct.
 *
 * `glossary` is deliberately NOT included: it is only reached through `pages.ts`'s `updatePage`/
 * `movePage`/`deletePage`, and no importer built so far calls any of those. Add it here the moment
 * one does — a call through an unloaded model throws `TypeError: Cannot read properties of
 * undefined`, not a type error, since `types/global.d.ts` types `WIKI.models` as fully populated.
 */
export async function loadModels(): Promise<WikiGlobal['models']> {
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
    { security },
    { eventSubscriptions }
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
    import('../models/security.ts'),
    import('../models/eventSubscriptions.ts')
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
    security,
    eventSubscriptions
  } as WikiGlobal['models']
}

/**
 * No-op `WIKI.events` stub: a one-shot CLI process has no cluster to broadcast an HA propagation
 * event to, but write paths that unconditionally call `WIKI.events.outbound.emit(...)`
 * (`models/groups.ts#broadcastReload`, for one) need the member to exist. Shaped like
 * `backend/test/mocks.ts#createEventsStub()`.
 */
export function createEventsStub(): WikiGlobal['events'] {
  const bus = () => ({
    emit: async () => {},
    on: () => {},
    onAny: () => {},
    offAny: () => {},
    clearListeners: () => {}
  })
  return { inbound: bus(), outbound: bus() } as unknown as WikiGlobal['events']
}

/**
 * No-op `WIKI.cache` stub: nothing in a one-shot CLI process benefits from a request-scoped cache,
 * but write paths that unconditionally touch `WIKI.cache` need the member to exist. Shaped like
 * `backend/test/mocks.ts#createCacheStub()`.
 */
export function createCacheStub(): WikiGlobal['cache'] {
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
  return stub as unknown as WikiGlobal['cache']
}

/**
 * `WIKI.scheduler` stand-in for this bootstrap: no poolifier pool, no registered task-function map,
 * so unlike the real `core/scheduler.ts` this cannot execute a job itself. `addJob()` is the one
 * method any model this bootstrap loads reaches for — `models/renderQueue.ts#queuePage()`, to kick a
 * headless-browser render for `--render-mode queue`/`auto`'s 'queue' path (`models/pages.ts#createPage()`'s
 * `enqueueRerender()` call), and `models/hooks.ts`'s webhook/event-subscriber dispatch (unreachable on
 * a migration into a fresh site, since every one of those call sites is gated behind an already-
 * existing webhook/subscriber row a fresh site never has yet). Rather than execute anything, it
 * inserts the same `jobs` row the real `addJob()` would, best-effort (matching its own
 * error-swallowing behavior — `WIKI.logger.warn` rather than throw) — this bootstrap's own
 * `bootstrapMigrationRuntime()` already refuses a destination that was never booted, so the operator's
 * already-running live server picks the row up on its own next poll (`core/scheduler.ts`'s 5-second
 * `pollingCheck`), the same way it would pick up a page left queued across a restart (`index.ts`'s own
 * boot-time `renderPages` sweep) — no NOTIFY needed for that, the poll alone is enough, just slower.
 *
 * Only `'renderPages'` (a `tasks/simple/` task, run in-process — never a worker thread) is actually
 * supported. A real scheduler decides a job's `useWorker` from its own registered task-function map,
 * which this stub has none of, so guessing wrong for an unlisted task would misroute it on whichever
 * live server picks the row up; logging and skipping is the safe default for anything else, matching
 * `WIKI.events`/`WIKI.cache`'s own "reached transitively, never actually needed yet" stub philosophy.
 */
export function createSchedulerStub(): WikiGlobal['scheduler'] {
  const USE_WORKER: Record<string, boolean> = { renderPages: false }
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
      if (!(task in USE_WORKER)) {
        WIKI.logger.warn(
          'migrate',
          'cannot queue this task, the CLI scheduler stub only supports renderPages',
          { task }
        )
        return undefined
      }
      try {
        await WIKI.db.insert(jobsTable).values({
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
        WIKI.logger.warn('migrate', 'queueing a task failed', { task, error: err })
      }
      return undefined
    }
  } as unknown as WikiGlobal['scheduler']
}

/**
 * The synchronous, no-I/O part of `WIKI` that `bootstrapMigrationRuntime()` builds before any of
 * `configSvc.init()`/`dbManager.init()`/`loadModels()` run — pulled out as its own pure function so
 * this exact shape can be asserted by a fast, DB-free unit test (`bootstrap.test.ts`).
 *
 * `auth` matters here specifically: `models/authentication.ts#activateStrategies()` — called
 * unconditionally at the end of every `createStrategy()`/`updateStrategy()`/`deleteStrategy()` — does
 * `WIKI.auth.strategies = {}` with no guard for it being unset. Before this function existed, this
 * bootstrap's `WIKI` literal omitted `auth` entirely (unlike `index.ts` and
 * `test/db.ts#installTestWiki()`, both of which already seed the same empty shape), because no caller
 * had ever created an authentication strategy through this bootstrap before the `settings` phase
 * (Task 15). The result (caught by Task 15's own review round): the auth row insert inside
 * `createStrategy()` succeeds, then `activateStrategies()` throws
 * `TypeError: Cannot set properties of undefined (setting 'strategies')`, which propagates out of the
 * recorder's `write` callback and fails the whole `settings` phase with `status: 'error'` — and since
 * `--dry-run` never invokes a `create()` write callback at all, this only ever surfaces on a real, live
 * run, never during the rehearsal an operator would run first.
 */
export function buildWikiShell(
  instanceId: string
): Pick<WikiGlobal, 'IS_DEBUG' | 'ROOTPATH' | 'INSTANCE_ID' | 'SERVERPATH' | 'configSvc' | 'auth'> {
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
 * Sets up the ambient `WIKI` global and connects it to the 3.0 destination database: `configSvc`,
 * `logger`, then `dbManager.init()` (with `workerMode` defaulting to `false`, so this legitimately
 * runs `syncSchemas()` -> `checkForLegacyInstall()` + migrations against the 3.0 destination, same as
 * `index.ts`'s `preBoot()` — the *destination* must be a current 3.0 schema, so refusing a 2.x-shaped
 * one is exactly the right check here), then the narrow model subset above.
 *
 * `instanceId` distinguishes entry points in logs (`migrate-cli` vs. `verify-migration-cli`) without
 * either needing to know about the other.
 */
export async function bootstrapMigrationRuntime(instanceId: string): Promise<WikiGlobal> {
  const WIKI = buildWikiShell(instanceId) as unknown as WikiGlobal
  global.WIKI = WIKI

  await WIKI.configSvc.init()
  WIKI.logger = logger.init()

  WIKI.dbManager = dbManager
  WIKI.db = await dbManager.init()
  WIKI.models = await loadModels()
  WIKI.events = createEventsStub()
  WIKI.cache = createCacheStub()
  WIKI.scheduler = createSchedulerStub()

  // The `settings` phase reads/writes through `WIKI.models.authentication`/
  // `WIKI.models.storage` as the mappers' own `AuthModuleResolver`/`StorageModuleResolver` — both
  // resolve every module through `WIKI.data.authentication`/`WIKI.models.storage.definitions`, which
  // start out empty (`{}`/`[]`) until something loads them from disk. `index.ts`'s `postBoot()` does
  // exactly that for a real server boot (`refreshStrategiesFromDisk()`/`refreshFromDisk()`), but this
  // minimal bootstrap had no caller that needed either populated before now — left unpopulated, every
  // authentication/storage row the migration reads would resolve `getModule()`/`getDefinition()` as
  // `null` and get misreported `unsupported`, regardless of the source module's real 3.0 support.
  await WIKI.models.authentication.refreshStrategiesFromDisk()
  await WIKI.models.storage.refreshFromDisk()

  // Same gap as the two calls above, for `extensions`: `helpers/puppeteer.ts#isPuppeteerAvailable()`
  // (and therefore `WIKI.models.renderQueue.isAvailable()`, which `tasks/migrate.ts`'s
  // `resolveRenderMode()` calls to decide `--render-mode auto`) reads
  // `WIKI.models.extensions.getDefinition('puppeteer')`, which answers `null` — "not available" —
  // until `refreshFromDisk()` has populated `definitions` at least once. Left uncalled, `auto` always
  // resolved to `'passthrough'` regardless of whether this destination actually has Puppeteer
  // installed, silently defeating the whole point of the default (caught only by running a real
  // migration against an instance that does have it — a dry run/unit test never reaches this call at
  // all). The `extensions`/Sharp-thumbnail use inside `helpers/images.ts` (see `loadModels()`'s own
  // doc comment above) stays correct either way — an empty `definitions` there answers "Sharp isn't
  // available" precisely because a real instance without the extension looks identical, and thumbnail
  // generation already treats that as "fall back to the original bytes", not an error.
  await WIKI.models.extensions.refreshFromDisk()

  // Same shape of gap as the two calls above, for a `ClusterReloaded` cache instead of a disk read:
  // `WIKI.models.pages.createPage()` -> `pageClassification.resolveCreateClassification()` falls back
  // to `WIKI.models.classificationLevels.defaultLevel()` for every page with no parent to inherit a
  // floor from, and `byId()` for one with an explicit level — both read the model's in-memory
  // `levels` array, which starts empty and is only ever populated by `reloadCache()` (a real server
  // boot calls it during `preBoot()`; this minimal bootstrap otherwise never would). Left unpopulated,
  // `defaultLevel()` throws `No classification levels are configured.` on the very first page a live
  // `content` phase writes — again invisible to `--dry-run`, which never reaches `createPage()`.
  await WIKI.models.classificationLevels.reloadCache()

  // The `users` phase needs `WIKI.config.auth.rootAdminGroupId`/`rootAdminUserId` —
  // real, per-install ids `Settings.init()` persisted to the `settings` table at seed time, not
  // anything `configSvc.init()` above (config.yml + base.yml only) ever populates. `index.ts`'s
  // `preBoot()` calls `configSvc.ensureSeeded()` (which calls `loadFromDb()` internally) for the
  // same reason; this bootstrap previously had no caller that needed a DB-backed config value, so it
  // never made the call. `loadFromDb()` alone (not `ensureSeeded()`) is correct here: the destination
  // is required to already be a real, previously-seeded 3.0 install (`migrate.ts`'s own
  // `getSiteById()` check refuses to proceed otherwise), so there is never a "needs seeding" case for
  // this CLI to handle. Its boolean return (`false` means the `settings` table was empty) must not be
  // discarded — same failure `mcp/bootstrap.ts` already guards against for the same call — or
  // `resolveUsersImportContext()` below would silently resolve `undefined` ids from an empty
  // `WIKI.config.auth`, which `createUserGroupImporter()` then treats as "unresolvable" and quietly
  // skips every source-Administrators/-Guests membership rather than erroring.
  if (!(await WIKI.configSvc.loadFromDb())) {
    throw new Error(
      'No settings found in the destination database. The destination must be a previously-booted ' +
        '3.0 install (run the main Wiki.js server against it at least once) before migrating into it.'
    )
  }

  return WIKI
}

/**
 * Resolves the three identifiers the `users` and `content` phases need
 * from the destination install but cannot derive from the 2.x source: this install's local-auth
 * strategy id, its real system Administrators/Guests group ids, and the root admin user id to use as a
 * fallback content author. Called once, after `bootstrapMigrationRuntime()` has returned, by whichever
 * entry point actually builds a `MigrationContext` (`../tasks/migrate.ts`) — `bootstrap.ts` itself has
 * no `MigrationContext` to populate, since it only ever builds the ambient `WIKI` global.
 *
 * `localStrategyId`/`guestsGroupId` are fixed constants every 3.0 install seeds identically from
 * `base.yml`'s `systemIds` (`configSvc.init()` alone is enough to read them — no DB round trip).
 * `rootAdminGroupId`/`rootAdminUserId` are per-install ids `Settings.init()` generated once and
 * persisted under the `auth` settings key (`models/settings.ts`) — reading them requires the
 * `WIKI.configSvc.loadFromDb()` call `bootstrapMigrationRuntime()` now makes. See
 * `importers/users-groups.ts`'s `SystemGroupIds` doc for the full trace of where the admin/guest
 * group ids live at runtime.
 *
 * The target site's primary locale is deliberately NOT resolved here: a value captured before any
 * phase had run would leave the `content`/`assets` phases seeing the destination's PRE-migration
 * locale even after the `settings` phase had changed it. `context.ts#resolvePrimaryLocale()` reads it
 * fresh instead, at the point a phase actually needs it.
 */
export function resolveUsersImportContext(WIKI: WikiGlobal): {
  localStrategyId: string
  systemGroupIds: SystemGroupIds
  operatorActorId: string
} {
  const localStrategyId = WIKI.data.systemIds.localAuthId
  const adminGroupId = WIKI.config.auth?.rootAdminGroupId
  const guestGroupId = WIKI.data.systemIds.guestsGroupId
  const operatorActorId = WIKI.config.auth?.rootAdminUserId

  // `WIKI.config.auth` is typed `any` (assembled at runtime from YAML + jsonb — see
  // `types/global.d.ts`), so a missing/malformed `settings.auth` row would otherwise resolve
  // `undefined` here silently: `createUserGroupImporter()` treats an unresolved `systemGroupIds.admin`/
  // `.guest` as "not created" and quietly skips every membership pointing at the source's
  // Administrators/Guests group, and a `content` phase handed `operatorActorId: undefined` has no
  // working fallback author. `bootstrapMigrationRuntime()`'s own `loadFromDb()` check already refuses
  // an empty `settings` table; this is the belt for a *present-but-malformed* one.
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

/** Builds the configured `SourceConnector` (never connected yet — the caller still owns `connect()`/
 * `disconnect()`), shared between `migrate.ts` and `verify-migration.ts` so both open the exact same
 * kind of connection to the exact same source for their respective purposes. */
export function buildSourceConnector(source: ParsedSource): SourceConnector {
  return source.kind === 'postgres'
    ? new PostgresSourceConnector(source.config)
    : new ExportBundleSourceConnector(source.path)
}
