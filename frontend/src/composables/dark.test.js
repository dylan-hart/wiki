import { afterEach, describe, expect, it } from 'vitest'

import { useDark } from './dark.js'

afterEach(() => {
  document.body.classList.remove('body--dark', 'body--light')
  document.documentElement.classList.remove('theme-transition-suppress')
})

describe('useDark', () => {
  it('set(true) flips both the reactive flag and the body classes', () => {
    const dark = useDark()
    dark.set(true)

    expect(dark.isActive).toBe(true)
    expect(document.body.classList.contains('body--dark')).toBe(true)
    expect(document.body.classList.contains('body--light')).toBe(false)
  })

  it('toggle() flips the opposite way each time', () => {
    const dark = useDark()
    dark.set(false)
    dark.toggle()

    expect(dark.isActive).toBe(true)

    dark.toggle()

    expect(dark.isActive).toBe(false)
  })

  it('shares one reactive value across every caller', () => {
    const a = useDark()
    const b = useDark()

    a.set(true)

    expect(b.isActive).toBe(true)
  })

  it('adds the transition-suppress class synchronously with the flip, then removes it on the next frame', async () => {
    const dark = useDark()
    dark.set(true)

    expect(document.documentElement.classList.contains('theme-transition-suppress')).toBe(true)

    await new Promise((resolve) => requestAnimationFrame(resolve))

    expect(document.documentElement.classList.contains('theme-transition-suppress')).toBe(false)
  })
})
