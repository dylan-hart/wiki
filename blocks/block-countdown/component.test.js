import { afterEach, describe, expect, it, vi } from 'vitest'

import './component.js'

async function mountCountdown(attrs = {}) {
  const el = document.createElement('block-countdown')
  for (const [key, value] of Object.entries(attrs)) {
    el[key] = value
  }
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('block-countdown', () => {
  afterEach(() => {
    document.body.replaceChildren()
    document.body.className = ''
    vi.useRealTimers()
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

  describe('dark mode', () => {
    it('follows body--dark via the shared DarkMode controller', async () => {
      document.body.classList.add('body--dark')
      const el = await mountCountdown({ date: '2026-01-01T00:00:00Z', timezone: 'UTC' })

      expect(el.hasAttribute('dark')).toBe(true)

      document.body.classList.remove('body--dark')
      await new Promise((resolve) => queueMicrotask(resolve))
      await el.updateComplete

      expect(el.hasAttribute('dark')).toBe(false)
    })
  })
})
