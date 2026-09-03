import { beforeEach, vi } from 'vitest'
import { config } from '@vue/test-utils'
import mitt from 'mitt'

import BlueprintIcon from '@/components/BlueprintIcon.vue'
import LoadingGeneric from '@/components/LoadingGeneric.vue'
import StatusLight from '@/components/StatusLight.vue'
import { sharedComponents } from '@/components/shared'

import { createApiClientStub } from './mocks.js'

/**
 * `Temporal` is native from Node 26 (this repo's engine requirement) but this sandbox runs Node
 * 25.9, which lacks it -- loaded the same way `src/boot/temporal.js` lazily polyfills it for
 * pre-Temporal Safari, except eagerly here since a test can reach `stores/user.js`'s date formatting
 * before anything else would trigger the boot check. A no-op on a real Node 26 runtime.
 *
 * The `/global` entry point, not the plain `temporal-polyfill` export: it also patches
 * `Intl.DateTimeFormat` to accept Temporal types (`Intl.DateTimeFormat.prototype.format(zoned.
 * toPlainDateTime())`, what `stores/user.js`'s hoisted formatters call) -- exactly what
 * `src/boot/temporal.js` loads in the real app, so a test sees the same runtime shape production
 * does rather than a Temporal that formats but can't be formatted.
 */
if (typeof Temporal === 'undefined') {
  await import('temporal-polyfill/global')
}

/*
  The `w-*` library is registered globally in the real app by `boot/components.js`, via the same
  `sharedComponents` map -- so every mounted component here sees `<w-icon>` / `<w-btn>` / ... resolve
  exactly as it does at runtime, with no per-test import list to keep in sync as components are added.
*/
config.global.components = { ...config.global.components, ...sharedComponents }

/*
  `boot/components.js` registers three more globals alongside that library, and they were reached for
  under test the same inconsistent way: 12 suites registered the real `BlueprintIcon` through
  `global.components`, 7 replaced it with `stubs: { BlueprintIcon: true }`, and `AdminLayout.test.js`
  registered `StatusLight` by hand -- so the same component rendered two different ways depending on
  which file you were reading, and `AdminGeneral.test.js:50` carried a comment explaining that its
  per-file registration existed only to reproduce the app's global one. Registering all three here,
  from the same imports `boot/components.js` uses, makes a mounted component see exactly what the app
  renders with nothing to opt into; the assertions that had been written against the
  `<blueprint-icon-stub />` placeholder read the real avatar markup instead.
*/
config.global.components.BlueprintIcon = BlueprintIcon
config.global.components.LoadingGeneric = LoadingGeneric
config.global.components.StatusLight = StatusLight

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
  // Ignores `contextId` and always returns the 2D stub below, including for a `'webgl'` request --
  // harmless today since `Graph.vue` is the only component under test that touches a canvas at all.
  HTMLCanvasElement.prototype.getContext = createCanvasContext2dStub
})

/**
 * happy-dom's `HTMLCanvasElement.prototype.getContext` returns `null` by default -- no 2D canvas
 * backend is implemented. `Graph.vue`'s (`src/pages/Graph.vue`) `sizeCanvas()`/`redraw()`/
 * `drawEdges()`/`drawClusterHulls()`/`drawNodes()`/`drawLabels()` call a fixed set of 2D context
 * methods and settable properties; this stub is a minimal no-op object covering exactly that set, so
 * mounting `Graph.vue` under test exercises its simulation/draw code paths instead of failing at
 * `ctx.scale()` on a `null` context and silently falling into the component's own `try/catch`.
 * Rebuilt before every test, same rationale as `API_CLIENT`/`EVENT_BUS` above -- `vi.fn()` call
 * history shouldn't leak between tests in the same file. `getContext` itself is a plain function
 * (not a `vi.fn()`) since no test here needs to assert on how it was called, only on what it returns.
 */
function createCanvasContext2dStub() {
  return {
    scale: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    translate: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
    strokeStyle: '',
    lineWidth: 1,
    fillStyle: '',
    globalAlpha: 1,
    font: ''
  }
}

/**
 * Node defines `localStorage` as a global on its own (Node >= 22, no flag needed under this
 * sandbox's Node 25.9), but without `--localstorage-file` its methods are missing entirely --
 * `typeof localStorage === 'object'` yet `localStorage.getItem` is `undefined`, so
 * `stores/common.js`'s `state()` (read at store-creation time, e.g. by mounting `App.vue`) throws
 * `TypeError: localStorage.getItem is not a function` before a single assertion runs. Vitest's
 * happy-dom environment does not paper over this either: its own global-population step skips any
 * key already present on the Node global, and Node's own already is. Installed unconditionally in
 * `beforeEach` above -- overwriting Node's broken global every time, the same category of runtime
 * stand-in as `API_CLIENT`/`EVENT_BUS`, just one nothing imports either. Rebuilt before every test so
 * a write in one test can't leak into the next.
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
