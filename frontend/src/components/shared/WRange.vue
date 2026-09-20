<template>
  <div
    ref="trackEl"
    class="w-range relative h-[18px] w-full cursor-pointer select-none"
    :class="[isDisabled ? 'pointer-events-none opacity-60' : '', label ? 'mb-7' : '']"
    @pointerdown="onPointerDown">
    <!-- Rail -->
    <div class="absolute top-1/2 h-0.5 w-full -translate-y-1/2 bg-hairline dark:bg-hairline-dark" />

    <!-- Selected span -->
    <div
      class="absolute top-1/2 h-0.5 -translate-y-1/2"
      :style="{
        left: `${toPercent(model.min)}%`,
        width: `${toPercent(model.max) - toPercent(model.min)}%`,
        backgroundColor: `var(--color-${color})`
      }" />

    <!-- Step markers -->
    <template v-if="markers">
      <div
        v-for="value of steps"
        :key="value"
        class="bg-rule dark:bg-border-dark absolute top-[13px] h-1 w-px -translate-x-1/2"
        :style="{ left: `${toPercent(value)}%` }" />
    </template>

    <button
      v-for="handle of single ? ['max'] : ['min', 'max']"
      :key="handle"
      type="button"
      role="slider"
      class="w-unstyled absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-grab transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 active:cursor-grabbing"
      :style="{ left: `${toPercent(model[handle])}%`, backgroundColor: `var(--color-${color})` }"
      :aria-label="single ? ariaLabel : handle === 'min' ? ariaLabelMin : ariaLabelMax"
      :aria-valuemin="handle === 'min' ? min : model.min"
      :aria-valuemax="handle === 'min' ? model.max : max"
      :aria-valuenow="model[handle]"
      :aria-valuetext="labelFor(handle)"
      :disabled="isDisabled"
      :aria-disabled="isDisabled || undefined"
      @keydown="onKeydown(handle, $event)">
      <!--
        -> `left-1/2` pairs with `-translate-x-1/2` and stays physical: the translate half never
           mirrors under RTL, so swapping only `left` for `start` would pull the label off-centre.
      -->
      <span
        v-if="label"
        class="pointer-events-none absolute top-full left-1/2 mt-1 -translate-x-1/2 px-1.5 py-0.5 text-caption whitespace-nowrap text-white"
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
 * Values always snap to whole steps: both uses are small integer scales (a heading-depth range, a
 * folder-depth filter) where a fractional value would be meaningless, so there is no continuous mode.
 *
 * `modelValue` is `{ min, max }` with two handles bounding a span, or a plain `Number` under
 * `single`; `update:modelValue` emits whichever shape it was given.
 */
const props = defineProps({
  modelValue: {
    type: [Object, Number],
    default: null
  },
  single: {
    type: Boolean,
    default: false
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
  leftLabelValue: {
    type: String,
    default: null
  },
  rightLabelValue: {
    type: String,
    default: null
  },
  labelValue: {
    type: String,
    default: null
  },
  markers: {
    type: Boolean,
    default: false
  },
  disabled: {
    type: Boolean,
    default: false
  },
  ariaLabelMin: {
    type: String,
    default: null
  },
  ariaLabelMax: {
    type: String,
    default: null
  },
  ariaLabel: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['update:modelValue'])

const trackEl = ref(null)
/** Which handle the current drag is moving. */
const dragging = ref(null)

const isDisabled = computed(() => props.disabled)

const model = computed(() => {
  if (props.single) {
    // -> The single handle is always stored as `max`, with `min` pinned to `props.min`: that keeps
    //    the rail's selected-span fill, `toPercent` and the aria wiring free of a single-mode branch.
    return { min: props.min, max: clamp(props.modelValue ?? props.min) }
  }
  return {
    min: clamp(props.modelValue?.min ?? props.min),
    max: clamp(props.modelValue?.max ?? props.max)
  }
})

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
    return props.labelValue ?? String(model.value.max)
  }
  const override = handle === 'min' ? props.leftLabelValue : props.rightLabelValue
  return override ?? String(model.value[handle])
}

/** In two-handle mode, keeps the two handles from crossing over. */
function update(handle, value) {
  if (props.single) {
    const next = clamp(value)
    if (next !== model.value.max) {
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
  // -> With two handles, grab whichever is nearer the press, so a click anywhere on the rail works.
  dragging.value = props.single
    ? 'max'
    : Math.abs(value - model.value.min) <= Math.abs(value - model.value.max)
      ? 'min'
      : 'max'
  update(dragging.value, value)

  // -> `trackPointerDrag` owns pointer capture, the move listener and their teardown; the grabbed
  //    handle is this control's own state, so it is released here
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
  update(handle, model.value[handle] + delta)
}
</script>
