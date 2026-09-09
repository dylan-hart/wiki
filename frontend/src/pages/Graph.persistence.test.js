import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #2854: the five graph view controls (`groupBy`, `sizeBy`, `sizeCountMode`,
 * `pageviewsWindow`, `pageviewClientTypes`) persisted onto the signed-in reader's own profile, under
 * `prefs.graph`, through the existing profile PATCH route -- loaded on mount (`loadGraphPrefs()`),
 * saved debounced on change (`saveGraphPrefs()`/`debouncedSaveGraphPrefs`). See
 * `backend/api/users/profile.test.ts` and `backend/models/users.profile.test.ts` for the backend
 * half of the same contract, and `Graph.sizing.test.js` for #2853's own defaults this suite builds
 * on rather than re-covers.
 */
describe('Graph.vue graph view preference persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never fetches or saves a profile preference for a guest reader', async () => {
    const wrapper = await mountGraph()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(2) // -> graph + pageviews only, no profile call

    wrapper.vm.groupBy = 'tag'
    await vi.advanceTimersByTimeAsync(1000)

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('loads the four flat persisted controls for a signed in reader', async () => {
    const wrapper = await mountGraph({
      authenticated: true,
      graphPrefs: {
        groupBy: 'tag',
        count: 'unique',
        over: 'last6mo',
        clientTypes: ['browser']
      }
    })

    expect(wrapper.vm.groupBy).toBe('tag')
    expect(wrapper.vm.sizeCountMode).toBe('unique')
    expect(wrapper.vm.pageviewsWindow).toBe('last6mo')
    expect(wrapper.vm.pageviewClientTypes).toEqual(['browser'])
  })

  it("falls back to OpenProject #2853's corrected defaults for a signed in reader with no saved preference", async () => {
    const wrapper = await mountGraph({ authenticated: true })

    expect(wrapper.vm.groupBy).toBe('folder')
    expect(wrapper.vm.sizeBy).toBe('edits')
    expect(wrapper.vm.sizeCountMode).toBe('total')
    expect(wrapper.vm.pageviewsWindow).toBe('last30d')
    expect(wrapper.vm.pageviewClientTypes).toEqual(['browser', 'api', 'mcp'])
  })

  it("keeps a persisted sizeBy of 'edits' even once pageview tracking resolves enabled -- #2853's own promotion does not override a deliberate choice", async () => {
    const wrapper = await mountGraph({
      authenticated: true,
      pageviewsEnabled: true,
      graphPrefs: { sizeBy: 'edits' }
    })

    expect(wrapper.vm.sizeBy).toBe('edits')
  })

  it("falls a persisted sizeBy of 'visits' back to 'edits' once pageview tracking resolves disabled", async () => {
    const wrapper = await mountGraph({
      authenticated: true,
      pageviewsEnabled: false,
      graphPrefs: { sizeBy: 'visits' }
    })

    expect(wrapper.vm.sizeBy).toBe('edits')
  })

  it("keeps a persisted sizeBy of 'visits' once pageview tracking resolves enabled", async () => {
    const wrapper = await mountGraph({
      authenticated: true,
      pageviewsEnabled: true,
      graphPrefs: { sizeBy: 'visits' }
    })

    expect(wrapper.vm.sizeBy).toBe('visits')
  })

  it('does not save anything as a side effect of the initial load itself', async () => {
    await mountGraph({ authenticated: true, graphPrefs: { groupBy: 'tag', sizeBy: 'edits' } })
    await vi.advanceTimersByTimeAsync(1000)

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })

  it('saves the merged five-key object (debounced) once a control changes', async () => {
    const wrapper = await mountGraph({ authenticated: true })

    wrapper.vm.groupBy = 'tag'
    expect(API_CLIENT.put).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)

    expect(API_CLIENT.put).toHaveBeenCalledWith('profile', {
      json: {
        graph: {
          groupBy: 'tag',
          sizeBy: 'edits',
          count: 'total',
          over: 'last30d',
          clientTypes: ['browser', 'api', 'mcp']
        }
      }
    })
  })

  it('collapses a burst of control changes into a single save', async () => {
    const wrapper = await mountGraph({ authenticated: true })

    wrapper.vm.groupBy = 'tag'
    await vi.advanceTimersByTimeAsync(100)
    wrapper.vm.sizeCountMode = 'unique'
    await vi.advanceTimersByTimeAsync(1000)

    expect(API_CLIENT.put).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending save on unmount', async () => {
    const wrapper = await mountGraph({ authenticated: true })

    wrapper.vm.groupBy = 'tag'
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(1000)

    expect(API_CLIENT.put).not.toHaveBeenCalled()
  })
})
