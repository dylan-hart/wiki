import { afterEach, describe, expect, it } from 'vitest'

import { useDirection } from './direction.js'

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
