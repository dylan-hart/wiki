'use strict'

/**
 * Preload for `index.test.ts`'s real `node backend` boot (OpenProject #2339 merge fixup).
 *
 * `index.ts` calls `Temporal.Now.instant()` unconditionally while building the `WIKI` global --
 * correct for the real app, since `engines` requires Node >=26 and that release line ships `Temporal`
 * as a real, unflagged native global (see `docs/variances.md`'s `@js-temporal/polyfill` entry). It
 * installs no polyfill of its own on that real boot path, by design.
 *
 * The spawned child process this preloads for is not that real boot path, though -- it is
 * `index.test.ts`'s own harness, deliberately run under whatever Node happens to be on the sandbox's
 * PATH (paired with `spoofSupportedNodeVersion.cjs`, which stands in for the version gate the same
 * way). On a sandbox below the Node 26 floor, `Temporal` is genuinely absent and the spawned process
 * crashes before ever reaching the db-init failure this test exists to exercise. This installs the
 * real `@js-temporal/polyfill` implementation, feature-detected so it is a no-op on an already-Node-26
 * host (CI, production) -- the same feature-detection `test/temporal.ts#ensureTemporal()` uses for
 * this file's own in-process tests, mirrored here because that helper is an ESM module and this is a
 * synchronous `--require` preload for a separate spawned process.
 */
if (typeof Temporal === 'undefined') {
  const polyfill = require('@js-temporal/polyfill')
  globalThis.Temporal = polyfill.Temporal
  Date.prototype.toTemporalInstant = function () {
    return polyfill.toTemporalInstant.call(this)
  }
}
