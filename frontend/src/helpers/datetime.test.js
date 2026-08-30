import { describe, expect, it } from 'vitest'
import { humanizeDuration, humanizeIsoDuration, relativeDate } from './datetime.js'

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
