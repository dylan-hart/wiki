/**
 * Stand-ins for the `WIKI` global members a model test rarely cares about.
 *
 * `WIKI.cache` and `WIKI.events` exist for cross-request and cross-instance concerns — an in-memory
 * cache flushed on demand, an HA propagation bus — that almost no model-layer test is actually
 * exercising. Reaching for the real `LRUCache`/`Emittery` instances the app boots with would work,
 * but it means a test failure two calls deep in a helper this test never meant to touch, and a cache
 * that quietly survives across tests unless something remembers to flush it.
 *
 * The convention: build the smallest object satisfying the methods the code path under test actually
 * calls, typed loosely (`as WikiGlobal['cache']` / `as WikiGlobal['events']`) rather than pulled from
 * `lru-cache` or `emittery`. A test whose model DOES care about a cache hit or an emitted event
 * should assert against the stub directly (e.g. `cache.set.mock.calls`) rather than reach past it —
 * that is what makes it a stub and not a bypass.
 */
import path from 'node:path'
import { mock } from 'node:test'
import { isPlainObject } from 'es-toolkit/predicate'

/**
 * A `WIKI.cache`-shaped stub: enough of `LRUCache`'s surface for code that calls
 * `get`/`set`/`has`/`delete`/`getRemainingTTL`. Note the real surface, not `node-cache`'s: `delete`
 * rather than `del`, and `set(key, value, { ttl })` with milliseconds rather than a positional
 * seconds argument.
 */
export function createCacheStub(): any {
  const store = new Map<string, unknown>()
  // -> Real expiry timestamps (ms since epoch), not just a stored `ttl` option: `getRemainingTTL`
  //    below needs to answer "how much longer does this key have" for real, for any caller that reads
  //    it to keep a fixed window rather than sliding it forward on every request (the rate-limit
  //    counter this once backed has since moved to `WIKI.models.rateLimits.consume` — OpenProject
  //    #1700 — but the surface stays faithful for whatever else calls it).
  const expiresAt = new Map<string, number>()
  return {
    get: mock.fn((key: string) => store.get(key)),
    set: mock.fn((key: string, value: unknown, options?: { ttl?: number }) => {
      store.set(key, value)
      if (options?.ttl) {
        expiresAt.set(key, Date.now() + options.ttl)
      } else {
        expiresAt.delete(key)
      }
    }),
    has: mock.fn((key: string) => store.has(key)),
    delete: mock.fn((key: string) => store.delete(key)),
    getRemainingTTL: mock.fn((key: string) => {
      if (!store.has(key)) {
        return 0
      }
      const expiry = expiresAt.get(key)
      return expiry ? Math.max(0, expiry - Date.now()) : 0
    }),
    clear: mock.fn(() => {
      store.clear()
      expiresAt.clear()
    })
  }
}

/** A `WIKI.events`-shaped stub: both buses present, every call a no-op that a test can assert on. */
export function createEventsStub(): any {
  const bus = () => ({
    emit: mock.fn(),
    on: mock.fn(),
    onAny: mock.fn(),
    offAny: mock.fn(),
    clearListeners: mock.fn()
  })
  return { inbound: bus(), outbound: bus() }
}

/**
 * A `WIKI.scheduler`-shaped stub: just `addJob`, recording every call rather than touching the real
 * job queue or worker pool. Enough for model-layer code that queues work (`pages.ts#notifyWatchers`,
 * for one) without a model test having to stand up the scheduler's thread pool and pubsub connection.
 */
export function createSchedulerStub(): any {
  return {
    addJob: mock.fn(async () => ({ id: 'test-job' }))
  }
}

/**
 * A `WIKI.models.groups.checkSiteAdminAccess`-shaped stub, composed from a suite's OWN
 * `actorForRequest` and `checkSiteAccess` stubs exactly as the real method composes the real pair
 * (`models/groups.ts`): the global permission, site-blind, OR the delegated `site:*` one.
 *
 * Five route suites (`api/approvals`, `api/blockCredentials`, `api/blocks`, `api/navigation`,
 * `api/sites`) drive a site-scoped admin gate through their routes and each already stubs those two
 * pieces off its own `x-test-permissions` / `x-test-site-permissions` headers. Composing here rather
 * than in each of them keeps the one thing that must not drift — WHICH of the two answers wins, and
 * in which order — single-sourced against the real method, while leaving each suite's own grant
 * semantics exactly where they were.
 *
 * @param actorForRequest The suite's own `WIKI.models.groups.actorForRequest` stand-in
 * @param checkSiteAccess The suite's own `WIKI.models.groups.checkSiteAccess` stand-in
 */
export function createSiteAdminAccessStub(
  actorForRequest: (req: any) => { permissions: string[] },
  checkSiteAccess: (actor: any, permission: string, siteId: string) => boolean
) {
  return (req: any, globalPermission: string, sitePermission: string, siteId: string): boolean => {
    const actor = actorForRequest(req)
    return (
      actor.permissions.includes(globalPermission) || checkSiteAccess(actor, sitePermission, siteId)
    )
  }
}

/**
 * `error`/`warn`/`info`/`debug`/`verbose`/`silly`, all no-ops — a test run should not scroll past the
 * logging of the code it is exercising.
 *
 * Exported (TEST-F1) rather than re-inlined per file: 70 backend test files used to carry their own
 * partial literal (`{ debug }`, `{ warn }`, `{ info, warn, error, debug }`, …), so adding one
 * `WIKI.logger.info()` call to a route broke every suite whose stub happened to omit `info` — and
 * failed naming the logger rather than the change.
 */
export function createSilentLogger(): any {
  const noop = () => {}
  return { error: noop, warn: noop, info: noop, debug: noop, verbose: noop, silly: noop }
}

/**
 * Deep-merge `source` into `target`, in place.
 *
 * Recurses only where BOTH sides are plain objects; everything else (arrays, class instances, mock
 * functions, `null`) replaces wholesale. Deliberately narrower than `es-toolkit`'s `toMerged`, which
 * deep-CLONES its target and merges arrays index-wise — neither is wanted here, since an override may
 * legitimately carry a live Drizzle instance, a `mock.fn()` whose call history a test asserts on, or
 * an array meant to stand alone rather than be spliced over a default.
 *
 * Copies property DESCRIPTORS, not values: a suite whose stub declares a getter so a module-level
 * variable can steer what a route sees per test (`api/pages.test.ts`'s `get sites()`, which flips
 * `features.collaborativeEditing`) would otherwise have that getter invoked once here and frozen
 * into a snapshot.
 */
function mergeInto(target: any, source: Record<string, any>): any {
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(source))) {
    if (!('value' in descriptor)) {
      Object.defineProperty(target, key, descriptor)
      continue
    }
    if (isPlainObject(descriptor.value) && isPlainObject(target[key])) {
      mergeInto(target[key], descriptor.value)
    } else {
      target[key] = descriptor.value
    }
  }
  return target
}

/**
 * The `WIKI` global a test needs, with every member a test rarely cares about already stubbed.
 *
 * Defaults: a silent logger, the `cache`/`events`/`scheduler` stubs above, and `{}` for `config`,
 * `sites`, `sitesMappings` and `models`. `models` is deliberately EMPTY rather than a populated set —
 * `modules/storage/disk/storage.test.ts` relies on an absent member throwing to prove the module
 * never reaches for one — so a suite names exactly the model methods its code path calls, and an
 * unexpected reach past them still fails loudly.
 *
 * `data.systemIds` is present but empty, so a read like `WIKI.data.systemIds.guestsGroupId` answers
 * `undefined` instead of throwing on `undefined.guestsGroupId`; a suite whose code path actually
 * branches on one of those ids supplies it (the real values live in `base.yml`).
 *
 * Overrides are deep-merged (see `mergeInto`), so `{ models: { pages: { … } } }` keeps the logger and
 * the stubs while replacing only what it names.
 */
export function createWikiStub(overrides: Record<string, any> = {}): WikiGlobal {
  const stub = {
    IS_DEBUG: false,
    ROOTPATH: process.cwd(),
    // -> Derived from this file's own location (`backend/test/mocks.ts`), not `process.cwd()`: a
    //    workspace's tests run with `backend/` as the cwd already, so `path.join(cwd, 'backend')`
    //    would point at a `backend/backend` that does not exist. Anything doing disk-based module
    //    loading (`models/search.ts#hasImplementation()`, a module's `definition.yml`) reads this.
    SERVERPATH: path.join(import.meta.dirname, '..'),
    INSTANCE_ID: 'test',
    // -> Not `Temporal.Now.instant()`: nothing under test reads `startedAt`, and this file otherwise
    //    has no reason to depend on the runtime actually having `Temporal` installed.
    startedAt: new Date(),
    version: 'test',
    releaseDate: 'test',
    devMode: true,
    auth: { groups: {}, strategies: {} },
    config: {},
    data: { systemIds: {} },
    logger: createSilentLogger(),
    cache: createCacheStub(),
    events: createEventsStub(),
    scheduler: createSchedulerStub(),
    sites: {},
    sitesMappings: {},
    models: {}
  }
  return mergeInto(stub, overrides) as unknown as WikiGlobal
}

/**
 * Install `createWikiStub(overrides)` as the `WIKI` global, returning the handle that puts back
 * whatever was there before.
 *
 * Always restore in `after()`/`afterEach()`: `node --test` isolates each matched FILE into its own
 * process, but not each suite within one, so a file that installs a global and walks away leaves it
 * standing for whatever runs next in the same file (see OpenProject #1021). 41 files used to
 * hand-roll the same `previousWiki` capture/assign dance around this.
 */
export function installTestWiki(overrides: Record<string, any> = {}): { restore(): void } {
  const had = 'WIKI' in globalThis
  const previous = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = createWikiStub(overrides)
  return {
    restore() {
      if (had) {
        ;(globalThis as any).WIKI = previous
      } else {
        delete (globalThis as any).WIKI
      }
    }
  }
}
