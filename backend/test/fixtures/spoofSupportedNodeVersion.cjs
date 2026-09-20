'use strict'

/**
 * `--require` preload for `index.test.ts`'s spawned `node backend` boot: `index.ts` refuses to
 * start below Node 26, which would make that test's assertions depend on whichever Node is on the
 * PATH rather than on the db-init error handling it exercises. `process.version`'s descriptor is
 * `configurable: true`, so it can be stood up before `index.ts` reads it; the spoofed value is a
 * real supported version, so this is a no-op on CI and production.
 */
Object.defineProperty(process, 'version', {
  value: 'v26.0.0',
  configurable: true,
  enumerable: true
})
