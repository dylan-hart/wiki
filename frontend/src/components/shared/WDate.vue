<template>
  <div
    class="w-date inline-block rounded p-3"
    :class="bordered ? 'border border-hairline dark:border-hairline-dark' : ''"
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
      <!-- Blank cells so the 1st lands under its own column; `aria-hidden`, they announce nothing. -->
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
 * A month grid with range selection and nothing else -- the months/years navigation views, multiple
 * selection, event markers and min/max limits the calendar this replaces offered have no caller.
 *
 * Dates are plain `YYYY-MM-DD` strings throughout. A calendar day is a civil date with no time
 * zone, and routing it through `Date` is what makes pickers hand back the previous day for users
 * west of UTC.
 */
const props = defineProps({
  /** `'YYYY-MM-DD'`, or `{ from, to }` when `range`. */
  modelValue: {
    type: [String, Object],
    default: null
  },
  range: {
    type: Boolean,
    default: false
  },
  bordered: {
    type: Boolean,
    default: false
  },
  ariaLabel: {
    type: String,
    default: null
  },
  previousMonthLabel: {
    type: String,
    default: null
  },
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

function iso(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const selectedFrom = computed(() =>
  props.range ? (props.modelValue?.from ?? null) : (props.modelValue ?? null)
)
const selectedTo = computed(() => (props.range ? (props.modelValue?.to ?? null) : null))

/** The month on screen. */
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
 * Without this, a `modelValue` set after mount leaves the calendar on the month it opened with and
 * the selection off-screen.
 *
 * `selectedFrom` specifically, not a deep watch on `modelValue`: a `to`-only edit leaves `from`
 * untouched, so the view stays put instead of yanking to the end date. Reacting to nothing but
 * `selectedFrom` is also what leaves `shiftMonth()` free to navigate away afterwards.
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
/** `dayOfWeek` is 1 (Monday) to 7 (Sunday), so the week starts on Monday here. */
const leadingBlanks = computed(() => monthStart.value.dayOfWeek - 1)

const monthLabel = computed(() =>
  monthStart.value.toLocaleString(commonStore.locale, { month: 'long', year: 'numeric' })
)

/**
 * A Monday, so adding 0..6 days walks a full week. Fixed and unrelated to the month on screen: it
 * exists only to give each header cell a real date to ask for a localized weekday name.
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
 * Two-click cycle: the first click starts a range, the second closes it, and a second click before
 * the first date reverses the pair rather than rejecting it.
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
