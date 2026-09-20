/**
 * Reaching for the real `LRUCache`/`Emittery` instances the app boots with would work, but it means
 * a failure two calls deep in a helper the test never meant to touch, and a cache that quietly
 * survives across tests. A test that DOES care about a cache hit or an emitted event asserts against
 * the stub (`cache.set.mock.calls`) rather than reaching past it.
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
  // -> Real expiry timestamps, not just the stored `ttl`: `getRemainingTTL` has to answer how much
  //    longer a key has, for a caller keeping a fixed window rather than sliding it per request.
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

export function createServerStub(): any {
  return {
    isReady: mock.fn(() => true)
  }
}

/**
 * Mirrors how `models/groups.ts#checkSiteAdminAccess` composes the real pair — the global
 * permission, site-blind, OR the delegated `site:*` one — so which of the two answers wins, and in
 * which order, cannot drift from the real method while each route suite keeps its own grant
 * semantics.
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
 * Every level `core/logger.ts` implements and no more, so a call site reintroducing a name it never
 * had throws here rather than in production. A suite that wants to ASSERT on a line replaces the
 * level it cares about (`CARDINAL.logger.warn = mock.fn()`) and asserts on the scope and the fields,
 * never on a rendered string — the rendering is `core/logger.ts`'s business.
 */
export function createSilentLogger(): any {
  const noop = () => {}
  const stub: any = { error: noop, warn: noop, info: noop, debug: noop }
  stub.scope = () => stub
  return stub
}

/**
 * Deliberately narrower than `es-toolkit`'s `toMerged`, which deep-CLONES its target and merges
 * arrays index-wise: an override may legitimately carry a live Drizzle instance, a `mock.fn()` whose
 * call history a test asserts on, or an array meant to stand alone rather than be spliced over a
 * default.
 *
 * Copies property DESCRIPTORS, not values, so a stub's getter — declared to steer what a route sees
 * per test — is not invoked once here and frozen into a snapshot.
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
 * `models` is deliberately EMPTY: an absent member throwing is coverage that a code path never
 * reaches for a model it should not, so a suite names exactly the methods it calls. `data.systemIds`
 * is present but empty so a read answers `undefined` rather than throwing on `undefined.x`; a suite
 * branching on one of those ids supplies it (the real values live in `base.yml`).
 *
 * Overrides are deep-merged, so a test asserting on a nested override must read `CARDINAL.events`
 * rather than the object literal it passed in.
 */
export function createWikiStub(overrides: Record<string, any> = {}): CardinalGlobal {
  const stub = {
    IS_DEBUG: false,
    ROOTPATH: process.cwd(),
    // -> Not `process.cwd()`: tests already run with `backend/` as the cwd, so joining `backend`
    //    onto it would point at a `backend/backend` that does not exist.
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
