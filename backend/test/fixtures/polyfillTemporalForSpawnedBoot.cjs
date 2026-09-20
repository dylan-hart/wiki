'use strict'

/**
 * `--require` preload for `index.test.ts`'s spawned `node backend` boot, which deliberately runs
 * under whatever Node is on the sandbox's PATH. Below the Node 26 floor `Temporal` is genuinely
 * absent and `index.ts` crashes building `CARDINAL`, long before the db-init failure that test
 * exercises. Feature-detected, so it is a no-op on CI and production.
 *
 * A synchronous `require` of the ESM-only `temporal-polyfill` works because Node's `require()` can
 * load a synchronous ES module directly since Node 22; `/global` installs the global itself.
 */
if (typeof Temporal === 'undefined') {
  require('temporal-polyfill/global')
}
