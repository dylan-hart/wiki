import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DarkMode, isDark, watchTheme } from './theme.js'

/**
 * OpenProject #1968 / testing.md §6: `theme.js` is imported by 21 of the 26 blocks and is the module
 * CLAUDE.md makes mandatory (`:host-context()` silently never matches outside Chromium), yet before
 * this it was exercised only as a side effect of the 11 block suites that happen to assert on dark
 * mode. This pins `watchTheme`'s shared-observer lifecycle and the `DarkMode` controller directly,
 * against a minimal stand-in for Lit's `ReactiveElement` rather than a real block.
 */

/**
 * Minimal stand-in for `import('lit').ReactiveElement`: just enough of the controller-host
 * contract (`addController`, `toggleAttribute`, `requestUpdate`) for `DarkMode` to drive, with no
 * real Lit rendering pipeline behind it.
 */
class FakeHost {
  constructor() {
    this._attrs = new Set()
    this.updateRequests = 0
  }

  addController() {
    // -> DarkMode only needs this to be callable; it keeps no reference back to the controller.
  }

  toggleAttribute(name, force) {
    if (force) {
      this._attrs.add(name)
    } else {
      this._attrs.delete(name)
    }
    return force
  }

  hasAttribute(name) {
    return this._attrs.has(name)
  }

  requestUpdate() {
    this.updateRequests += 1
  }
}

function setDark(dark) {
  document.body.classList.toggle('body--dark', dark)
}

// -> The MutationObserver callback runs as a microtask, same as a real browser.
async function nextTick() {
  await new Promise((resolve) => queueMicrotask(resolve))
}

describe('shared/theme.js: isDark()', () => {
  afterEach(() => {
    document.body.classList.remove('body--dark')
  })

  it('reflects the body--dark class', () => {
    setDark(false)
    expect(isDark()).toBe(false)

    setDark(true)
    expect(isDark()).toBe(true)
  })
})

describe('shared/theme.js: watchTheme()', () => {
  let unwatchers

  beforeEach(() => {
    document.body.classList.remove('body--dark')
    unwatchers = []
  })

  afterEach(() => {
    for (const unwatch of unwatchers) {
      unwatch()
    }
    document.body.classList.remove('body--dark')
  })

  function subscribe(onChange) {
    const unwatch = watchTheme(onChange)
    unwatchers.push(unwatch)
    return unwatch
  }

  it('notifies every subscriber on a single class toggle', async () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribe(a)
    subscribe(b)

    setDark(true)
    await nextTick()

    expect(a).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith(true)
    expect(b).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledWith(true)
  })

  it('leaves the other subscriber live once one unsubscribes', async () => {
    const a = vi.fn()
    const b = vi.fn()
    const unwatchA = subscribe(a)
    subscribe(b)

    unwatchA()
    setDark(true)
    await nextTick()

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledWith(true)
  })

  it('stops delivery once the last subscriber unsubscribes', async () => {
    const a = vi.fn()
    const unwatch = subscribe(a)

    unwatch()
    setDark(true)
    await nextTick()

    expect(a).not.toHaveBeenCalled()
  })

  it('delivers again once a subscriber re-subscribes after the last one left', async () => {
    const a = vi.fn()
    const unwatchA = subscribe(a)
    unwatchA()

    const b = vi.fn()
    subscribe(b)

    setDark(true)
    await nextTick()

    expect(b).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledWith(true)
  })
})

describe('shared/theme.js: DarkMode', () => {
  afterEach(() => {
    document.body.classList.remove('body--dark')
  })

  it('sets the host attribute immediately on hostConnected when the body is already dark, without waiting for a mutation', () => {
    setDark(true)
    const host = new FakeHost()
    const darkMode = new DarkMode(host)

    darkMode.hostConnected()

    expect(host.hasAttribute('dark')).toBe(true)
    expect(darkMode.isDark).toBe(true)

    darkMode.hostDisconnected()
  })

  it('flips the host attribute and .isDark as the body class changes afterwards', async () => {
    setDark(false)
    const host = new FakeHost()
    const darkMode = new DarkMode(host)
    darkMode.hostConnected()

    expect(host.hasAttribute('dark')).toBe(false)

    setDark(true)
    await nextTick()

    expect(host.hasAttribute('dark')).toBe(true)
    expect(darkMode.isDark).toBe(true)

    darkMode.hostDisconnected()
  })

  it('with attribute: false, leaves the host attribute off while .isDark still tracks the theme', async () => {
    setDark(false)
    const host = new FakeHost()
    const darkMode = new DarkMode(host, { attribute: false })
    darkMode.hostConnected()

    setDark(true)
    await nextTick()

    expect(host.hasAttribute('dark')).toBe(false)
    expect(darkMode.isDark).toBe(true)

    darkMode.hostDisconnected()
  })

  it('calls onChange with the new value only after requestUpdate() has already been invoked', async () => {
    setDark(false)
    const order = []
    const host = new FakeHost()
    host.requestUpdate = () => order.push('requestUpdate')
    const onChange = (dark) => order.push(`onChange:${dark}`)
    const darkMode = new DarkMode(host, { onChange })
    darkMode.hostConnected()
    // -> Clear the hostConnected-time apply call; only the mutation-driven one is under test here.
    order.length = 0

    setDark(true)
    await nextTick()

    expect(order).toEqual(['requestUpdate', 'onChange:true'])

    darkMode.hostDisconnected()
  })

  it('stops reacting to the theme once hostDisconnected has run', async () => {
    setDark(false)
    const host = new FakeHost()
    const darkMode = new DarkMode(host)
    darkMode.hostConnected()
    darkMode.hostDisconnected()

    setDark(true)
    await nextTick()

    expect(host.hasAttribute('dark')).toBe(false)
  })
})
