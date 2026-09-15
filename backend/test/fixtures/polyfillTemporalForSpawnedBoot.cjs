'use strict'

/**
 * Preload for `index.test.ts`'s real `node backend` boot (OpenProject #2339 merge fixup).
 *
 * `index.ts` calls `Temporal.Now.instant()` unconditionally while building the `CARDINAL` global --
 * correct for the real app, since `index.ts` calls `ensureTemporal()` first (see
 * `core/temporal.ts`), which installs `temporal-polyfill`, a real `dependencies` entry, whenever
 * `Temporal` is not already a native global (every official Node 26 build ships it natively; see
 * `core/temporal.ts`'s header). It installs no polyfill of its own on that real boot path, by design.
 *
 * The spawned child process this preloads for is not that real boot path, though -- it is
 * `index.test.ts`'s own harness, deliberately run under whatever Node happens to be on the sandbox's
 * PATH (paired with `spoofSupportedNodeVersion.cjs`, which stands in for the version gate the same
 * way). On a sandbox below the Node 26 floor, `Temporal` is genuinely absent and the spawned process
 * crashes before ever reaching the db-init failure this test exists to exercise. This installs the
 * real `temporal-polyfill` implementation, feature-detected so it is a no-op on an already-Node-26
 * host (CI, production) -- the same feature-detection `test/temporal.ts#ensureTemporal()` uses for
 * this file's own in-process tests, mirrored here because that helper is an ESM module (an `await
 * import(...)`) and this is a synchronous `--require` preload for a separate spawned process.
 * `require('temporal-polyfill/global')` works synchronously here despite the package being ESM-only
 * (`"type": "module"`, no CJS build) because Node's `require()` can load a synchronous ES module
 * directly since Node 22 -- verified against this repo's own Node 26.8.1. `/global`'s import side
 * effect installs `globalThis.Temporal` and patches `Date.prototype.toTemporalInstant` itself, so
 * there is nothing further to wire up here.
 */
if (typeof Temporal === 'undefined') {
  require('temporal-polyfill/global')
}
