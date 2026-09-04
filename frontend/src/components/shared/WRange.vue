<template>
  <div
    ref="trackEl"
    class="w-range relative h-6 w-full cursor-pointer select-none"
    :class="[isDisabled ? 'pointer-events-none opacity-60' : '', label ? 'mb-7' : '']"
    @pointerdown="onPointerDown">
    <!-- Rail -->
    <div
      class="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-black/24 dark:bg-white/30" />

    <!-- Selected span -->
    <div
      class="absolute top-1/2 h-1 -translate-y-1/2 rounded-full"
      :style="{
        left: `${toPercent(spanMin)}%`,
        width: `${toPercent(spanMax) - toPercent(spanMin)}%`,
        backgroundColor: `var(--color-${color})`
      }" />

    <!-- Step markers -->
    <template v-if="markers">
      <div
        v-for="value of steps"
        :key="value"
        class="absolute top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/38 dark:bg-white/50"
        :style="{ left: `${toPercent(value)}%` }" />
    </template>

    <button
      v-for="handle of handles"
      :key="handle"
      type="button"
      role="slider"
      class="w-unstyled absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full shadow-card transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 active:cursor-grabbing"
      :style="{
        left: `${toPercent(currentValueFor(handle))}%`,
        backgroundColor: `var(--color-${color})`
      }"
      :aria-label="handle === 'max' ? ariaLabelMax : ariaLabelMin"
      :aria-valuemin="handle === 'max' ? model.min : min"
      :aria-valuemax="handle === 'min' ? model.max : max"
      :aria-valuenow="currentValueFor(handle)"
      :aria-valuetext="labelFor(handle)"
      :disabled="isDisabled"
      :aria-disabled="isDisabled || undefined"
      @keydown="onKeydown(handle, $event)">
      <!--
        -> `left-1/2 -translate-x-1/2` centers this label under its handle (OpenProject #1590's
           physical-positioning triage), the same symmetric-centering-vs-physical-translate pairing
           as `WNotifications`'s toast stack -- swapping only the `left` half to `start` would pull
           the label off-centre, since `-translate-x-1/2` never mirrors under RTL.

           The rest of this component -- rail, selected span, step markers, and the handles' own
           `left: ${toPercent(...)}%` above -- is a numeric min/max scale rather than a leading/
           trailing gutter, and stays physical for the same reason `WMenu`/`WTooltip`'s
           viewport-relative pixel positioning does: making it direction-aware is a coordinated
           redesign of `toPercent()` and every `left:` here together, not a mechanical swap, so it
           is deliberately out of this triage's scope rather than converted piecemeal.
      -->
      <span
        v-if="label"
        class="pointer-events-none absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded px-1.5 py-0.5 text-caption whitespace-nowrap text-white"
        :style="{ backgroundColor: `var(--color-${color})` }">
        {{ labelFor(handle) }}
      </span>
    </button>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { trackPointerDrag } from '@/helpers/pointerDrag'

/**
 * Range selector over a small integer scale: two draggable handles by default, or one with
 * `single` (OpenProject #2524, added so the graph depth control -- OpenProject #2525 -- reuses this
 * component's track/step-marker/pointer-drag/keyboard mechanics rather than a second hand-rolled
 * slider).
 *
 * The two-handle model is `{ min, max }`, matching the shape the config object already stores; the
 * single-handle model (`single: true`) is a plain number instead. Values always snap to whole steps
 * -- the two known uses are a heading-depth range (H1..H6) and a folder-depth cutoff, where a
 * fractional value would be meaningless -- so there is no continuous mode either way.
 */
const props = defineProps({
  /** `{ min, max }` in the default two-handle mode, or a plain number when `single` is set. */
  modelValue: {
    type: [Object, Number],
    default: () => ({ min: 0, max: 0 })
  },
  min: {
    type: Number,
    default: 0
  },
  max: {
    type: Number,
    default: 100
  },
  color: {
    type: String,
    default: 'primary'
  },
  /** Shows a value bubble above each handle. */
  label: {
    type: Boolean,
    default: false
  },
  /** Overrides the text of the lower handle's bubble (the only handle's, in single mode). */
  leftLabelValue: {
    type: String,
    default: null
  },
  /** Overrides the text of the upper handle's bubble. Unused in single mode. */
  rightLabelValue: {
    type: String,
    default: null
  },
  /** Draws a dot at every step. */
  markers: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  /** The lower (or, in single mode, the only) handle's accessible name. */
  ariaLabelMin: {
    type: String,
    default: null
  },
  /** The upper handle's accessible name. Unused in single mode. */
  ariaLabelMax: {
    type: String,
    default: null
  },
  /** One draggable handle over `[min, max]` instead of two -- no text/value renders inside it
   *  (`label` still draws its bubble if set); a value display alongside the control is the caller's
   *  own, separate element. `modelValue` is a plain number in this mode, not `{ min, max }`. */
  single: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:modelValue'])

const trackEl = ref(null)
/** Which handle the current drag is moving -- `'value'` in single mode, `'min'`/`'max'` otherwise. */
const dragging = ref(null)

const isDisabled = computed(() => props.disabled)

const handles = computed(() => (props.single ? ['value'] : ['min', 'max']))

/** Two-handle model, always `{ min, max }` -- unused for positioning in single mode (see
 *  `singleValue`/`currentValueFor` below), but still read for the OTHER handle's own aria bound in
 *  two-handle mode, so it stays defined regardless of `single`. */
const model = computed(() => ({
  min: clamp(props.modelValue?.min ?? props.min),
  max: clamp(props.modelValue?.max ?? props.max)
}))

/** Single-handle model: the one clamped value. A caller that leaves `modelValue` at the two-handle
 *  default object (rather than a number) falls back to `props.min` here instead of clamping into
 *  `NaN`. */
const singleValue = computed(() =>
  clamp(typeof props.modelValue === 'number' ? props.modelValue : props.min)
)

function currentValueFor(handle) {
  return props.single ? singleValue.value : model.value[handle]
}

/** The rail's filled span: `[min, singleValue]` (a progress-style fill up to the one handle) in
 *  single mode, `[model.min, model.max]` otherwise. */
const spanMin = computed(() => (props.single ? props.min : model.value.min))
const spanMax = computed(() => (props.single ? singleValue.value : model.value.max))

const steps = computed(() =>
  Array.from({ length: props.max - props.min + 1 }, (_, i) => props.min + i)
)

function clamp(value) {
  return Math.min(props.max, Math.max(props.min, Math.round(value)))
}

function toPercent(value) {
  const span = props.max - props.min
  return span === 0 ? 0 : ((clamp(value) - props.min) / span) * 100
}

function labelFor(handle) {
  if (props.single) {
    return props.leftLabelValue ?? String(singleValue.value)
  }
  const override = handle === 'min' ? props.leftLabelValue : props.rightLabelValue
  return override ?? String(model.value[handle])
}

/** Writes the current handle. Two-handle mode keeps the two from crossing over (unchanged); single
 *  mode has only one value to clamp and emit, as a plain number rather than `{ min, max }`. */
function update(handle, value) {
  if (props.single) {
    const next = clamp(value)
    if (next !== singleValue.value) {
      emit('update:modelValue', next)
    }
    return
  }
  const next = { ...model.value }
  next[handle] =
    handle === 'min' ? Math.min(clamp(value), next.max) : Math.max(clamp(value), next.min)
  if (next.min !== model.value.min || next.max !== model.value.max) {
    emit('update:modelValue', next)
  }
}

function valueAt(clientX) {
  const rect = trackEl.value.getBoundingClientRect()
  const ratio = rect.width === 0 ? 0 : (clientX - rect.left) / rect.width
  return props.min + ratio * (props.max - props.min)
}

function onPointerDown(ev) {
  const value = valueAt(ev.clientX)
  // -> Single mode has only the one handle to grab; two-handle mode grabs whichever handle is
  //    nearer to the press, so a click anywhere on the rail works.
  dragging.value = props.single
    ? 'value'
    : Math.abs(value - model.value.min) <= Math.abs(value - model.value.max)
      ? 'min'
      : 'max'
  update(dragging.value, value)

  // -> Pointer capture, the move listener and its teardown are shared with WColorPicker; the handle
  //    this gesture grabbed is the one thing that is this control's own, so it is released here
  const el = ev.currentTarget
  trackPointerDrag(ev, el, (e) => {
    if (dragging.value) {
      update(dragging.value, valueAt(e.clientX))
    }
  })
  el.addEventListener('pointerup', releaseHandle, { once: true })
  el.addEventListener('pointercancel', releaseHandle, { once: true })
}

function releaseHandle() {
  dragging.value = null
}

const KEY_STEPS = {
  ArrowLeft: -1,
  ArrowDown: -1,
  ArrowRight: 1,
  ArrowUp: 1,
  PageDown: -1,
  PageUp: 1
}

function onKeydown(handle, ev) {
  if (isDisabled.value) {
    return
  }
  if (ev.key === 'Home' || ev.key === 'End') {
    ev.preventDefault()
    update(handle, ev.key === 'Home' ? props.min : props.max)
    return
  }
  const delta = KEY_STEPS[ev.key]
  if (delta === undefined) {
    return
  }
  ev.preventDefault()
  update(handle, currentValueFor(handle) + delta)
}
</script>
