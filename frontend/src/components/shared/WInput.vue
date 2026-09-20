<template>
  <!--
    `class` and `style` are the exception to `inheritAttrs: false`'s forwarding: both are genuinely
    about the FIELD (callers reach for them to size or space the whole field, not the raw control
    inside it), so they go to the frame as `rootClass`/`rootStyle` -- see `controlAttrs`.
  -->
  <w-field-frame
    variant-class="w-input"
    :root-class="attrs.class"
    :root-style="attrs.style"
    :label="label"
    :required="required"
    :hint="hint"
    :label-for="inputId"
    :control-props="controlEvents"
    control-base-class="w-input-control flex flex-nowrap items-center gap-2 rounded-card"
    :control-classes="controlClasses"
    :control-style="controlStyle"
    :shows-bottom="showsBottom"
    :bottom-id="`${inputId}-desc`"
    :error-message="errorMessage">
    <slot name="prepend" />

    <!-- aria-hidden: decoration around the field, not part of what has been typed. -->
    <span
      v-if="prefix"
      aria-hidden="true"
      class="shrink-0 text-text-caption select-none dark:text-text-caption-dark">
      {{ prefix }}
    </span>

    <!--
      cobalt-typography.md §3's "Read-only field value" role: `monospaced` carries the
      size/family/tracking every mono value shares, at weight 400 per the design's own swatch.
      `readonly`'s colour swap stays separate, since a caller can pass `monospaced` on an EDITABLE
      field (a key, a slug) that keeps the ordinary text colour.
    -->
    <component
      :is="type === 'textarea' ? 'textarea' : 'input'"
      v-bind="controlAttrs"
      :id="inputId"
      ref="inputEl"
      :type="type === 'textarea' ? undefined : effectiveType"
      :value="modelValue"
      :placeholder="placeholder"
      :readonly="readonly"
      :disabled="disabled"
      :autocomplete="autocomplete"
      :rows="type === 'textarea' ? rows : undefined"
      :min="min"
      :max="max"
      :step="step"
      :aria-label="label ? undefined : ariaLabel"
      :aria-invalid="hasError || undefined"
      :aria-required="required || undefined"
      :aria-describedby="describedBy"
      class="w-unstyled min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-caption dark:placeholder:text-text-caption-dark"
      :class="[
        monospaced ? 'font-mono text-[13px] leading-[1.4] font-normal tracking-normal' : '',
        readonly ? 'text-text-secondary dark:text-text-secondary-dark' : ''
      ]"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keyup.enter="$emit('keyup:enter', $event)" />

    <!--
      Before the trailing controls rather than after them: the suffix belongs to the value -- the
      closing `/` of a regex, a unit after a number -- so it sits against the text, not beyond the
      clear cross.
    -->
    <span
      v-if="suffix"
      aria-hidden="true"
      class="shrink-0 text-text-caption select-none dark:text-text-caption-dark">
      {{ suffix }}
    </span>

    <!--
      `me-1` on the button rather than more padding on the control: the control's padding is shared
      by every trailing control, and only the eye reads cramped against the field's edge.
    -->
    <button
      v-if="revealable && type === 'password'"
      type="button"
      class="w-unstyled me-1 shrink-0 cursor-pointer opacity-60 hover:opacity-100"
      :aria-label="isRevealed ? resolvedHideLabel : resolvedRevealLabel"
      :aria-pressed="String(isRevealed)"
      @click="isRevealed = !isRevealed">
      <!-- -> A size of its own rather than the control's 1em: at the field's 14px the eye comes out
              smaller than the text beside it, which is not much of a target to aim at -->
      <w-icon :name="isRevealed ? 'tabler:eye-off' : 'tabler:eye'" size="xs" />
    </button>

    <button
      v-if="clearable && String(modelValue ?? '').length > 0"
      type="button"
      class="w-unstyled shrink-0 cursor-pointer opacity-60 hover:opacity-100"
      :aria-label="resolvedClearLabel"
      @click="clear">
      <w-icon name="tabler:x" />
    </button>

    <slot name="append" />
  </w-field-frame>
</template>

<script setup>
import { computed, inject, onMounted, ref, useAttrs, useId, useSlots, watch } from 'vue'
import WFieldFrame from './WFieldFrame.vue'
import { fieldProps, useFieldFrame } from '@/composables/fieldFrame'
import { useDictText } from '@/composables/i18nText'

/**
 * Validation follows the `rules` convention already in the codebase: an array of functions taking
 * the value and returning `true` when valid, or a message string when not.
 *
 * The label, the frame, the hint/error line and the state that colours them are shared with
 * `WSelect` and live in `WFieldFrame.vue` / `composables/fieldFrame.js`. What is here is the
 * `<input>`/`<textarea>` itself and everything only a text field has.
 */

/*
 * The single root is the frame's wrapper `<div>`, not the real control -- an attribute Vue would
 * otherwise land there by default (`name`, `inputmode`, `maxlength`, an `aria-label` a caller
 * passes) does nothing on a `<div>`. `$attrs` is bound explicitly onto the real
 * `<input>`/`<textarea>` below instead. `autofocus` needs more than plain forwarding -- see
 * `fieldProps`.
 */
defineOptions({ inheritAttrs: false })

const props = defineProps({
  ...fieldProps,
  modelValue: {
    type: [String, Number],
    default: ''
  },
  type: {
    type: String,
    default: 'text'
  },
  prefix: {
    type: String,
    default: null
  },
  suffix: {
    type: String,
    default: null
  },
  placeholder: {
    type: String,
    default: null
  },
  /**
   * Drop the field's own surface and let whatever is behind it show through — for a field on a
   * surface that is not flat, such as a translucent (acrylic) menu, where the field's white would
   * sit as an opaque slab on a panel meant to be see-through. Only the fill goes: the border and
   * the focus ring are untouched, so the field is still obviously a field.
   */
  transparent: {
    type: Boolean,
    default: false
  },
  autocomplete: {
    type: String,
    default: null
  },
  rows: {
    type: [String, Number],
    default: 3
  },
  min: {
    type: [String, Number],
    default: undefined
  },
  max: {
    type: [String, Number],
    default: undefined
  },
  step: {
    type: [String, Number],
    default: undefined
  },
  monospaced: {
    type: Boolean,
    default: false
  },
  /**
   * Adds a show/hide toggle to a `type="password"` field. Without it, a value the user never typed
   * -- one filled in by a generate button, say -- can be neither read nor re-entered anywhere.
   */
  revealable: {
    type: Boolean,
    default: false
  },
  revealLabel: {
    type: String,
    default: null
  },
  hideLabel: {
    type: String,
    default: null
  },
  clearable: {
    type: Boolean,
    default: false
  },
  clearLabel: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['update:modelValue', 'keyup:enter', 'focus', 'blur'])

const slots = useSlots()
const attrs = useAttrs()

const inputEl = ref(null)
const inputId = useId()
const hasBlurred = ref(false)
const hasFocus = ref(false)
/** Pointer-over, for the ring: the ring is an inline style, so CSS `:hover` cannot reach it. */
const isHovered = ref(false)
const isRevealed = ref(false)

const hasValue = computed(() => String(props.modelValue ?? '').length > 0)

const hasLeadingAdornment = computed(() => Boolean(slots.prepend || props.prefix))

const { controlStyle, controlClasses, showsBottom, errorMessage, validate } = useFieldFrame({
  props,
  active: hasFocus,
  hovered: isHovered,
  hasValue,
  hasLeadingAdornment,
  /*
    A field carries its own surface rather than borrowing whatever it sits on: white in light mode,
    the panel tone in dark. Flat tones on both sides rather than a translucency, because Cardinal's
    grounds are a known, short list and a field presents the SAME surface on every one of them.
    `transparent` opts out, for the surfaces where that reasoning inverts -- see the prop.
  */
  surface: computed(() => {
    if (props.transparent) {
      return ''
    }
    // -> A read-only field is recessed rather than merely uneditable: the design gives it its own
    //    slightly-sunken ground, so it reads as displayed rather than typed. `dark-3-5` is the rung
    //    the dark read-only swatch draws -- `dark-4` is too extreme a ground for a field.
    if (props.readonly) {
      return 'bg-[#f8f9fc] dark:bg-dark-3-5'
    }
    return 'bg-surface dark:bg-dark-3'
  })
})

const dictText = useDictText()
const resolvedRevealLabel = computed(
  () => props.revealLabel ?? dictText('common.input.showPassword', 'Show password')
)
const resolvedHideLabel = computed(
  () => props.hideLabel ?? dictText('common.input.hidePassword', 'Hide password')
)
const resolvedClearLabel = computed(
  () => props.clearLabel ?? dictText('common.input.clear', 'Clear')
)

const hasError = computed(() => Boolean(errorMessage.value))

const controlEvents = {
  onPointerenter: () => {
    isHovered.value = true
  },
  onPointerleave: () => {
    isHovered.value = false
  }
}

/** `class`/`style` are carved out: the frame takes them, since they size the whole field. */
const controlAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})

const effectiveType = computed(() =>
  props.type === 'password' && props.revealable && isRevealed.value ? 'text' : props.type
)

const describedBy = computed(() => (showsBottom.value ? `${inputId}-desc` : undefined))

/**
 * Emits an empty string rather than null: callers bind `modelValue` straight into request payloads,
 * where a null would change the meaning.
 */
function clear() {
  emit('update:modelValue', '')
}

function onInput(ev) {
  emit('update:modelValue', ev.target.value)
}

function focus() {
  inputEl.value?.focus()
}

// -> `type="hidden"` cannot take focus at all, so `autofocus` is a deliberate no-op there rather
//    than a call that silently fails
onMounted(() => {
  if (props.autofocus && props.type !== 'hidden') {
    focus()
  }
})

function onFocus(ev) {
  hasFocus.value = true
  emit('focus', ev)
}

function onBlur(ev) {
  hasFocus.value = false
  emit('blur', ev)
  hasBlurred.value = true
  if (props.rules.length && props.lazyRules !== 'ondemand') {
    validate()
  }
}

// -> With lazyRules the field stays silent until first blur, then re-validates on every keystroke
watch(
  () => props.modelValue,
  () => {
    if (!props.rules.length || props.lazyRules === 'ondemand') {
      return
    }
    if (props.lazyRules && !hasBlurred.value) {
      return
    }
    validate()
  }
)

/*
  Join the enclosing WForm, if there is one, so submitting validates this field too. Optional by
  design -- most inputs in the codebase stand alone rather than inside a form. `focus` rides along
  so a failed submit can land the user on the first invalid control -- see WForm's `validate()`.
*/
const registerWithForm = inject('wFormRegister', null)
registerWithForm?.({ validate, focus: () => inputEl.value?.focus() })

defineExpose({
  validate,
  focus,
  /**
   * For a caller that fills a `revealable` password field in itself: a generated password the user
   * never typed is worth nothing hidden behind dots. Hiding it again is left to the user, which is
   * why there is no matching `conceal()`.
   */
  reveal: () => {
    isRevealed.value = true
  },
  hasError
})
</script>
