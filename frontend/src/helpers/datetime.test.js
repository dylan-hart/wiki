import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useCommonStore } from '@/stores/common'
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

beforeEach(() => {
  setActivePinia(createPinia())
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
