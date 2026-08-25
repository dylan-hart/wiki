import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useUserStore } from '@/stores/user'

import {
  humanizeDate,
  humanizeDateWithSeconds,
  humanizeDuration,
  humanizeIsoDuration,
  relativeDate
} from './datetime.js'

// -> Mirrors `common.datetime`'s real "{date} at {time}" shape (`backend/locales/en.json`) closely
//    enough to assert on, without pulling the actual i18n instance into a helpers unit test.
const t = (key, params) => `${params.date} at ${params.time}`

describe('humanizeDate', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('returns the placeholder for a null/empty value', () => {
    expect(humanizeDate(t, null)).toBe('---')
    expect(humanizeDate(t, '')).toBe('---')
  })

  it("renders in the user's stored non-system timezone and date pattern, at minute precision", () => {
    const store = useUserStore()
    store.timezone = 'Asia/Tokyo'
    store.dateFormat = 'DD/MM/YYYY'
    store.timeFormat = '24h'

    // -> 2026-08-25T03:15:42Z is 2026-08-25 12:15:42 in Asia/Tokyo (UTC+9)
    expect(humanizeDate(t, '2026-08-25T03:15:42Z')).toBe('25/08/2026 at 12:15')
  })
})

describe('humanizeDateWithSeconds', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('returns the placeholder for a null/empty value', () => {
    expect(humanizeDateWithSeconds(t, null)).toBe('---')
    expect(humanizeDateWithSeconds(t, '')).toBe('---')
  })

  it("renders in the user's stored timezone with seconds included", () => {
    const store = useUserStore()
    store.timezone = 'Asia/Tokyo'
    store.dateFormat = 'DD/MM/YYYY'
    store.timeFormat = '24h'

    expect(humanizeDateWithSeconds(t, '2026-08-25T03:15:42Z')).toBe('25/08/2026 at 12:15:42')
  })

  it('is strictly more precise than humanizeDate for the same instant', () => {
    const store = useUserStore()
    store.timezone = 'Asia/Tokyo'
    store.dateFormat = 'DD/MM/YYYY'
    store.timeFormat = '24h'

    expect(humanizeDateWithSeconds(t, '2026-08-25T03:15:42Z')).not.toBe(
      humanizeDate(t, '2026-08-25T03:15:42Z')
    )
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
