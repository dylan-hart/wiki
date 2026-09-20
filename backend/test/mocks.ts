/**
 * Stand-ins for the `CARDINAL` global members a model test rarely cares about. Reaching for the real
 * `LRUCache`/`Emittery` instances the app boots with would work, but it means a failure two calls
 * deep in a helper the test never meant to touch, and a cache that quietly survives across tests.
 * Build the smallest object satisfying the methods the code path under test actually calls; a test
 * that DOES care about a cache hit or an emitted event asserts against the stub
 * (`cache.set.mock.calls`) rather than reaching past it.
 */
import path from 'node:path'
import { mock } from 'node:test'
import { isPlainObject } from 'es-toolkit/predicate'

/**
 * Mirrors `LRUCache`'s surface, not `node-cache`'s: `delete` rather than `del`, and
 * `set(key, value, { ttl })` in milliseconds rather than a positional seconds argument.
 */
export function createCacheStub(): any {
  const store = new Map<string, unknown>()
  // -> Real expiry timestamps (ms since epoch), not just a stored `ttl` option: `getRemainingTTL`
  //    has to answer "how much longer does this key have" for a caller that reads it to keep a fixed
  //    window rather than sliding it forward on every request.
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

export function createSchedulerStub(): any {
  return {
    addJob: mock.fn(async () => ({ id: 'test-job' }))
  }
}

/**
 * A fully booted instance, which is what every route test but one cares about; a suite exercising
 * the `postBoot()`-window readiness gate overrides it with `{ server: { isReady: () => false } }`.
 */
export function createServerStub(): any {
  return {
    isReady: mock.fn(() => true)
  }
}

/**
 * Composed from a suite's OWN `actorForRequest` and `checkSiteAccess` stubs exactly as
 * `models/groups.ts#checkSiteAdminAccess` composes the real pair: the global permission, site-blind,
 * OR the delegated `site:*` one. Composing here keeps the one thing that must not drift — WHICH of
 * the two answers wins, and in which order — single-sourced against the real method, while each
 * route suite keeps its own grant semantics.
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
 * Every level `core/logger.ts` implements, and no more — all no-ops, because a test run should not
 * scroll past the logging of the code it is exercising. `scope()` answers the stub itself rather
 * than a fresh object, so `log.scope('x').scope('y').info(…)` cannot run out of stub.
 *
 * A suite that wants to ASSERT on a line replaces the level it cares about
 * (`CARDINAL.logger.warn = mock.fn()`) and asserts on the scope and the fields, never on a rendered
 * string — the rendering is `core/logger.ts`'s business.
 */
export function createSilentLogger(): any {
  const noop = () => {}
  const stub: any = { error: noop, warn: noop, info: noop, debug: noop }
  stub.scope = () => stub
  return stub
}

/**
 * Recurses only where BOTH sides are plain objects; everything else (arrays, class instances, mock
 * functions, `null`) replaces wholesale. Deliberately narrower than `es-toolkit`'s `toMerged`, which
 * deep-CLONES its target and merges arrays index-wise — neither is wanted here, since an override may
 * legitimately carry a live Drizzle instance, a `mock.fn()` whose call history a test asserts on, or
 * an array meant to stand alone rather than be spliced over a default.
 *
 * Copies property DESCRIPTORS, not values: a suite whose stub declares a getter so a module-level
 * variable can steer what a route sees per test would otherwise have that getter invoked once here
 * and frozen into a snapshot.
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
 * `models` is deliberately EMPTY rather than a populated set — an absent member throwing is coverage
 * (`modules/storage/disk/storage.test.ts` relies on it to prove the module never reaches for a model
 * it should not) — so a suite names exactly the model methods its code path calls.
 *
 * `data.systemIds` is present but empty, so a read like `CARDINAL.data.systemIds.guestsGroupId`
 * answers `undefined` instead of throwing on `undefined.guestsGroupId`; a suite whose code path
 * branches on one of those ids supplies it (the real values live in `base.yml`).
 *
 * Overrides are deep-merged (see `mergeInto`), so a nested `{ events: { … } }` MERGES into the
 * default rather than replacing it — a test asserting on one must read `CARDINAL.events` rather than
 * the object literal it passed in. (Arrays, class instances and `mock.fn()`s replace wholesale.)
 */
export function createWikiStub(overrides: Record<string, any> = {}): CardinalGlobal {
  const stub = {
    IS_DEBUG: false,
    ROOTPATH: process.cwd(),
    // -> Derived from this file's own location, not `process.cwd()`: a workspace's tests run with
    //    `backend/` as the cwd already, so `path.join(cwd, 'backend')` would point at a
    //    `backend/backend` that does not exist. Disk-based module loading
    //    (`models/search.ts#hasImplementation()`, a module's `definition.yml`) reads this.
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
    server: createServerStub(),
    sites: {},
    sitesMappings: {},
    models: {}
  }
  return mergeInto(stub, overrides) as unknown as CardinalGlobal
}

/**
 * Always restore in `after()`/`afterEach()`: `node --test` isolates each matched FILE into its own
 * process, but not each suite within one, so a file that installs a global and walks away leaves it
 * standing for whatever runs next in the same file.
 */
export function installTestWiki(overrides: Record<string, any> = {}): { restore(): void } {
  const had = 'CARDINAL' in globalThis
  const previous = (globalThis as any).CARDINAL
  ;(globalThis as any).CARDINAL = createWikiStub(overrides)
  return {
    restore() {
      if (had) {
        ;(globalThis as any).CARDINAL = previous
      } else {
        delete (globalThis as any).CARDINAL
      }
    }
  }
}
