import { useCommonStore } from '@/stores/common'

/**
 * Date and duration rendering shared across the app, in the reader's own locale.
 *
 * Shared because several screens had grown their own copy of the same walk down a units table — some
 * under a different name — and the copies had already started to drift. `humanizeDate` and
 * `humanizeDateWithSeconds` below close a second, larger case of the same drift: fifteen-plus screens
 * had each grown their own ABSOLUTE-timestamp formatter, calling
 * `Temporal.Instant.prototype.toLocaleString` directly with a hardcoded field list in the browser's
 * system zone — ignoring the `timezone`, `dateFormat` and `timeFormat` a user actually chose in their
 * profile. Both delegate to `userStore.formatDateTime`, the single source
 * of truth for those three preferences (built on `toUserZone`, `stores/user.js:39-52`) — this file just
 * adds the `'---'` guard every call site wants and gives the delegation one importable name, so a
 * screen no longer needs its own `humanizeDate(val) { … }` wrapper just to pass `t` through.
 * `humanizeDateWithSeconds` exists because a few screens — the scheduler and the webhook delivery
 * history among them — have the job/attempt's exact timing as the point of the row, where the default
 * minute precision would be a regression.
 *
 * `Intl` rather than a formatting library: the browser already knows how the reader's locale words
 * "3 minutes ago" and "1h 4m 32s", which is what luxon's `toRelative()` and `Duration.toHuman()` were
 * here for.
 *
 * Every `Intl.*Format` instance below is built lazily, on first use for the app's *current* locale
 * (`commonStore.locale`) rather than at module scope with the locale simply omitted -- a module-scope
 * singleton is built once, at import time, and can never see a later `setLocale()` call, and omitting
 * the locale argument hands the choice to the browser instead of the app's own setting. `getFormatter`
 * memoizes per `(key, locale)` pair so a screen re-rendering in the same locale reuses the same
 * instance, while a locale switch (`commonStore.setLocale()`) transparently builds -- and from then on
 * reuses -- a fresh one instead of ever reformatting through a stale-locale formatter.
 */
import { useUserStore } from '@/stores/user'

/**
 * An absolute moment, in this user's own timezone, date pattern and 12h/24h choice — minute precision.
 *
 * @param t The screen's `useI18n()` translator, for `common.datetime`'s word order.
 * @param value A `Temporal.Instant`, a `Date`, or a string one can be parsed from — what the API
 *   returns. Nullable columns are common, so nothing at all renders as the placeholder rather than
 *   blowing up mid-render.
 * @returns {string} e.g. `2026-08-25 at 14:32`, or `---` for nothing at all.
 */
export function humanizeDate(t, value) {
  if (!value) {
    return '---'
  }
  return useUserStore().formatDateTime(t, value)
}

/**
 * Same as `humanizeDate`, with seconds. For the two screens where the precision IS the point — a job's
 * scheduled run (`AdminScheduler.vue`), a webhook delivery attempt (`WebhookHistoryDialog.vue`) —
 * flattening onto the minute-precision `humanizeDate` above would be a regression.
 *
 * @returns {string} e.g. `2026-08-25 at 14:32:07`, or `---` for nothing at all.
 */
export function humanizeDateWithSeconds(t, value) {
  if (!value) {
    return '---'
  }
  return useUserStore().formatDateTime(t, value, { seconds: true })
}

/**
 * Whether a moment has already gone by.
 *
 * Temporal types carry no `valueOf`, so `a < b` throws rather than comparing — `Instant.compare` is
 * the comparison, and `<= 0` puts "exactly now" in the past, which is what an expiry means.
 *
 * @param {string} iso An ISO instant, as the API returns.
 * @returns {boolean}
 */
export function isPast(iso) {
  return Temporal.Instant.compare(Temporal.Instant.from(iso), Temporal.Now.instant()) <= 0
}

const formatterCache = new Map()

/**
 * @param {new (locale: string, options: object) => object} FormatterCtor One of the `Intl.*Format`
 *   constructors.
 * @param {string} key Identifies this formatter's fixed option set (e.g. `'relative'`, or
 *   `'number-unit-narrow:hour'` for a per-unit variant), distinct from the locale it's cached
 *   alongside.
 * @param {object} options Passed straight through to `FormatterCtor`.
 */
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
  const relativeTimeFormat = getFormatter(Intl.RelativeTimeFormat, 'relative', { numeric: 'auto' })
  for (const [unit, secondsPerUnit] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= secondsPerUnit || unit === 'second') {
      return relativeTimeFormat.format(-Math.round(seconds / secondsPerUnit), unit)
    }
  }
}

/** Narrow, largest-first and skipping empty units — "1h 4m 32s", or "820ms" for a quick job. */
const DURATION_UNITS = ['hour', 'minute', 'second', 'millisecond']

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

/**
 * Wide, largest-first -- "1 day, 12 hours" rather than `humanizeDuration`'s narrow "1d 12h". This is
 * for a module's own sync interval (e.g. `PT5M`), read by an admin deciding whether to override it, not
 * a job timing where density matters more than words.
 */
const ISO_DURATION_UNITS = ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds']

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
