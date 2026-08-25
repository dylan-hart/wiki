import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useCommonStore } from '@/stores/common'

import { humanizeDuration, humanizeIsoDuration, relativeDate } from './datetime.js'

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

/*
  Pins WP #1600: every `Intl.*Format` instance in datetime.js is built from `commonStore.locale`, and
  built lazily rather than captured once at module scope -- proven here by switching
  `commonStore.locale` mid-test-run (the module was imported exactly once, at the top of this file)
  and observing later calls follow the new locale instead of staying pinned to whatever locale was
  active the first time a formatter for that key was built.
*/
describe('locale-aware formatting', () => {
  it("passes the app locale into humanizeIsoDuration's NumberFormat and ListFormat instances", () => {
    const commonStore = useCommonStore()

    commonStore.locale = 'en'
    expect(humanizeIsoDuration('P1DT12H')).toBe('1 day and 12 hours')

    commonStore.locale = 'fr'
    const frText = humanizeIsoDuration('P1DT12H')
    expect(frText).not.toBe('1 day and 12 hours')
    expect(frText).toContain('jour')
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

  it('re-reads the locale on every call, not once at module import time', () => {
    const commonStore = useCommonStore()

    // -> A locale switch AFTER this module was first imported still takes effect immediately --
    //    the behavior a module-scope `new Intl.ListFormat(undefined, ...)` singleton could never have.
    commonStore.locale = 'de'
    const deText = humanizeIsoDuration('PT5M')
    commonStore.locale = 'en'
    const enText = humanizeIsoDuration('PT5M')

    expect(deText).not.toBe(enText)
    expect(enText).toBe('5 minutes')
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
