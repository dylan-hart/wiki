<template>
  <div
    class="w-date inline-block rounded p-3"
    :class="bordered ? 'border border-black/12 dark:border-white/15' : ''"
    role="group"
    :aria-label="resolvedAriaLabel">
    <div class="mb-2 flex items-center justify-between gap-2">
      <w-btn
        flat
        dense
        round
        icon="tabler:chevron-left"
        :aria-label="resolvedPreviousMonthLabel"
        @click="shiftMonth(-1)" />
      <div class="text-body2 font-medium">{{ monthLabel }}</div>
      <w-btn
        flat
        dense
        round
        icon="tabler:chevron-right"
        :aria-label="resolvedNextMonthLabel"
        @click="shiftMonth(1)" />
    </div>

    <div class="grid grid-cols-7 gap-0.5" role="grid">
      <div
        v-for="d of weekdayLabels"
        :key="d"
        class="text-center text-caption text-black/54 dark:text-white/60"
        aria-hidden="true">
        {{ d }}
      </div>
      <!--
        A blank cell per leading weekday, so the first of the month lands under its own column.
        `aria-hidden` because an empty grid cell announces as nothing useful.
      -->
      <div v-for="n of leadingBlanks" :key="`b${n}`" aria-hidden="true" />
      <button
        v-for="day of daysInMonth"
        :key="day"
        type="button"
        class="w-date__day flex h-8 cursor-pointer items-center justify-center text-body2 transition-colors"
        :class="dayClasses(day)"
        :aria-pressed="String(isSelected(day))"
        :aria-label="labelFor(day)"
        @click="pick(day)">
        {{ day }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import WBtn from './WBtn.vue'
import { useDictText } from '@/composables/i18nText'
import { useCommonStore } from '@/stores/common'

/**
 * Calendar for picking a single date, or a date range with `range`.
 *
 * The model is an ISO `YYYY-MM-DD` string, or for a range `{ from, to }` of them -- the same shape
 * the caller already stores, so nothing around it changes.
 *
 * Simplification: the calendar this replaces also did months/years navigation views, multiple
 * selection, event markers, min/max limits and its own title bar. The one caller picks a publishing
 * window, so this is a month grid with range selection and nothing else.
 *
 * Dates are handled as plain `YYYY-MM-DD` strings throughout. A calendar day is a civil date with
 * no time zone, and routing it through `Date` is what makes pickers hand back the previous day for
 * users west of UTC.
 */
const props = defineProps({
  /** `'YYYY-MM-DD'`, or `{ from, to }` when `range`. */
  modelValue: {
    type: [String, Object],
    default: null
  },
  /** Select a start and an end rather than a single day. */
  range: {
    type: Boolean,
    default: false
  },
  bordered: {
    type: Boolean,
    default: false
  },
  /** Falls back to the `common.date.chooseDate` dictionary entry when not given. */
  ariaLabel: {
    type: String,
    default: null
  },
  /** Accessible name for the previous-month control. Falls back to `common.date.previousMonth`. */
  previousMonthLabel: {
    type: String,
    default: null
  },
  /** Accessible name for the next-month control. Falls back to `common.date.nextMonth`. */
  nextMonthLabel: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['update:modelValue'])

const dictText = useDictText()
const resolvedAriaLabel = computed(
  () => props.ariaLabel ?? dictText('common.date.chooseDate', 'Choose a date')
)
const resolvedPreviousMonthLabel = computed(
  () => props.previousMonthLabel ?? dictText('common.date.previousMonth', 'Previous month')
)
const resolvedNextMonthLabel = computed(
  () => props.nextMonthLabel ?? dictText('common.date.nextMonth', 'Next month')
)

const commonStore = useCommonStore()

/** `YYYY-MM-DD` for a year/month/day triple, zero-padded. */
function iso(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const selectedFrom = computed(() =>
  props.range ? (props.modelValue?.from ?? null) : (props.modelValue ?? null)
)
const selectedTo = computed(() => (props.range ? (props.modelValue?.to ?? null) : null))

/** The month on screen. Starts on the selection, or today when there is none. */
const anchor = ref(
  (() => {
    const start = selectedFrom.value
    if (start) {
      const [y, m] = start.split('-').map(Number)
      return { year: y, month: m }
    }
    const today = Temporal.Now.plainDateISO()
    return { year: today.year, month: today.month }
  })()
)

/**
 * Re-sync the visible month whenever the selection's start date changes -- a `modelValue` set
 * after mount, or set programmatically by the parent, otherwise leaves the calendar showing
 * whatever month it opened on with the selection off-screen.
 *
 * Watches `selectedFrom` specifically rather than deep-watching `modelValue`: in range mode, a
 * `to`-only edit (the second click of the two-click cycle in `pick()`) leaves `from` untouched, so
 * this does not fire for it and the view stays put instead of yanking to the end date. It also
 * never reads or writes `anchor` except in reaction to `selectedFrom` itself, so `shiftMonth()`
 * remains free to navigate away afterwards without this watcher snapping the view back.
 */
watch(selectedFrom, (start) => {
  if (!start) {
    return
  }
  const [year, month] = start.split('-').map(Number)
  anchor.value = { year, month }
})

const monthStart = computed(() =>
  Temporal.PlainDate.from({ year: anchor.value.year, month: anchor.value.month, day: 1 })
)
const daysInMonth = computed(() => monthStart.value.daysInMonth)
/** `dayOfWeek` is 1 (Monday) to 7 (Sunday), so this is how many blanks precede the 1st. */
const leadingBlanks = computed(() => monthStart.value.dayOfWeek - 1)

const monthLabel = computed(() =>
  monthStart.value.toLocaleString(commonStore.locale, { month: 'long', year: 'numeric' })
)

/**
 * 2024-01-01 was a Monday, so adding 0..6 days to it walks Monday through Sunday for whatever locale
 * is active -- a fixed reference week, unrelated to `anchor`/the month actually on screen, picked
 * purely so each of the 7 header cells has a real date to ask `toLocaleString` for a weekday name.
 */
const WEEKDAY_REFERENCE = Temporal.PlainDate.from('2024-01-01')

const weekdayLabels = computed(() =>
  Array.from({ length: 7 }, (_, i) =>
    WEEKDAY_REFERENCE.add({ days: i }).toLocaleString(commonStore.locale, { weekday: 'short' })
  )
)

function shiftMonth(delta) {
  const next = monthStart.value.add({ months: delta })
  anchor.value = { year: next.year, month: next.month }
}

function dateOf(day) {
  return iso(anchor.value.year, anchor.value.month, day)
}

function labelFor(day) {
  return monthStart.value.with({ day }).toLocaleString(commonStore.locale, { dateStyle: 'long' })
}

function isSelected(day) {
  const d = dateOf(day)
  return d === selectedFrom.value || d === selectedTo.value
}

/** Strictly inside the range -- the ends are drawn as the selected caps instead. */
function isInRange(day) {
  if (!props.range || !selectedFrom.value || !selectedTo.value) {
    return false
  }
  const d = dateOf(day)
  return d > selectedFrom.value && d < selectedTo.value
}

function dayClasses(day) {
  if (isSelected(day)) {
    return 'rounded bg-primary text-white'
  }
  if (isInRange(day)) {
    return 'bg-primary/15'
  }
  return 'rounded hover:bg-black/8 dark:hover:bg-white/14'
}

/**
 * Range selection is the usual two-click cycle: the first click starts a new range, the second
 * closes it, and a second click before the first date reverses the pair rather than rejecting it.
 */
function pick(day) {
  const d = dateOf(day)
  if (!props.range) {
    emit('update:modelValue', d)
    return
  }
  const { from, to } = props.modelValue ?? {}
  if (!from || to) {
    emit('update:modelValue', { from: d, to: null })
    return
  }
  emit('update:modelValue', d < from ? { from: d, to: from } : { from, to: d })
}
</script>
