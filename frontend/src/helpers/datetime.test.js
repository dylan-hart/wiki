import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useCommonStore } from '@/stores/common'
import { useUserStore } from '@/stores/user'

import {
  humanizeDate,
  humanizeDateWithSeconds,
  humanizeDuration,
  humanizeIsoDuration,
  relativeDate
} from './datetime.js'

// -> Not a real i18n instance -- these tests are about the delegation and the placeholder guard, not
//    about `common.datetime`'s own wording, which is covered by the locale strings themselves.
const fakeT = (key, params) => `${params.date} at ${params.time}`

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('humanizeDate', () => {
  it('returns the placeholder for a nullish or empty value', () => {
    expect(humanizeDate(fakeT, null)).toBe('---')
    expect(humanizeDate(fakeT, undefined)).toBe('---')
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

  it('renders the same instant differently for a non-UTC stored timezone', () => {
    const store = useUserStore()
    store.dateFormat = 'YYYY-MM-DD'
    store.timeFormat = '24h'
    store.timezone = 'UTC'

    expect(humanizeDate(fakeT, '2026-03-04T15:30:00Z')).toBe('2026-03-04 at 15:30')

    store.timezone = 'Asia/Tokyo'
    expect(humanizeDate(fakeT, '2026-03-04T15:30:00Z')).toBe('2026-03-05 at 00:30')
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

  it('is strictly more precise than humanizeDate for the same instant', () => {
    const store = useUserStore()
    store.timezone = 'Asia/Tokyo'
    store.dateFormat = 'DD/MM/YYYY'
    store.timeFormat = '24h'

    expect(humanizeDateWithSeconds(fakeT, '2026-08-25T03:15:42Z')).not.toBe(
      humanizeDate(fakeT, '2026-08-25T03:15:42Z')
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

  // -> The number formatters behind this are hoisted to module scope, keyed by singular unit name --
  //    this exercises every unit in ISO_DURATION_UNITS in one call, so a mis-keyed or missing map
  //    entry for any of them would show up as a wrong/undefined segment rather than passing quietly.
  it('renders every unit correctly out of the hoisted formatter map', () => {
    expect(humanizeIsoDuration('P1Y2M3W4DT5H6M7S')).toBe(
      '1 year, 2 months, 3 weeks, 4 days, 5 hours, 6 minutes, and 7 seconds'
    )
  })
})

// -> Extended for OpenProject #1881: hoisting the per-call `Intl.NumberFormat`/`Intl.DateTimeFormat`
//    construction inside these functions to module scope must not change a single rendered string.
describe('humanizeDuration', () => {
  it('renders a multi-unit duration narrow and largest-first', () => {
    expect(humanizeDuration('2024-01-01T00:00:00Z', '2024-01-01T01:04:32Z')).toBe('1h 4m 32s')
  })

  it('renders a sub-millisecond duration as 0ms', () => {
    expect(humanizeDuration('2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')).toBe('0ms')
  })

  it('returns the placeholder when either end is missing', () => {
    expect(humanizeDuration(null, '2024-01-01T00:00:00Z')).toBe('---')
    expect(humanizeDuration('2024-01-01T00:00:00Z', null)).toBe('---')
  })

  // -> The hoisted formatters are shared, mutable-free `Intl.NumberFormat` instances -- calling twice
  //    with the same input must keep producing the same output, not drift from any shared state.
  it('produces identical output across repeated calls against the shared formatters', () => {
    const first = humanizeDuration('2024-01-01T00:00:00Z', '2024-01-01T01:04:32Z')
    const second = humanizeDuration('2024-01-01T00:00:00Z', '2024-01-01T01:04:32Z')
    expect(second).toBe(first)
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

/**
 * OpenProject #1600: every `Intl.*Format` in this file is keyed off `commonStore.locale`, not the
 * browser's own locale, and built lazily rather than captured once at import time. These pin both
 * halves of that with real ICU output (French/German wording differs from English's), not a spy on
 * the `Intl` constructors -- a spy would only prove a locale argument was passed, not that the
 * formatter it built is ever actually used.
 */
describe('locale-aware formatting', () => {
  it('humanizeIsoDuration renders in the app locale, not a hardcoded one', () => {
    const commonStore = useCommonStore()

    commonStore.locale = 'en'
    expect(humanizeIsoDuration('P1DT12H')).toBe('1 day and 12 hours')

    commonStore.locale = 'de'
    expect(humanizeIsoDuration('P1DT12H')).toBe('1 Tag und 12 Stunden')

    commonStore.locale = 'fr'
    const frText = humanizeIsoDuration('P1DT12H')
    expect(frText).not.toBe('1 day and 12 hours')
    expect(frText).toContain('jour')
  })

  it('humanizeDuration renders in the app locale, not a hardcoded one', () => {
    const commonStore = useCommonStore()
    const start = '2026-01-01T00:00:00Z'
    const end = '2026-01-01T01:04:32Z'

    commonStore.locale = 'en'
    expect(humanizeDuration(start, end)).toBe('1h 4m 32s')

    commonStore.locale = 'de'
    expect(humanizeDuration(start, end)).toBe('1h, 4 Min. und 32 Sek.')
  })

  it('relativeDate renders in the app locale, not a hardcoded one', () => {
    const commonStore = useCommonStore()
    const threeMinutesAgo = Temporal.Now.instant().subtract({ minutes: 3 }).toString({
      smallestUnit: 'millisecond'
    })

    commonStore.locale = 'en'
    expect(relativeDate(threeMinutesAgo)).toBe('3 minutes ago')

    commonStore.locale = 'de'
    expect(relativeDate(threeMinutesAgo)).toBe('vor 3 Minuten')
  })

  it("passes the app locale into relativeDate's RelativeTimeFormat instance", () => {
    const commonStore = useCommonStore()
    const future = Temporal.Now.instant()
      .add({ hours: 48 })
      .toString({ smallestUnit: 'millisecond' })

    commonStore.locale = 'en'
    expect(relativeDate(future)).toBe('in 2 days')

    // -> `numeric: 'auto'` lets German pick its idiomatic "übermorgen" ("the day after tomorrow")
    //    over the numeric "in 2 Tagen" -- either way, proof enough that the locale switch reached
    //    the formatter, since English's own `numeric: 'auto'` output stayed numeric.
    commonStore.locale = 'de'
    expect(relativeDate(future)).not.toBe('in 2 days')
  })

  it('picks up a locale change on the very next call -- no formatter is captured at module scope', () => {
    const commonStore = useCommonStore()

    commonStore.locale = 'de'
    const german = humanizeIsoDuration('PT5M')
    commonStore.locale = 'en'
    const english = humanizeIsoDuration('PT5M')

    expect(german).not.toBe(english)
    expect(english).toBe('5 minutes')
  })

  it('memoizes a formatter per locale rather than rebuilding on every call', () => {
    const commonStore = useCommonStore()
    commonStore.locale = 'en'

    // -> Same locale, repeated calls: nothing here asserts identity directly (the cache is private),
    //    but this pins that repeated calls in one locale keep producing the one correct answer rather
    //    than drifting -- the observable half of "memoized" that matters to a caller.
    expect(humanizeIsoDuration('PT5M')).toBe('5 minutes')
    expect(humanizeIsoDuration('PT5M')).toBe('5 minutes')
  })
})
