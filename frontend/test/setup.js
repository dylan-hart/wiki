import { beforeEach } from 'vitest'
import { config } from '@vue/test-utils'
import mitt from 'mitt'

import { sharedComponents } from '@/components/shared'

import { createApiClientStub } from './mocks.js'

/**
 * `Temporal` is native from Node 26 (this repo's engine requirement) but this sandbox runs Node
 * 25.9, which lacks it -- loaded the same way `src/boot/temporal.js` lazily polyfills it for
 * pre-Temporal Safari, except eagerly here since a test can reach `stores/user.js`'s date formatting
 * before anything else would trigger the boot check. A no-op on a real Node 26 runtime.
 */
if (typeof Temporal === 'undefined') {
  const { Temporal } = await import('temporal-polyfill')
  globalThis.Temporal = Temporal
}

/**
 * Same sandbox-runtime caveat as `Temporal` above, for `localStorage`: Node 25.9 defines it as a
 * global on its own (unlike Node 26, no flag needed), but without `--localstorage-file` its methods
 * are missing entirely -- `typeof localStorage === 'object'` yet `localStorage.getItem` is
 * `undefined`, so `stores/common.js`'s `state()` (read at store-creation time, e.g. by mounting
 * `App.vue`) throws `TypeError: localStorage.getItem is not a function` before a single assertion
 * runs. Vitest's happy-dom environment does not paper over this either: its own global-population
 * step skips any key already present on the Node global, and Node's own already is. A plain
 * in-memory stand-in, installed only when the real API's methods are missing -- a no-op wherever
 * `localStorage` already works (a real Node 26 runtime, or a browser).
 */
if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') {
  const backing = new Map()
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
    clear: () => backing.clear()
  }
}

/*
  The `w-*` library is registered globally in the real app by `boot/components.js`, via the same
  `sharedComponents` map -- so every mounted component here sees `<w-icon>` / `<w-btn>` / ... resolve
  exactly as it does at runtime, with no per-test import list to keep in sync as components are added.
*/
config.global.components = { ...config.global.components, ...sharedComponents }

/*
  `API_CLIENT` and `EVENT_BUS` exist nowhere outside `boot/*` (see `src/boot/api.js`,
  `src/boot/eventbus.js`) -- a component or store importing neither still reads them as bare globals,
  so a test that reaches one without this would throw `ReferenceError`, not a useful failure.

  Rebuilt before EVERY test rather than once per file: `API_CLIENT`'s methods are `vi.fn()`s a test
  configures with `mockReturnValueOnce` / `mockImplementationOnce`, and `EVENT_BUS` is a real `mitt()`
  emitter a test can subscribe to -- both would otherwise leak call history and listeners into the
  next test in the same file.
*/
beforeEach(() => {
  globalThis.API_CLIENT = createApiClientStub()
  globalThis.EVENT_BUS = mitt()
  globalThis.localStorage = createLocalStorageStub()
})

/**
 * Node ships a native `localStorage` global (Node >= 22), backed by a file the process is given no
 * path for under `vitest run` -- every read throws `TypeError: ... getItem is not a function` rather
 * than answering `null` the way a browser's does. `stores/common.js` reads it unguarded at
 * store-creation time (`state: () => ({ locale: localStorage.getItem('locale') ... })`), so any test
 * that instantiates that store hits this before ever reaching its own assertions. Replaced above with
 * a deterministic in-memory stand-in, the same category of runtime global as `API_CLIENT`/`EVENT_BUS`
 * -- just one nothing imports either.
 */
function createLocalStorageStub() {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  }
}
