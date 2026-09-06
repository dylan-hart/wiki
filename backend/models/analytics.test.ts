import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import path from 'node:path'

/**
 * Coverage for Task 592: analytics module discovery.
 *
 * `models/analytics.ts` mirrors `models/authentication.ts`'s directory-scan pattern — readdir
 * `modules/analytics`, parse each `definition.yml`, run its `props` through
 * `helpers/moduleProps.ts#parseModuleProps` — but has no db table behind it, since a provider's
 * enabled/config state lives directly in each site's `config.analytics.providers` rather than being
 * shared instance-wide the way an auth strategy is.
 *
 * Trimmed by OpenProject #2690 (`docs/testing-audit/backend.md`'s `models/analytics.test.ts` row):
 * the per-module `definition.yml`-declares-its-own-props assertions and the discovery/sort checks
 * were deleted — nothing gates them, and nothing user-facing is lost, since an admin filling the
 * config form would see a missing prop immediately. What survives is the one real branch: a failed
 * scan must still leave `WIKI.data.analytics` an array, not `undefined`.
 */

let analyticsModel: typeof import('./analytics.ts').analytics

before(async () => {
  ;(globalThis as any).WIKI = {
    SERVERPATH: path.join(import.meta.dirname, '..'),
    data: {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    }
  }
  ;({ analytics: analyticsModel } = await import('./analytics.ts'))
})

after(() => {
  delete (globalThis as any).WIKI
})

/**
 * A failed scan must still leave `WIKI.data.analytics` an array: `base.yml` declares no `analytics`
 * key, so the field only exists because `refreshFromDisk()` put it there — the same invariant
 * `models/authentication.test.ts` locks down for its own `WIKI.data.authentication` readers.
 */
test('a scan that fails leaves WIKI.data.analytics an empty array rather than undefined', async () => {
  const previousServerPath = (globalThis as any).WIKI.SERVERPATH
  // -> A directory that does not exist: `readdir` rejects before a single definition is read.
  ;(globalThis as any).WIKI.SERVERPATH = path.join(import.meta.dirname, '..', '__no-such-dir__')
  ;(globalThis as any).WIKI.data = {}
  try {
    await analyticsModel.refreshFromDisk()
    assert.deepEqual(WIKI.data.analytics, [])
    assert.deepEqual(analyticsModel.getModules(), [])
  } finally {
    ;(globalThis as any).WIKI.SERVERPATH = previousServerPath
    ;(globalThis as any).WIKI.data = {}
  }
})
