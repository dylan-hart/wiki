import { afterEach, describe, expect, it } from 'vitest'

import { useDirection } from './direction.js'

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 721: a component that stays
 * mounted across navigations (`PageHeader.vue`'s review-queue menu is the concrete case) cannot get
 * its direction from a one-time read of `document.documentElement.dir` at setup -- `App.vue`'s
 * `applyLocale()` flips that attribute on every navigation, not only once at boot, so a reader moving
 * between an LTR page and an RTL one in the same visit needs a reactive source. `useDirection()`
 * mirrors the attribute into a module-level ref for exactly that, the same way `composables/dark.js`
 * mirrors `body--dark`.
 */
afterEach(() => {
  document.documentElement.removeAttribute('dir')
})

describe('useDirection', () => {
  it('set(true) flips both the reactive flag and the dir attribute to rtl', () => {
    const direction = useDirection()
    direction.set(true)

    expect(direction.isRTL).toBe(true)
    expect(document.documentElement.getAttribute('dir')).toBe('rtl')
  })

  it('set(false) flips both the reactive flag and the dir attribute to ltr', () => {
    const direction = useDirection()
    direction.set(true)
    direction.set(false)

    expect(direction.isRTL).toBe(false)
    expect(document.documentElement.getAttribute('dir')).toBe('ltr')
  })

  it('shares one reactive value across every caller', () => {
    const a = useDirection()
    const b = useDirection()

    a.set(true)

    expect(b.isRTL).toBe(true)
  })
})
