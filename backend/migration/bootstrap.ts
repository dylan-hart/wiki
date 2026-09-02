/**
 * Shared boot sequence for every standalone migration-CLI entry point under `../tasks/` —
 * `migrate.ts` (the import) and `verify-migration.ts` (Feature 421 task 748's post-import
 * verification). Both need the exact same minimal runtime and nothing else: modeled on `worker.ts`'s
 * minimal `WIKI` global, not `index.ts`'s full boot — no HTTP server, no scheduler, no real cache
 * backend, no collab websockets, just enough to talk to the 3.0 destination database and run the
 * model methods each script needs. `WIKI.events`/`WIKI.cache` are still populated, with no-op stubs
 * (see `createEventsStub()`/`createCacheStub()` below) rather than left undefined, because the
 * models this bootstrap loads unconditionally reach for both on their normal write paths.
 *
 * Extracted out of `migrate.ts` (which originally inlined this) so `verify-migration.ts` does not
 * have to duplicate it — see task 748's own description, "sharing the harness's bootstrap".
 */

import path from 'node:path'
import configSvc from '../core/config.ts'
import dbManager from '../core/db.ts'
import logger from '../core/logger.ts'
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
 * - `locales`, `rendering`, `search`, `hooks`, `flags`, `classificationLevels` — reached
 *   transitively via `WIKI.models.pages.createPage()` (`models/pages.ts:681,688,697,728,766,825,
 *   918,919,927`), the only page write path an importer calls today.
 * - `navigation` — called directly by `phases/content.ts` (`WIKI.models.navigation.ensureSiteNav`
 *   et al.).
 * - `security` — called directly by `phases/settings.ts`: the settings phase's
 *   `security`-keyed instance-settings patch goes through the real `WIKI.models.security.updateConfig()`
 *   (the same merge-then-`saveToDb()` path `api/system.ts` uses), not a raw
 *   `WIKI.models.settings.updateConfig('security', ...)` — the latter is a wholesale JSONB replace
 *   that would silently delete every 3.0-only `security` field the 2.x mapper's patch doesn't produce.
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
