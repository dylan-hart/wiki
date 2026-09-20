import { useCommonStore } from '@/stores/common'

/**
 * Date and duration rendering shared across the app, in the reader's own locale. Every function here
 * takes a nullable value — the API's columns are — and renders `---` rather than throwing mid-render
 * when there is nothing to show.
 *
 * Absolute timestamps delegate to `userStore.formatDateTime`, the single source of truth for the
 * `timezone`, `dateFormat` and `timeFormat` a user chose in their profile; formatting an instant
 * directly would silently ignore all three. Relative times and durations use `Intl`, which already
 * knows how the reader's locale words "3 minutes ago" and "1h 4m 32s".
 *
 * Every `Intl.*Format` instance is built lazily, per `(key, locale)` pair, because a module-scope
 * singleton is built once at import time and can never see a later `commonStore.setLocale()` call.
 * Omitting the locale argument would hand the choice to the browser rather than the app's setting.
 */
import { useUserStore } from '@/stores/user'

/** Minute precision, e.g. `2026-08-25 at 14:32`. */
export function humanizeDate(t, value) {
  if (!value) {
    return '---'
  }
  return useUserStore().formatDateTime(t, value)
}

/** For a row whose exact timing is the point: a scheduled job run, a webhook delivery attempt. */
export function humanizeDateWithSeconds(t, value) {
  if (!value) {
    return '---'
  }
  return useUserStore().formatDateTime(t, value, { seconds: true })
}

/**
 * Temporal types carry no `valueOf`, so `a < b` throws rather than comparing — `Instant.compare` is
 * the comparison, and `<= 0` puts "exactly now" in the past, which is what an expiry means.
 */
export function isPast(iso) {
  return Temporal.Instant.compare(Temporal.Instant.from(iso), Temporal.Now.instant()) <= 0
}

const formatterCache = new Map()

/** `key` identifies the fixed option set, distinct from the locale it is cached alongside. */
function getFormatter(FormatterCtor, key, options) {
  const commonStore = useCommonStore()
  const locale = commonStore.locale
  const cacheKey = `${key}:${locale}`
  let instance = formatterCache.get(cacheKey)
  if (!instance) {
    instance = new FormatterCtor(locale, options)
    formatterCache.set(cacheKey, instance)
  }
  return instance
}

/*
  Largest first, so the first unit the difference clears is the one it reads best in. `week` is
  deliberately absent, so output reads "21 days ago" rather than "3 weeks ago".
*/
const RELATIVE_UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1]
]

/** Reads both ways on purpose: "3 minutes ago" for history, "in 2 days" for a job still to run. */
export function relativeDate(value) {
  if (!value) {
    return '---'
  }
  const seconds = Temporal.Instant.from(value).until(Temporal.Now.instant()).total('seconds')
  const relativeTimeFormat = getFormatter(Intl.RelativeTimeFormat, 'relative', { numeric: 'auto' })
  for (const [unit, secondsPerUnit] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= secondsPerUnit || unit === 'second') {
      return relativeTimeFormat.format(-Math.round(seconds / secondsPerUnit), unit)
    }
  }
}

const DURATION_UNITS = ['hour', 'minute', 'second', 'millisecond']

/** Narrow and dense — "1h 4m 32s" — with empty units skipped. */
export function humanizeDuration(start, end) {
  if (!start || !end) {
    return '---'
  }
  const dur = Temporal.Instant.from(start).until(Temporal.Instant.from(end)).round({
    largestUnit: 'hour',
    smallestUnit: 'millisecond'
  })
  const parts = DURATION_UNITS.filter((unit) => dur[`${unit}s`] > 0).map((unit) =>
    getFormatter(Intl.NumberFormat, `number-unit-narrow:${unit}`, {
      style: 'unit',
      unit,
      unitDisplay: 'narrow'
    }).format(dur[`${unit}s`])
  )
  // -> Something that took under a millisecond still has to render as something
  const durationListFormat = getFormatter(Intl.ListFormat, 'duration-list', {
    style: 'narrow',
    type: 'unit'
  })
  return parts.length > 0 ? durationListFormat.format(parts) : '0ms'
}

const ISO_DURATION_UNITS = ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds']

/**
 * Wide and wordy -- "1 day, 12 hours" rather than `humanizeDuration`'s "1d 12h" -- for a module's
 * sync interval, read by an admin deciding whether to override it.
 *
 * The same field can also hold a raw cron expression (`30 9 * * 1`), which only the server
 * interprets. Anything that fails to parse as an ISO-8601 duration is handed back as-is: a plain but
 * unexplained string tells the reader more than a crash would.
 */
export function humanizeIsoDuration(value) {
  if (!value) {
    return '---'
  }
  let dur
  try {
    dur = Temporal.Duration.from(value)
  } catch {
    return value
  }
  const parts = ISO_DURATION_UNITS.filter((unit) => dur[unit] > 0).map((unit) =>
    getFormatter(Intl.NumberFormat, `number-unit-long:${unit}`, {
      style: 'unit',
      unit: unit.slice(0, -1),
      unitDisplay: 'long'
    }).format(dur[unit])
  )
  const isoDurationListFormat = getFormatter(Intl.ListFormat, 'iso-duration-list', {
    style: 'long',
    type: 'conjunction'
  })
  return parts.length > 0 ? isoDurationListFormat.format(parts) : '0 seconds'
}
