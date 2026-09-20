import { beforeEach, vi } from 'vitest'
import { config } from '@vue/test-utils'
import mitt from 'mitt'

import BlueprintIcon from '@/components/BlueprintIcon.vue'
import LoadingGeneric from '@/components/LoadingGeneric.vue'
import StatusLight from '@/components/StatusLight.vue'
import { sharedComponents } from '@/components/shared'

import { createApiClientStub } from './mocks.js'
import { ledgerTokenCss } from './tokens.js'

/*
  Component stylesheets read their colours, radii and shadows through custom properties, and
  neither `happy-dom` nor the real Chromium these suites drive builds `css/tailwind.css` -- without
  the properties declared somewhere, every `var()` computes to nothing and a `.body--dark` override
  written with one silently stops overriding, so a suite comparing light against dark reads the
  same value twice and passes or fails for the wrong reason.

  Ledger is the default aesthetic; a suite asserting Cobalt's own value reads it with
  `tokenValue(name, 'cobalt')` rather than swapping what is installed here.
*/
const tokenStyle = document.createElement('style')
tokenStyle.id = 'design-tokens'
tokenStyle.textContent = ledgerTokenCss()
document.head.appendChild(tokenStyle)

/**
 * Eager, unlike `src/boot/temporal.js`'s lazy polyfill, since a test can reach `stores/user.js`'s
 * date formatting before the boot check would fire.
 *
 * The `/global` entry point, not the plain `temporal-polyfill` export: it also patches
 * `Intl.DateTimeFormat` to accept Temporal types, which `stores/user.js`'s hoisted formatters
 * call, so a test is not left with a Temporal that formats but cannot be formatted.
 */
if (typeof Temporal === 'undefined') {
  await import('temporal-polyfill/global')
}

/*
  The same `sharedComponents` map `boot/components.js` registers in the real app, so a mounted
  component resolves `<w-icon>` / `<w-btn>` / ... exactly as it does at runtime, with no per-test
  import list to keep in sync as components are added.
*/
config.global.components = { ...config.global.components, ...sharedComponents }

/*
  The three more globals `boot/components.js` registers alongside that library, so no suite needs
  to register or stub them itself.
*/
config.global.components.BlueprintIcon = BlueprintIcon
config.global.components.LoadingGeneric = LoadingGeneric
config.global.components.StatusLight = StatusLight

/*
  `API_CLIENT` and `EVENT_BUS` are read as bare globals outside `boot/*`, so a component or store
  reaching one without this throws `ReferenceError` rather than a useful failure.

  Rebuilt before EVERY test rather than once per file: mock call history and `mitt` listeners would
  otherwise leak into the next test in the same file.
*/
beforeEach(() => {
  globalThis.API_CLIENT = createApiClientStub()
  globalThis.EVENT_BUS = mitt()
  // happy-dom's `Window.prototype.localStorage` is a getter-only accessor, as a real browser's is,
  // so a plain assignment throws; `defineProperty` redefines the property outright instead.
  Object.defineProperty(globalThis, 'localStorage', {
    value: createLocalStorageStub(),
    writable: true,
    configurable: true
  })
  // Ignores `contextId`: a `'webgl'` request gets the 2D stub too.
  HTMLCanvasElement.prototype.getContext = createCanvasContext2dStub
})

/**
 * happy-dom implements no 2D canvas backend, so `getContext` answers `null` and `Graph.vue` fails
 * at `ctx.scale()` and falls silently into its own `try/catch` instead of exercising its
 * simulation and draw paths. This covers exactly the methods and settable properties it calls.
 */
function createCanvasContext2dStub() {
  const ctx = {
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
    strokeText: vi.fn(),
    // -> `drawLabels()` truncates a node's title to fit its circle, so `measureText` has to
    //    respond to the font size just set -- a constant would make every title fit, or none.
    //    happy-dom has no text metrics, so this approximates a proportional face at ~0.6em average
    //    advance; a suite asserting which characters survive overrides it.
    measureText: vi.fn((text) => ({
      width: String(text).length * (Number.parseFloat(ctx.font) || 10) * 0.6
    })),
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    fillStyle: '',
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic'
  }
  return ctx
}

/**
 * Node defines a `localStorage` global of its own, but without `--localstorage-file` its methods
 * are missing entirely -- `typeof localStorage === 'object'` yet `getItem` is `undefined`, so
 * `stores/common.js`'s `state()` throws at store-creation time, before a single assertion runs.
 * happy-dom does not paper over it: its global-population step skips any key already on the Node
 * global, and this one already is.
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
