<template>
  <div
    class="otp-input-container"
    :class="{ 'pointer-events-none opacity-60': disabled }"
    role="group">
    <input
      v-for="(digit, i) in digits"
      :key="i"
      :ref="(el) => setInputEl(el, i)"
      class="otp-input w-unstyled"
      :class="{ 'is-complete': digit !== '' }"
      type="text"
      inputmode="numeric"
      pattern="[0-9]*"
      maxlength="1"
      :autocomplete="i === 0 ? 'one-time-code' : 'off'"
      :disabled="disabled"
      :value="digit"
      :aria-label="digitAriaLabel(i)"
      @input="onInput(i, $event)"
      @keydown="onKeydown(i, $event)"
      @paste="onPaste(i, $event)"
      @focus="onFocus" />
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useDictText } from '@/composables/i18nText'

/**
 * A one-time-passcode field: N single-character boxes that behave as one value.
 *
 * Replaces `vue3-otp-input` (OpenProject #3166) -- pre-1.0, solo-maintained, and with no maintained
 * alternative on the shelf, which made owning this small surface a better bet than depending on it.
 * The two draw sites this was ported from (`AuthTfaScreens.vue`'s sign-in and setup screens,
 * `SetupTfaDialog.vue`'s profile setup) all want the same thing: a 6-digit numeric TOTP code, so this
 * only ever filters to digits -- there is no `numeric` opt-out prop. `.otp-input` /
 * `.otp-input-container` / `.is-complete` in `css/tailwind.css` are kept as the exact class names the
 * library used to render, on purpose: `AuthTfaScreens.vue`'s own `:deep()` design overrides target
 * those names and needed no changes for the swap.
 *
 * `v-model` is the joined string (`''` for an empty box), not an array -- callers already validate it
 * as a plain 6-digit string (`helpers/tfaCode.js`). `complete` fires once per empty→full transition,
 * not on every keystroke once the value is already full.
 */

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  /** Number of digit boxes. */
  length: {
    type: Number,
    default: 6
  },
  disabled: {
    type: Boolean,
    default: false
  },
  /** Focuses the first box once mounted. */
  autofocus: {
    type: Boolean,
    default: false
  },
  /**
   * Per-digit accessible label template, with `{n}`/`{total}` tokens substituted by hand (this is a
   * plain prop, not a vue-i18n message, so it gets no interpolation of its own). Falls back to
   * `common.otpInput.digitLabel`, itself falling back to English when no `t()` resolves it -- see
   * `useDictText`.
   */
  digitLabel: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['update:modelValue', 'complete'])

/**
 * `value`, split into exactly `length` single-digit (or empty) slots -- extra characters are
 * dropped, a short value is padded with empty slots, and anything not `0`-`9` is stripped, since a
 * box holds one digit or nothing.
 *
 * @param {string} value
 * @param {number} length
 * @returns {string[]}
 */
function splitValue(value, length) {
  const chars = String(value ?? '')
    .replace(/\D/g, '')
    .slice(0, length)
    .split('')
  while (chars.length < length) {
    chars.push('')
  }
  return chars
}

const digits = ref(splitValue(props.modelValue, props.length))
const inputEls = ref([])

function setInputEl(el, i) {
  inputEls.value[i] = el
}

function focusIndex(i) {
  if (i < 0 || i >= props.length) {
    return
  }
  inputEls.value[i]?.focus()
}

function emitValue() {
  emit('update:modelValue', digits.value.join(''))
}

// -> An external reset (a wrong-code retry clearing the field, or the parent re-mounting with a
//    fresh value) rebuilds the boxes from the new value; our own emits round-trip back here with the
//    same joined string already in `digits`, so this never fights its own update.
watch(
  () => props.modelValue,
  (value) => {
    const next = splitValue(value, props.length)
    if (next.join('') !== digits.value.join('')) {
      digits.value = next
    }
  }
)

const isComplete = computed(
  () => digits.value.length === props.length && digits.value.every((d) => d !== '')
)

watch(isComplete, (complete, wasComplete) => {
  if (complete && !wasComplete) {
    emit('complete', digits.value.join(''))
  }
})

// I18N

const dictText = useDictText()

/** `props.digitLabel`, a plain template, is substituted by hand; the dictionary key is real vue-i18n
 *  interpolation (see `useDictText`), which is why its English fallback is passed pre-resolved. */
function digitAriaLabel(i) {
  const n = i + 1
  const total = props.length
  if (props.digitLabel) {
    return props.digitLabel.replaceAll('{n}', String(n)).replaceAll('{total}', String(total))
  }
  return dictText('common.otpInput.digitLabel', `Digit ${n} of ${total}`, { n, total })
}

// METHODS

/**
 * Typed (or autofilled) input. `maxlength="1"` keeps ordinary typing to one character, but IME
 * composition and a mobile autofill dropping a whole code into one box can still hand this more than
 * one -- the extra characters spill into the following boxes exactly as a paste would.
 */
function onInput(i, ev) {
  const filtered = String(ev.target.value ?? '').replace(/\D/g, '')
  if (!filtered) {
    digits.value[i] = ''
    ev.target.value = ''
    emitValue()
    return
  }
  let idx = i
  for (const char of filtered) {
    if (idx >= props.length) {
      break
    }
    digits.value[idx] = char
    idx++
  }
  ev.target.value = digits.value[i]
  emitValue()
  focusIndex(Math.min(idx, props.length - 1))
}

function onKeydown(i, ev) {
  if (ev.key === 'Backspace') {
    ev.preventDefault()
    if (digits.value[i]) {
      digits.value[i] = ''
      emitValue()
    } else if (i > 0) {
      digits.value[i - 1] = ''
      emitValue()
      focusIndex(i - 1)
    }
    return
  }
  if (ev.key === 'ArrowLeft') {
    ev.preventDefault()
    focusIndex(i - 1)
    return
  }
  if (ev.key === 'ArrowRight') {
    ev.preventDefault()
    focusIndex(i + 1)
  }
}

/** A full code pasted (or dropped) anywhere in the row fills from that box onward. */
function onPaste(i, ev) {
  ev.preventDefault()
  const text = ev.clipboardData?.getData('text') ?? ''
  const chars = text.replace(/\D/g, '').split('')
  if (!chars.length) {
    return
  }
  let idx = i
  for (const char of chars) {
    if (idx >= props.length) {
      break
    }
    digits.value[idx] = char
    idx++
  }
  emitValue()
  focusIndex(Math.min(idx, props.length - 1))
}

/** Selects the box's content on focus, so typing (or a re-paste) overwrites rather than appends. */
function onFocus(ev) {
  ev.target.select()
}

onMounted(() => {
  if (props.autofocus) {
    focusIndex(0)
  }
})

defineExpose({
  focus: () => focusIndex(0)
})
</script>
