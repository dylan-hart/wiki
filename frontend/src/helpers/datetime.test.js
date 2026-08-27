import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import {
  humanizeDate,
  humanizeDateWithSeconds,
  humanizeDuration,
  humanizeIsoDuration,
  relativeDate
} from './datetime.js'
import { useUserStore } from '@/stores/user'

// -> Not a real i18n instance -- these tests are about the delegation and the placeholder guard, not
//    about `common.datetime`'s own wording, which is covered by the locale strings themselves.
const fakeT = (key, params) => `${params.date} at ${params.time}`

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('humanizeDate', () => {
  it('returns the placeholder for a null/empty value', () => {
    expect(humanizeDate(fakeT, null)).toBe('---')
    expect(humanizeDate(fakeT, '')).toBe('---')
  })

  it('renders in the stored timezone and date pattern, at minute precision', () => {
    const store = useUserStore()
    store.timezone = 'Asia/Tokyo'
    store.dateFormat = 'DD/MM/YYYY'
    store.timeFormat = '24h'

    // 2026-03-04T23:30:00Z is 2026-03-05 08:30 in Asia/Tokyo (UTC+9, no DST)
    expect(humanizeDate(fakeT, '2026-03-04T23:30:00Z')).toBe('05/03/2026 at 08:30')
  })
})

describe('humanizeDateWithSeconds', () => {
  it('returns the placeholder for a null/empty value', () => {
    expect(humanizeDateWithSeconds(fakeT, null)).toBe('---')
  })

  it('renders the same moment as humanizeDate, with seconds added', () => {
    const store = useUserStore()
    store.timezone = 'UTC'
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '24h'

    expect(humanizeDate(fakeT, '2026-03-04T12:34:56Z')).toBe('2026-03-04 at 12:34')
    expect(humanizeDateWithSeconds(fakeT, '2026-03-04T12:34:56Z')).toBe('2026-03-04 at 12:34:56')
  })
})

describe('humanizeIsoDuration', () => {
  it('renders a single-unit ISO-8601 duration in words', () => {
    expect(humanizeIsoDuration('PT5M')).toBe('5 minutes')
    expect(humanizeIsoDuration('PT1H')).toBe('1 hour')
    expect(humanizeIsoDuration('P1D')).toBe('1 day')
  })

  it('renders a multi-unit duration as a joined list', () => {
    expect(humanizeIsoDuration('P1DT12H')).toBe('1 day and 12 hours')
  })

  it('returns the placeholder for false, null or empty', () => {
    expect(humanizeIsoDuration(false)).toBe('---')
    expect(humanizeIsoDuration(null)).toBe('---')
    expect(humanizeIsoDuration('')).toBe('---')
  })
})

// -> Not new behavior, just confirming the existing exports still work from this file once it grew a
//    third one -- a plain smoke check, not a re-test of `Intl.RelativeTimeFormat`/`Intl.ListFormat`.
describe('existing datetime helpers', () => {
  it('relativeDate still handles the placeholder case', () => {
    expect(relativeDate(null)).toBe('---')
  })

  it('humanizeDuration still handles the placeholder case', () => {
    expect(humanizeDuration(null, null)).toBe('---')
  })
})
