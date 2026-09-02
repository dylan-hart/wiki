import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Task 472: `useMinWidth` is the mechanism `MainLayout.vue`'s `showEditNav`, `HeaderNav.vue` and
 * `PageHeader.vue` all lean on as their "is this a phone" proxy -- see the comment on `showEditNav`
 * for why viewport width was kept over a real `matchMedia('(any-pointer: fine)')` query. This locks
 * in what that proxy actually does: tracks a `(min-width: …px)` media query, shares one `matchMedia`
 * listener per breakpoint across every caller, and updates reactively when the viewport crosses it.
 *
 * `queries` in `screen.js` is module-scoped and never cleared, so each test gets its own fresh module
 * instance via `vi.resetModules()` + a dynamic import -- otherwise the first test to ask for a given
 * breakpoint would permanently decide what every later test sees for it.
 */

function stubMatchMedia(widthPx) {
  const listenersByQuery = new Map()
  const stub = vi.fn((query) => {
    const minWidth = Number(query.match(/min-width:\s*(\d+)px/)[1])
    const mql = {
      matches: widthPx >= minWidth,
      media: query,
      addEventListener: (event, handler) => {
        if (event === 'change') {
          listenersByQuery.set(query, handler)
        }
      },
      removeEventListener: () => {}
    }
    return mql
  })
  vi.stubGlobal('matchMedia', stub)
  return {
    matchMedia: stub,
    fireChange(query, matches) {
      listenersByQuery.get(query)?.({ matches })
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('useMinWidth', () => {
  it('is true when the viewport starts at or above the breakpoint', async () => {
    stubMatchMedia(1024)
    const { useMinWidth } = await import('./screen.js')

    expect(useMinWidth(600).value).toBe(true)
  })

  it('is false when the viewport starts below the breakpoint', async () => {
    stubMatchMedia(320)
    const { useMinWidth } = await import('./screen.js')

    expect(useMinWidth(600).value).toBe(false)
  })

  it('updates reactively when the viewport crosses the breakpoint', async () => {
    const media = stubMatchMedia(320)
    const { useMinWidth } = await import('./screen.js')

    const isAtLeastSm = useMinWidth(600)
    expect(isAtLeastSm.value).toBe(false)

    media.fireChange('(min-width: 600px)', true)
    expect(isAtLeastSm.value).toBe(true)
  })

  it('shares one matchMedia listener per breakpoint across every caller', async () => {
    const media = stubMatchMedia(1024)
    const { useMinWidth } = await import('./screen.js')

    useMinWidth(600)
    useMinWidth(600)
    useMinWidth(1024)

    expect(media.matchMedia).toHaveBeenCalledTimes(2)
  })
})

describe('useScreen', () => {
  it('gte.* mirrors useMinWidth at each named breakpoint', async () => {
    stubMatchMedia(1024)
    const { useScreen } = await import('./screen.js')

    const screen = useScreen()
    expect(screen.gte.sm).toBe(true)
    expect(screen.gte.md).toBe(true)
    expect(screen.gte.lg).toBe(false)
    expect(screen.gte.xl).toBe(false)
  })

  // -> 1024px is exactly `md`: at it, but not past it
  it('is false for a breakpoint the viewport has not reached', async () => {
    stubMatchMedia(1024)
    const { useScreen } = await import('./screen.js')

    expect(useScreen().gte.lg).toBe(false)
  })
})
