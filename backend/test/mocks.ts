/**
 * Stand-ins for the `WIKI` global members a model test rarely cares about.
 *
 * `WIKI.cache` and `WIKI.events` exist for cross-request and cross-instance concerns — an in-memory
 * cache flushed on demand, an HA propagation bus — that almost no model-layer test is actually
 * exercising. Reaching for the real `NodeCache`/`Emittery` instances the app boots with would work,
 * but it means a test failure two calls deep in a helper this test never meant to touch, and a cache
 * that quietly survives across tests unless something remembers to flush it.
 *
 * The convention: build the smallest object satisfying the methods the code path under test actually
 * calls, typed loosely (`as WikiGlobal['cache']` / `as WikiGlobal['events']`) rather than pulled from
 * `node-cache` or `emittery`. A test whose model DOES care about a cache hit or an emitted event
 * should assert against the stub directly (e.g. `cache.set.mock.calls`) rather than reach past it —
 * that is what makes it a stub and not a bypass.
 */
import { mock } from 'node:test'

/** A `WIKI.cache`-shaped stub: enough of `NodeCache`'s surface for code that calls `get`/`set`/`has`. */
export function createCacheStub(): any {
  const store = new Map<string, unknown>()
  return {
    get: mock.fn((key: string) => store.get(key)),
    set: mock.fn((key: string, value: unknown) => {
      store.set(key, value)
      return true
    }),
    has: mock.fn((key: string) => store.has(key)),
    del: mock.fn((key: string) => store.delete(key)),
    flushAll: mock.fn(() => store.clear())
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
