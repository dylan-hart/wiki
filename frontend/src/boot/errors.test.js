import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'

import { mountWithApp } from '../../test/mount.js'

import mainSource from '../main.js?raw'
import { initializeErrors } from './errors.js'

/*
  Spies the console rather than mocking `helpers/log`: what this file promises is a specific LINE,
  prefix and all, so only the console proves the whole chain -- handler installed, scope `app`,
  `[cardinal:app]` prefix, error object passed through unstringified.
*/
let errorSpy
let warnSpy
let dispose

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  dispose = null
})

afterEach(() => {
  dispose?.()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/**
 * Installs the handlers into a real Vue app as a plugin, the way `main.js` does, so the error
 * travels Vue's own `handleError` path into `app.config.errorHandler` rather than being
 * hand-invoked.
 *
 * The mount is expected to throw: `@vue/test-utils` collects whatever reached the app's error
 * handler during mount and rethrows the first one afterwards (its workaround for vuejs/core#7020),
 * having already called ours. That rethrow is the harness's; nothing rethrows in the real app.
 */
function mountThrowing(Component) {
  const boot = {
    install(app) {
      dispose = initializeErrors(app)
    }
  }
  expect(() => mountWithApp(Component, { global: { plugins: [boot] } })).toThrow()
}

const Boom = defineComponent({
  name: 'BoomComponent',
  setup() {
    throw new Error('boom')
  }
})

describe('initializeErrors: Vue errorHandler', () => {
  it('routes an uncaught setup error to one scoped line naming the component and the hook', () => {
    mountThrowing(Boom)

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toBe(
      '[cardinal:app] uncaught in BoomComponent during setup function'
    )
  })

  it('passes the error object through rather than its message, so the browser keeps the stack', () => {
    mountThrowing(Boom)

    const err = errorSpy.mock.calls[0][1]
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('boom')
  })

  it('routes an error thrown during render, not only during setup', () => {
    const RenderBoom = defineComponent({
      name: 'RenderBoom',
      render() {
        throw new Error('render failed')
      }
    })

    mountThrowing(RenderBoom)

    expect(errorSpy.mock.calls[0][0]).toBe(
      '[cardinal:app] uncaught in RenderBoom during render function'
    )
  })

  it('falls back to "anonymous" for a component with no name of its own', () => {
    const Nameless = {
      setup() {
        throw new Error('boom')
      }
    }

    mountThrowing(Nameless)

    expect(errorSpy.mock.calls[0][0]).toBe(
      '[cardinal:app] uncaught in anonymous during setup function'
    )
  })

  it('reads the compiler-stamped __name a <script setup> component carries instead of a declared name', () => {
    const Compiled = {
      __name: 'PageToc',
      setup() {
        throw new Error('boom')
      }
    }

    mountThrowing(Compiled)

    expect(errorSpy.mock.calls[0][0]).toBe(
      '[cardinal:app] uncaught in PageToc during setup function'
    )
  })
})

describe('initializeErrors: Vue warnHandler', () => {
  it('routes a Vue dev warning through the helper under the same prefix', () => {
    const app = { config: {} }
    dispose = initializeErrors(app)

    app.config.warnHandler('Failed to resolve component: w-nope', null, '')

    // -> One argument, not a trailing `undefined`: the helper drops an absent error
    expect(warnSpy).toHaveBeenCalledWith('[cardinal:app] Failed to resolve component: w-nope')
  })

  it('is left unset in a production build, where Vue emits no warnings to catch', () => {
    vi.stubEnv('DEV', false)
    const app = { config: {} }

    dispose = initializeErrors(app)

    expect(app.config.warnHandler).toBeUndefined()
    // -> The error handler is NOT dev-only: production is where the line is most needed
    expect(typeof app.config.errorHandler).toBe('function')
  })
})

describe('initializeErrors: window listeners', () => {
  it('logs an unhandled promise rejection with its reason', () => {
    dispose = initializeErrors({ config: {} })
    const reason = new Error('nope')

    // -> happy-dom implements no `PromiseRejectionEvent`; the handler reads `ev.reason` and nothing
    //    else, so a plain event carrying one is the same event to this code
    const ev = new Event('unhandledrejection')
    ev.reason = reason
    window.dispatchEvent(ev)

    expect(errorSpy).toHaveBeenCalledWith('[cardinal:app] unhandled promise rejection', reason)
  })

  it('logs a window error event with its own message and error', () => {
    dispose = initializeErrors({ config: {} })
    const error = new TypeError('x is not a function')

    const ev = new Event('error')
    ev.message = 'Uncaught TypeError: x is not a function'
    ev.error = error
    window.dispatchEvent(ev)

    expect(errorSpy).toHaveBeenCalledWith(
      '[cardinal:app] Uncaught TypeError: x is not a function',
      error
    )
  })

  it("does not suppress the browser's own console entry", () => {
    dispose = initializeErrors({ config: {} })

    const ev = new Event('unhandledrejection', { cancelable: true })
    ev.reason = new Error('nope')
    window.dispatchEvent(ev)

    // -> `preventDefault()` here would hide the native, source-mapped entry; the scoped line is
    //    meant to sit BESIDE it
    expect(ev.defaultPrevented).toBe(false)
  })

  it('stops logging once the returned teardown has run', () => {
    const stop = initializeErrors({ config: {} })
    stop()

    const ev = new Event('unhandledrejection')
    ev.reason = new Error('nope')
    window.dispatchEvent(ev)

    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('initializeErrors: wiring', () => {
  it('is booted by main.js after the event bus and before the app mounts', () => {
    expect(mainSource).toContain("import { initializeErrors } from './boot/errors'")
    // -> Order is the contract: the handler must be installed before anything it is meant to catch
    //    runs. Read as source rather than imported -- `main.js` boots the whole app on import
    expect(mainSource.indexOf('initializeErrors(app)')).toBeGreaterThan(
      mainSource.indexOf('initializeEventBus()')
    )
    expect(mainSource.indexOf('initializeErrors(app)')).toBeLessThan(
      mainSource.indexOf("app.mount('#app')")
    )
  })
})

describe('initializeErrors: what it deliberately does not do', () => {
  it('makes no network call from any handler', () => {
    dispose = initializeErrors({ config: {} })

    const ev = new Event('unhandledrejection')
    ev.reason = new Error('nope')
    window.dispatchEvent(ev)

    expect(API_CLIENT.post).not.toHaveBeenCalled()
    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })
})
