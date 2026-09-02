import { afterEach, describe, expect, it, vi } from 'vitest'

import './component.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

// -> Far enough out that "has this already ended" never becomes true for a test run, whichever
//    timezone it resolves against.
const FUTURE_DATE = '2099-01-01T00:00'

/**
 * Appends a `<block-countdown>` with the given properties set (mirroring how the picker's
 * attributes reach the element once Lit parses them) and waits for one render. `date` defaults to
 * a far-future value so a test that only cares about another field (timezone, label, ...) never
 * has to think about expiry.
 */
const mountCountdown = ({ date = FUTURE_DATE, ...rest } = {}) =>
  mountBlock('block-countdown', { props: { date, ...rest } })

describe('block-countdown', () => {
  afterEach(() => {
    resetBlockDom()
    vi.useRealTimers()
  })

  /*
    Regression coverage for OpenProject #957/#958: the picker (`blockAttributes` in
    `frontend/src/helpers/blocks.js`) never writes an attribute for a field left at the prop's own
    `default` value, and never writes one for a field cleared to `''` either way -- so the constructor
    default is what an author clearing the Timezone field actually gets. It has to be `''`, matching
    the prop's own default, for "the reader's own timezone when empty" to be reachable at all.
  */
  it('defaults to the reader-local timezone when timezone is never set', async () => {
    const el = await mountCountdown()

    expect(el.timezone).toBe('')
    expect(el._error).toBe('')
    expect(el._target.timeZoneId).toBe(Temporal.Now.timeZoneId())
  })

  it('still honors an explicit UTC timezone', async () => {
    const el = await mountCountdown({ timezone: 'UTC' })

    expect(el._error).toBe('')
    expect(el._target.timeZoneId).toBe('UTC')
  })

  it('honors an explicit IANA timezone', async () => {
    const el = await mountCountdown({ timezone: 'Europe/Paris' })

    expect(el._error).toBe('')
    expect(el._target.timeZoneId).toBe('Europe/Paris')
  })

  it('shows an error for an unrecognised timezone rather than silently falling back', async () => {
    const el = await mountCountdown({ timezone: 'Not/AZone' })

    expect(el._error).toContain('Not/AZone')
    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
  })

  it('shows the remaining days/hours/minutes/seconds to a future UTC target', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const el = await mountCountdown({ date: '2026-01-03T01:02:03Z', timezone: 'UTC' })

    const values = [...el.shadowRoot.querySelectorAll('.value')].map((n) => n.textContent)
    expect(values).toEqual(['2', '1', '2', '3'])
    expect(el.shadowRoot.querySelector('.ended')).toBeNull()
  })

  it('shows the expired message once the target has passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-10T00:00:00Z'))

    const el = await mountCountdown({
      date: '2026-01-01T00:00:00Z',
      timezone: 'UTC',
      expiredMsg: 'All done!'
    })

    expect(el.shadowRoot.querySelector('.ended').textContent).toBe('All done!')
    expect(el.shadowRoot.querySelector('.segments')).toBeNull()
  })

  it('resolves a wall-clock date (no offset) against the configured timezone', async () => {
    vi.useFakeTimers()
    // -> Midnight UTC is already 01:00 in Europe/Paris (UTC+1 in January), so a wall-clock target of
    //    "2026-01-01T01:00" Paris time has already arrived by then
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const el = await mountCountdown({ date: '2026-01-01T01:00:00', timezone: 'Europe/Paris' })

    expect(el.shadowRoot.querySelector('.ended')).not.toBeNull()
  })

  it('treats a date carrying its own offset as an exact instant, timezone only affecting display', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    // -> 05:00-05:00 is 10:00 UTC, 10 hours away
    const el = await mountCountdown({ date: '2026-01-01T05:00:00-05:00', timezone: 'UTC' })

    const values = [...el.shadowRoot.querySelectorAll('.value')].map((n) => n.textContent)
    expect(values).toEqual(['10', '0', '0'])
  })

  it('shows an error for an unparseable date rather than throwing', async () => {
    const el = await mountCountdown({ date: 'not a date', timezone: 'UTC' })

    expect(el.shadowRoot.querySelector('.error').textContent).toContain(
      'is not a date this can count down to'
    )
  })

  it('shows an error for an unknown timezone rather than throwing', async () => {
    const el = await mountCountdown({ date: '2026-01-01T00:00:00Z', timezone: 'Not/AZone' })

    expect(el.shadowRoot.querySelector('.error').textContent).toContain('is not a known timezone')
  })

  it('shows the optional label above the segments when given', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const el = await mountCountdown({
      date: '2026-01-02T00:00:00Z',
      timezone: 'UTC',
      label: 'New Year Sale'
    })

    expect(el.shadowRoot.querySelector('.label').textContent).toBe('New Year Sale')
  })

  it('stops its own interval on disconnect', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')

    const el = await mountCountdown({ date: '2026-01-02T00:00:00Z', timezone: 'UTC' })
    el.remove()

    expect(clearSpy).toHaveBeenCalled()
  })

  describeDarkMode(() => mountCountdown({ date: '2026-01-01T00:00:00Z', timezone: 'UTC' }))
})
