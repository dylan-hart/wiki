import { afterEach, describe, expect, it } from 'vitest'

import { useAesthetic } from './aesthetic.js'

/**
 * Feature #2753 / Task #2766: `aesthetic.js` is `dark.js`'s sibling for the second, fully
 * independent theme axis. It brackets the `body--ledger`/`body--cobalt` flip with
 * `.theme-transition-suppress` on `<html>` for one frame the same way `dark.js` does for
 * `body--dark`/`body--light`.
 */
afterEach(() => {
  document.body.classList.remove('body--ledger', 'body--cobalt')
  document.documentElement.classList.remove('theme-transition-suppress')
})

describe('useAesthetic', () => {
  it('defaults to ledger when the DOM carries neither class', () => {
    const aesthetic = useAesthetic()

    expect(aesthetic.current).toBe('ledger')
  })

  it("set('cobalt') flips both the reactive value and the body classes", () => {
    const aesthetic = useAesthetic()
    aesthetic.set('cobalt')

    expect(aesthetic.current).toBe('cobalt')
    expect(document.body.classList.contains('body--cobalt')).toBe(true)
    expect(document.body.classList.contains('body--ledger')).toBe(false)
  })

  it("set('ledger') flips back", () => {
    const aesthetic = useAesthetic()
    aesthetic.set('cobalt')
    aesthetic.set('ledger')

    expect(aesthetic.current).toBe('ledger')
    expect(document.body.classList.contains('body--ledger')).toBe(true)
    expect(document.body.classList.contains('body--cobalt')).toBe(false)
  })

  it('shares one reactive value across every caller', () => {
    const a = useAesthetic()
    const b = useAesthetic()

    a.set('cobalt')

    expect(b.current).toBe('cobalt')
  })

  it('does not touch the dark-mode classes', () => {
    document.body.classList.add('body--dark')

    const aesthetic = useAesthetic()
    aesthetic.set('cobalt')

    expect(document.body.classList.contains('body--dark')).toBe(true)
  })

  it('adds the transition-suppress class synchronously with the flip, then removes it on the next frame', async () => {
    const aesthetic = useAesthetic()
    aesthetic.set('cobalt')

    expect(document.documentElement.classList.contains('theme-transition-suppress')).toBe(true)

    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(document.documentElement.classList.contains('theme-transition-suppress')).toBe(false)
  })
})
