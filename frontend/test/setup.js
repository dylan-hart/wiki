import { beforeEach, vi } from 'vitest'
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
  // -> Ignores `contextId` and returns the 2D stub for any request, including `'webgl'` -- harmless
  //    today since `Graph.vue` is the only canvas consumer and only ever asks for `'2d'`.
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
 * Node ships a native `localStorage` global (Node >= 22), backed by a file the process is given no
 * path for under `vitest run` -- on this sandbox's Node 25.9 every read throws `TypeError: ...
 * getItem is not a function` rather than answering `null` the way a browser's does; on the repo's
 * declared Node 26 engine the methods work but are backed by an on-disk file, which would leak state
 * between test files instead of giving each one a clean slate. Either way, `stores/common.js` reads
 * it unguarded at store-creation time (`state: () => ({ locale: localStorage.getItem('locale') ...
 * })`), so any test that instantiates that store needs a working, isolated stand-in before it can
 * reach its own assertions. Installed fresh in `beforeEach` above, the same category of runtime
 * global as `API_CLIENT`/`EVENT_BUS` -- just one nothing imports directly.
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
