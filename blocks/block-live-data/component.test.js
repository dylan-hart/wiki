import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './component.js'
import { sparklinePath, statusLevel } from './component.js'
import { _resetSiteCache } from '../shared/site.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom, stubSiteFetch } from '../test/mount.js'

const SITE_ID = '11111111-1111-4111-8111-111111111111'

function stubFetch({ siteOk = true, resolveOk = true, value = 42, status = 200 } = {}) {
  return stubSiteFetch({
    site: { id: SITE_ID },
    ok: siteOk,
    onRequest: async () => ({
      ok: resolveOk,
      status,
      json: async () =>
        resolveOk
          ? { value, fetchedAt: '2026-08-22T00:00:00.000Z' }
          : { message: `The endpoint answered ${status}.` }
    })
  })
}

/**
 * Mounts a `<block-live-data>` with the given props and waits for its first poll to settle.
 *
 * `settle: 2`: connectedCallback's _poll() is async (siteId fetch, then the resolve fetch), and a
 * couple of macrotask turns is enough for both promise chains to settle.
 */
const mountLiveData = (props = {}) =>
  mountBlock('block-live-data', {
    props: { url: 'https://api.example.com/metrics', jsonPath: '$.v', ...props },
    settle: 2
  })

describe('block-live-data', () => {
  beforeEach(() => {
    _resetSiteCache()
  })

  afterEach(() => {
    resetBlockDom()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe('statusLevel', () => {
    it('is unknown when neither threshold is set', () => {
      expect(statusLevel(5, undefined, undefined)).toBe('unknown')
    })

    it('is unknown for a non-numeric value', () => {
      expect(statusLevel('not-a-number', 10, 20)).toBe('unknown')
    })

    it('is ok at or below okMax', () => {
      expect(statusLevel(5, 10, 20)).toBe('ok')
      expect(statusLevel(10, 10, 20)).toBe('ok')
    })

    it('is warning above okMax and at or below warnMax', () => {
      expect(statusLevel(15, 10, 20)).toBe('warning')
      expect(statusLevel(20, 10, 20)).toBe('warning')
    })

    it('is critical above warnMax', () => {
      expect(statusLevel(21, 10, 20)).toBe('critical')
    })
  })

  describe('sparklinePath', () => {
    it('spreads points across the full width, scaled by their range', () => {
      const path = sparklinePath([0, 5, 10])
      expect(path).toBe('M0.00,30.00 L50.00,16.00 L100.00,2.00')
    })

    it('draws a flat line down the middle when every point is identical', () => {
      const path = sparklinePath([7, 7, 7])
      expect(path).toBe('M0.00,16.00 L50.00,16.00 L100.00,16.00')
    })
  })

  describe('end-to-end, as actually rendered', () => {
    it("fetches the site id, then posts to that site's live-data resolve route", async () => {
      const fetchMock = stubFetch({ value: 17 })
      const el = await mountLiveData({ credentialId: 'cred-1', jsonPath: '$.cpu' })

      expect(fetchMock).toHaveBeenCalledWith('/_api/sites/current')
      const [resolveUrl, init] = fetchMock.mock.calls.find(([url]) => url !== '/_api/sites/current')
      expect(resolveUrl).toBe(`/_api/sites/${SITE_ID}/live-data/resolve`)
      expect(JSON.parse(init.body)).toEqual({
        credentialId: 'cred-1',
        url: 'https://api.example.com/metrics',
        jsonPath: '$.cpu',
        refreshInterval: 60
      })
      expect(el.shadowRoot.querySelector('.value').textContent).toBe('17')
    })

    it('shows an error state when the resolve request fails, without throwing', async () => {
      stubFetch({ resolveOk: false, status: 502 })
      const el = await mountLiveData()

      expect(el.shadowRoot.querySelector('.error')?.textContent).toContain('answered 502')
      expect(el.shadowRoot.querySelector('.value')).toBeNull()
    })

    it('shows an error state immediately when url or jsonPath is missing, with no fetch at all', async () => {
      const fetchMock = stubFetch()
      const el = await mountLiveData({ url: '' })

      expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('renders the unit next to the value', async () => {
      stubFetch({ value: 99 })
      const el = await mountLiveData({ unit: '%' })

      expect(el.shadowRoot.querySelector('.unit')?.textContent).toBe('%')
    })

    it('status mode renders a coloured pill matching statusLevel', async () => {
      stubFetch({ value: 25 })
      const el = await mountLiveData({ displayMode: 'status', okMax: 10, warnMax: 20 })

      expect(el.shadowRoot.querySelector('.pill.status-critical')).not.toBeNull()
    })

    it('sparkline mode draws no line on the first reading, and one after a second poll', async () => {
      vi.useFakeTimers()
      let call = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url) => {
          if (url === '/_api/sites/current') {
            return { ok: true, json: async () => ({ id: SITE_ID }) }
          }
          call++
          return {
            ok: true,
            status: 200,
            json: async () => ({
              value: call === 1 ? 10 : 20,
              fetchedAt: '2026-08-22T00:00:00.000Z'
            })
          }
        })
      )

      // -> Mounted without `settle`: this test drives the poll on fake timers itself below, where a
      //    real `setTimeout` would never fire.
      const el = await mountBlock('block-live-data', {
        props: {
          url: 'https://api.example.com/metrics',
          jsonPath: '$.v',
          displayMode: 'sparkline',
          refreshInterval: 10
        }
      })
      await vi.advanceTimersByTimeAsync(0)
      await el.updateComplete
      expect(el.shadowRoot.querySelector('svg.sparkline')).toBeNull()

      await vi.advanceTimersByTimeAsync(10_000)
      await el.updateComplete
      expect(el.shadowRoot.querySelector('svg.sparkline')).not.toBeNull()
    })
  })

  describe('disconnecting mid-fetch', () => {
    it('does not reschedule another poll once removed from the page while a fetch is in flight', async () => {
      vi.useFakeTimers()
      let resolveFetch
      const fetchMock = vi.fn((url) => {
        if (url === '/_api/sites/current') {
          return Promise.resolve({ ok: true, json: async () => ({ id: SITE_ID }) })
        }
        // -> Never settles on its own -- the test settles it after disconnecting, so the race
        //    (disconnect landing while this poll's own fetch is still outstanding) is deterministic
        //    rather than timing-dependent.
        return new Promise((resolve) => {
          resolveFetch = resolve
        })
      })
      vi.stubGlobal('fetch', fetchMock)

      // -> Mounted without `settle`: this test drives the poll on fake timers itself below, where a
      //    real `setTimeout` would never fire.
      const el = await mountBlock('block-live-data', {
        props: {
          url: 'https://api.example.com/metrics',
          jsonPath: '$.v',
          refreshInterval: 10
        }
      })
      // -> Lets getSiteId's fetch resolve and the resolve-route fetch actually start.
      await vi.advanceTimersByTimeAsync(0)

      document.body.removeChild(el)
      resolveFetch({ ok: true, status: 200, json: async () => ({ value: 1, fetchedAt: '' }) })
      await vi.advanceTimersByTimeAsync(0)

      const resolveCallCount = () =>
        fetchMock.mock.calls.filter(([url]) => url !== '/_api/sites/current').length
      const callsRightAfterDisconnect = resolveCallCount()

      // -> Well past any refresh interval this test could have set -- if the old timer survived the
      //    disconnect, this is well past enough time for it to have fired at least once more.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(resolveCallCount()).toBe(callsRightAfterDisconnect)
    })
  })

  describeDarkMode(
    () => {
      stubFetch({ value: 1 })
      return mountLiveData()
    },
    { inverted: true }
  )
})
