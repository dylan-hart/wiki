import { afterEach, describe, expect, it } from 'vitest'

import { DarkMode, isDark, watchTheme } from './theme.js'

/**
 * OpenProject #1968 / testing.md §6: `theme.js` is imported by 21 of the 26 blocks and is the module
 * CLAUDE.md makes mandatory (`:host-context()` silently never matches outside Chromium), yet before
 * this it was exercised only as a side effect of the 11 block suites that happen to assert on dark
 * mode. This pins `watchTheme`'s shared-observer lifecycle and the `DarkMode` controller directly,
 * against a minimal stand-in for Lit's `ReactiveElement` rather than a real block.
 */

/** Resolves after the `MutationObserver` callback's microtask has run. */
function tick() {
  return new Promise((resolve) => queueMicrotask(resolve))
}

/**
 * The minimal subset of `ReactiveElement` `DarkMode` actually touches: `addController` (called once,
 * synchronously, from the constructor), `toggleAttribute`, and `requestUpdate`. Not a real Lit
 * element -- `hostConnected`/`hostDisconnected` are invoked directly by the tests, the way Lit itself
 * would from the real element's `connectedCallback`/`disconnectedCallback`.
 */
function makeHost() {
  const attributes = new Set()
  return {
    controller: null,
    requestUpdateCalls: 0,
    addController(controller) {
      this.controller = controller
    },
    toggleAttribute(name, force) {
      if (force) {
        attributes.add(name)
      } else {
        attributes.delete(name)
      }
    },
    hasAttribute(name) {
      return attributes.has(name)
    },
    requestUpdate() {
      this.requestUpdateCalls += 1
    }
  }
}

afterEach(() => {
  document.body.classList.remove('body--dark')
})

describe('isDark()', () => {
  it('reflects the body--dark class', () => {
    expect(isDark()).toBe(false)
    document.body.classList.add('body--dark')
    expect(isDark()).toBe(true)
  })
})

describe('watchTheme()', () => {
  it('delivers a single class toggle to every current subscriber', async () => {
    const callsA = []
    const callsB = []
    const unwatchA = watchTheme((dark) => callsA.push(dark))
    const unwatchB = watchTheme((dark) => callsB.push(dark))

    document.body.classList.add('body--dark')
    await tick()

    expect(callsA).toEqual([true])
    expect(callsB).toEqual([true])

    unwatchA()
    unwatchB()
  })

  it('unsubscribing one watcher leaves the other one live', async () => {
    const callsA = []
    const callsB = []
    const unwatchA = watchTheme((dark) => callsA.push(dark))
    const unwatchB = watchTheme((dark) => callsB.push(dark))

    unwatchA()
    document.body.classList.add('body--dark')
    await tick()

    expect(callsA).toEqual([])
    expect(callsB).toEqual([true])

    unwatchB()
  })

  it('unsubscribing the last watcher stops delivery entirely', async () => {
    const calls = []
    const unwatch = watchTheme((dark) => calls.push(dark))
    unwatch()

    document.body.classList.add('body--dark')
    await tick()

    expect(calls).toEqual([])
  })

  it('delivers again once a new watcher subscribes after everything unsubscribed', async () => {
    const first = watchTheme(() => {})
    first()

    const calls = []
    const unwatch = watchTheme((dark) => calls.push(dark))
    document.body.classList.add('body--dark')
    await tick()

    expect(calls).toEqual([true])
    unwatch()
  })
})

describe('DarkMode controller', () => {
  it('applies the current theme synchronously in hostConnected, not waiting for a mutation', () => {
    document.body.classList.add('body--dark')
    const host = makeHost()
    const darkMode = new DarkMode(host)

    // -> Constructed but not yet connected: nothing should have been written to the host yet.
    expect(host.hasAttribute('dark')).toBe(false)

    host.controller.hostConnected()

    expect(host.hasAttribute('dark')).toBe(true)
    expect(darkMode.isDark).toBe(true)

    host.controller.hostDisconnected()
  })

  it('reacts to a later theme change while connected', async () => {
    const host = makeHost()
    const darkMode = new DarkMode(host)
    host.controller.hostConnected()
    expect(host.hasAttribute('dark')).toBe(false)

    document.body.classList.add('body--dark')
    await tick()

    expect(host.hasAttribute('dark')).toBe(true)
    expect(darkMode.isDark).toBe(true)

    host.controller.hostDisconnected()
  })

  it('stops reacting once disconnected', async () => {
    const host = makeHost()
    new DarkMode(host)
    host.controller.hostConnected()
    host.controller.hostDisconnected()

    document.body.classList.add('body--dark')
    await tick()

    expect(host.hasAttribute('dark')).toBe(false)
  })

  it('attribute:false tracks .isDark without ever touching the host attribute', async () => {
    const host = makeHost()
    const darkMode = new DarkMode(host, { attribute: false })
    host.controller.hostConnected()

    document.body.classList.add('body--dark')
    await tick()

    expect(darkMode.isDark).toBe(true)
    expect(host.hasAttribute('dark')).toBe(false)

    host.controller.hostDisconnected()
  })

  it('calls onChange with the new value after requestUpdate(), on every change including the initial apply', () => {
    const order = []
    const host = makeHost()
    host.requestUpdate = () => order.push('requestUpdate')
    const darkMode = new DarkMode(host, { onChange: (dark) => order.push(['onChange', dark]) })

    host.controller.hostConnected()

    expect(order).toEqual(['requestUpdate', ['onChange', darkMode.isDark]])

    host.controller.hostDisconnected()
  })
})
