import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useUserStore } from '@/stores/user'

import { humanizeDate, humanizeDuration, humanizeIsoDuration, relativeDate } from './datetime.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

// -> Matches `common.datetime`'s `"{date} at {time}"` closely enough to prove the word-order
//    argument is actually threaded through, without pulling in the full i18n setup for one string.
const t = (key, params) => `${params.date} at ${params.time}`

describe('humanizeDate', () => {
  it('returns the placeholder for a null or empty value', () => {
    expect(humanizeDate(t, null)).toBe('---')
    expect(humanizeDate(t, '')).toBe('---')
  })

  it('renders in the profile-stored timezone and date pattern, not the system zone', () => {
    const userStore = useUserStore()
    userStore.dateFormat = 'DD/MM/YYYY'
    userStore.timezone = 'UTC'

    expect(humanizeDate(t, '2026-03-04T12:00:00Z')).toBe('04/03/2026 at 12:00 PM')
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
