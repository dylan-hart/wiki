'use strict'

/**
 * Preload for `index.test.ts`'s real `node backend` boot (OpenProject #2048).
 *
 * `index.ts` refuses to start below Node 26 (`semver.satisfies(process.version, '>=26')`), which
 * is correct for the real app but irrelevant to what that test is exercising -- preBoot's db-init
 * error handling, not the version gate -- and would otherwise make the test's assertions depend on
 * which Node happens to be on the PATH. `process.version`'s descriptor is `configurable: true`, so
 * a `--require` preload (this file) can stand it up as a supported version before `index.ts` ever
 * reads it. A no-op on an already->=26 host (CI, production): the spoofed value is itself a real,
 * supported version string.
 */
Object.defineProperty(process, 'version', {
  value: 'v26.0.0',
  configurable: true,
  enumerable: true
})
