/**
 * Date and duration rendering shared across the app, in the reader's own locale.
 *
 * Shared because several screens had grown their own copy of the same walk down a units table -- one
 * of them under a different name -- and the copies had already started to drift. What stays local to a
 * screen is ABSOLUTE formatting where the precision itself is the point (the scheduler and the webhook
 * history dialog spell out seconds, where most tables don't) -- everything else goes through
 * `humanizeDate` below, which honours the reader's own timezone/date/time preferences rather than the
 * browser's system zone.
 *
 * `Intl` rather than a formatting library: the browser already knows how the reader's locale words
 * "3 minutes ago" and "1h 4m 32s", which is what luxon's `toRelative()` and `Duration.toHuman()` were
 * here for.
 */

import { useUserStore } from '@/stores/user'

/*
  Largest first, so the first unit the difference clears is the one it reads best in. `week` is
  deliberately absent, so output reads e.g. "21 days ago".
*/
const RELATIVE_UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1]
]

const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/**
 * How long ago a moment was, or how far off it still is.
 *
 * Reads both ways on purpose: past for history, future for a job still waiting its turn.
 *
 * @param {string|null} value An ISO instant, as the API returns.
 * @returns {string} e.g. `3 minutes ago`, `in 2 days`, or `---` for nothing at all.
 */
export function relativeDate(value) {
  if (!value) {
    return '---'
  }
  const seconds = Temporal.Instant.from(value).until(Temporal.Now.instant()).total('seconds')
  for (const [unit, secondsPerUnit] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= secondsPerUnit || unit === 'second') {
      return relativeTimeFormat.format(-Math.round(seconds / secondsPerUnit), unit)
    }
  }
}

/** Narrow, largest-first and skipping empty units — "1h 4m 32s", or "820ms" for a quick job. */
const DURATION_UNITS = ['hour', 'minute', 'second', 'millisecond']
const durationListFormat = new Intl.ListFormat(undefined, { style: 'narrow', type: 'unit' })

/**
 * How long something took.
 *
 * @param {string|null} start An ISO instant.
 * @param {string|null} end An ISO instant.
 * @returns {string} e.g. `1h 4m 32s`, or `---` when either end is missing.
 */
export function humanizeDuration(start, end) {
  if (!start || !end) {
    return '---'
  }
  const dur = Temporal.Instant.from(start).until(Temporal.Instant.from(end)).round({
    largestUnit: 'hour',
    smallestUnit: 'millisecond'
  })
  const parts = DURATION_UNITS.filter((unit) => dur[`${unit}s`] > 0).map((unit) =>
    new Intl.NumberFormat(undefined, {
      style: 'unit',
      unit,
      unitDisplay: 'narrow'
    }).format(dur[`${unit}s`])
  )
  // -> Something that took under a millisecond still has to render as something
  return parts.length > 0 ? durationListFormat.format(parts) : '0ms'
}

/**
 * Wide, largest-first -- "1 day, 12 hours" rather than `humanizeDuration`'s narrow "1d 12h". This is
 * for a module's own sync interval (e.g. `PT5M`), read by an admin deciding whether to override it, not
 * a job timing where density matters more than words.
 */
const ISO_DURATION_UNITS = ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds']
const isoDurationListFormat = new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' })

/**
 * How long an ISO-8601 duration is, in words.
 *
 * @param {string|false|null} value An ISO-8601 duration such as `PT5M`, or `false`/null for "no
 *   schedule" (a module that only ever acts on write).
 * @returns {string} e.g. `5 minutes`, `1 day, 12 hours`, or `---` for nothing at all.
 */
export function humanizeIsoDuration(value) {
  if (!value) {
    return '---'
  }
  const dur = Temporal.Duration.from(value)
  const parts = ISO_DURATION_UNITS.filter((unit) => dur[unit] > 0).map((unit) =>
    new Intl.NumberFormat(undefined, {
      style: 'unit',
      unit: unit.slice(0, -1),
      unitDisplay: 'long'
    }).format(dur[unit])
  )
  return parts.length > 0 ? isoDurationListFormat.format(parts) : '0 seconds'
}

/**
 * A moment as this reader asked to see it -- their stored date pattern, 12h/24h choice and timezone --
 * rather than the browser's own system zone and locale-default format. This is the shared replacement
 * for the screens that used to hand-roll `toLocaleString(undefined, { dateStyle: 'medium', timeStyle:
 * 'short' })` (or an equivalent walk over `Temporal` parts) themselves.
 *
 * @param {Function} t The i18n translate function -- date/time word order is locale-dependent.
 * @param {string|Date|Temporal.Instant|null} value A moment, as the API returns it.
 * @returns {string} e.g. `24/08/2026 at 14:32`, or `---` for nothing at all.
 */
export function humanizeDate(t, value) {
  if (!value) {
    return '---'
  }
  return useUserStore().formatDateTime(t, value)
}
