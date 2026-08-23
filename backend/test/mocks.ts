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
import { mock } from 'node:test'

/**
 * A `WIKI.cache`-shaped stub: enough of `LRUCache`'s surface for code that calls
 * `get`/`set`/`has`/`delete`/`getRemainingTTL`. Note the real surface, not `node-cache`'s: `delete`
 * rather than `del`, and `set(key, value, { ttl })` with milliseconds rather than a positional
 * seconds argument.
 */
export function createCacheStub(): any {
  const store = new Map<string, unknown>()
  // -> Real expiry timestamps (ms since epoch), not just a stored `ttl` option: `getRemainingTTL`
  //    below needs to answer "how much longer does this key have" for real, since
  //    `models/liveData.ts`'s per-credential rate limiter (OpenProject #1050) reads it to keep a
  //    fixed rate-limit window rather than sliding it forward on every request.
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
