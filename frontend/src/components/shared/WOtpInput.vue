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
 * Replaces `vue3-otp-input`. `.otp-input` / `.otp-input-container` / `.is-complete` in
 * `css/tailwind.css` keep the exact class names that library rendered, because `AuthTfaScreens.vue`'s
 * `:deep()` design overrides target them. Every draw site wants a numeric TOTP code, so this only
 * ever filters to digits -- there is no opt-out prop.
 */

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  length: {
    type: Number,
    default: 6
  },
  disabled: {
    type: Boolean,
    default: false
  },
  autofocus: {
    type: Boolean,
    default: false
  },
  /** A plain prop, not a vue-i18n message: its `{n}`/`{total}` tokens are substituted by hand. */
  digitLabel: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['update:modelValue', 'complete'])

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

// -> Our own emits round-trip back through this watcher, so compare before rebuilding rather than
//    fighting our own update.
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

const dictText = useDictText()

function digitAriaLabel(i) {
  const n = i + 1
  const total = props.length
  if (props.digitLabel) {
    return props.digitLabel.replaceAll('{n}', String(n)).replaceAll('{total}', String(total))
  }
  return dictText('common.otpInput.digitLabel', `Digit ${n} of ${total}`, { n, total })
}

/**
 * `maxlength="1"` does not stop IME composition or a mobile autofill from dropping a whole code into
 * one box, so extra characters spill into the following boxes exactly as a paste would.
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
