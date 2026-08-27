import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useUserStore } from '@/stores/user'

import { humanizeDate, humanizeDuration, humanizeIsoDuration, relativeDate } from './datetime.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

// -> Mirrors real i18n interpolation for `common.datetime`: `"{date} at {time}"`
const t = (key, params) => (key === 'common.datetime' ? `${params.date} at ${params.time}` : key)

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

describe('humanizeDate', () => {
  it('returns the placeholder for a nullish or empty value', () => {
    expect(humanizeDate(t, null)).toBe('---')
    expect(humanizeDate(t, undefined)).toBe('---')
    expect(humanizeDate(t, '')).toBe('---')
  })

  it('renders in the stored timezone and date/time format', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '24h'
    store.timezone = 'UTC'

    expect(humanizeDate(t, '2026-03-04T15:30:00Z')).toBe('2026-03-04 at 15:30')
  })

  it('renders the same instant differently for a non-UTC stored timezone', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '24h'
    store.timezone = 'Asia/Tokyo'

    expect(humanizeDate(t, '2026-03-04T15:30:00Z')).toBe('2026-03-05 at 00:30')
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
