<template>
  <!--
    A plain select is a <button>, for free keyboard activation, disabled semantics and focus. The
    filtering variant cannot be: an <input> inside a <button> is invalid and receives no typing, so
    that variant is a <div> with the combobox role on the input. The frame renders whichever one,
    since the notched outline and the floated label sit around it.
  -->
  <w-field-frame
    ref="frame"
    variant-class="w-select"
    :root-class="attrs.class"
    :root-style="attrs.style"
    :label="label"
    :required="required"
    :hint="hint"
    :label-for="selectId"
    :control-tag="useInput ? 'div' : 'button'"
    :control-props="controlProps"
    control-base-class="w-unstyled w-input-control flex w-full flex-nowrap items-center gap-2 rounded-card text-start"
    :control-classes="controlClasses"
    :control-style="controlStyle"
    :shows-bottom="showsBottom"
    :error-message="errorMessage">
    <slot name="prepend" />

    <span v-if="showsChips" class="flex min-w-0 flex-wrap items-center gap-1">
      <w-chip
        v-for="(v, i) of selectedValues"
        :key="i"
        :label="labelFor(v)"
        size="sm"
        removable
        :remove-label="`Remove ${labelFor(v)}`"
        @remove="deselect(v)" />
    </span>

    <!--
      `outline-none` because the FIELD is what shows focus, with its ring: the user agent's own
      outline drew a second, black one inside the rounded frame.
    -->
    <input
      v-if="useInput"
      v-bind="controlAttrs"
      :id="selectId"
      ref="input"
      v-model="query"
      type="text"
      role="combobox"
      autocomplete="off"
      :aria-expanded="String(isOpen)"
      :aria-required="required || undefined"
      aria-haspopup="listbox"
      :aria-label="label ? undefined : ariaLabel"
      :aria-controls="isOpen ? `${selectId}-listbox` : undefined"
      :aria-activedescendant="isOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined"
      :disabled="isDisabled"
      :readonly="readonly"
      :placeholder="showsChips ? '' : placeholder"
      class="w-unstyled min-w-8 flex-1 bg-transparent outline-none placeholder:text-text-caption dark:placeholder:text-text-caption-dark"
      @focus="readonly || open(0)"
      @keydown="onKeydown" />
    <span
      v-else
      class="min-w-0 flex-1 truncate"
      :class="hasSelection || displayValue ? '' : 'text-text-caption dark:text-text-caption-dark'">
      <!--
        Empty while the chips above draw the selection -- they REPLACE this text -- but the element
        stays: it holds the row open and pushes the dropdown arrow to the end.
      -->
      <slot name="selected">{{ showsChips ? '' : displayText }}</slot>
    </span>
    <w-spinner v-if="loading" size="1em" class="shrink-0" />
    <w-icon
      v-else-if="!readonly && !hideDropdownIcon"
      name="tabler:chevron-down"
      size="1.2em"
      class="shrink-0 transition-transform"
      :class="isOpen ? 'rotate-180' : ''" />

    <w-menu v-model="isOpen" :dark="dark" fit anchor="bottom left" self="top left">
      <div
        :id="`${selectId}-listbox`"
        role="listbox"
        :aria-multiselectable="multiple || undefined"
        class="py-1">
        <!--
          Plain <div>s, not buttons: focus stays on the combobox and the keyboard moves a virtual
          cursor (`aria-activedescendant`) instead. Real focus inside a teleported popup would be
          left on a detached node once it closes.
        -->
        <div
          v-for="(opt, idx) of filteredOptions"
          :id="optionId(idx)"
          :key="idx"
          role="option"
          :aria-selected="String(isSelected(opt.value))"
          :aria-disabled="opt.disable || undefined"
          class="w-select-option flex w-full flex-nowrap items-center gap-2 px-4 text-start"
          :class="[
            optionsDense ? 'min-h-8 py-1 text-body2' : 'min-h-10 py-2',
            isSelected(opt.value) ? 'text-primary' : '',
            opt.disable
              ? 'cursor-not-allowed text-black/40 dark:text-white/40'
              : 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/8',
            idx === activeIndex && !opt.disable ? 'bg-black/8 dark:bg-white/12' : ''
          ]"
          @click.stop="select(opt.value)"
          @mousemove="opt.disable || (activeIndex = idx)">
          <!--
            A check, not a checkbox: the row already announces its state by colouring itself. The
            explicit `size` keeps the icon off the row's own font size, which drew a 14px square that
            read as a rendering fault. The column is held open so labels line up either way.
          -->
          <span v-if="multiple" class="flex w-5 shrink-0 justify-center">
            <w-icon v-if="isSelected(opt.value)" name="tabler:check" size="20px" />
          </span>
          <span class="min-w-0 flex-1">
            <!--
              Row content only: the check and the click handling stay with the component, so a caller
              cannot wire a nested control that toggles twice.
            -->
            <slot name="option" :opt="opt.raw" :selected="isSelected(opt.value)">
              <span class="block truncate">{{ opt.label }}</span>
            </slot>
          </span>
        </div>
        <div
          v-if="!filteredOptions.length"
          class="px-4 py-2 text-body2 text-black/54 dark:text-white/60">
          {{ resolvedNoOptionsLabel }}
        </div>
      </div>
    </w-menu>
  </w-field-frame>
</template>

<script setup>
import { computed, inject, nextTick, onMounted, ref, useAttrs, useId, useSlots, watch } from 'vue'
import WChip from './WChip.vue'
import WFieldFrame from './WFieldFrame.vue'
import WMenu from './WMenu.vue'
import WSpinner from './WSpinner.vue'
import { fieldProps, useFieldFrame } from '@/composables/fieldFrame'
import { useDictText } from '@/composables/i18nText'

/**
 * The label, the notched outline, the hint/error line and the state that colours them are shared
 * with `WInput`, and live in `WFieldFrame.vue` / `composables/fieldFrame.js`. What is here is the
 * selection model, the listbox and the keyboard handling.
 */

/*
 * `$attrs` belongs on the real control -- the `<button>`, or the nested `<input>` under `useInput` --
 * never on the frame's wrapper `<div>`. `controlAttrs` below is what both bind.
 */
defineOptions({ inheritAttrs: false })

const slots = useSlots()
const attrs = useAttrs()

const props = defineProps({
  ...fieldProps,
  modelValue: {
    type: null,
    default: null
  },
  options: {
    type: Array,
    default: () => []
  },
  optionValue: {
    type: String,
    default: 'value'
  },
  optionLabel: {
    type: String,
    default: 'label'
  },
  /** A disabled option still shows, greyed out rather than hidden, but selection skips it. */
  optionDisable: {
    type: String,
    default: null
  },
  /** Emit the option's value rather than the whole option object. */
  emitValue: {
    type: Boolean,
    default: false
  },
  /** Resolve the bound value back to an option for display. */
  mapOptions: {
    type: Boolean,
    default: false
  },
  multiple: {
    type: Boolean,
    default: false
  },
  /** Filled control with no ring, which brightens when open. */
  standout: {
    type: Boolean,
    default: false
  },
  /**
   * Dark surface regardless of the app theme: the admin sidebar is dark in both, so its controls
   * cannot key off the `dark:` variant.
   */
  dark: {
    type: Boolean,
    default: false
  },
  optionsDense: {
    type: Boolean,
    default: false
  },
  loading: {
    type: Boolean,
    default: false
  },
  placeholder: {
    type: String,
    default: ''
  },
  noOptionsLabel: {
    type: String,
    default: null
  },
  /** Type to narrow the list: the field renders an `<input>` and filters `options` itself. */
  useInput: {
    type: Boolean,
    default: false
  },
  /**
   * Enter on a query matching no highlighted option emits `create` with the trimmed text instead of
   * closing the popup; only the caller knows whether that value is allowed to exist.
   */
  create: {
    type: Boolean,
    default: false
  },
  useChips: {
    type: Boolean,
    default: false
  },
  hideDropdownIcon: {
    type: Boolean,
    default: false
  },
  /** Replaces the computed display text -- for a summary like "3 locales". */
  displayValue: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['update:modelValue', 'create'])

const dictText = useDictText()
const resolvedNoOptionsLabel = computed(
  () => props.noOptionsLabel ?? dictText('common.select.noOptions', 'No options')
)

const isOpen = ref(false)
/** Pointer-over, for the ring: the ring is an inline style, so CSS `:hover` cannot reach it. */
const isHovered = ref(false)
/** Option the keyboard cursor is on; -1 when there is none. */
const activeIndex = ref(-1)

// -> Any close route (click-away, selection, Escape) leaves no stale cursor behind
watch(isOpen, (open) => {
  if (!open) {
    activeIndex.value = -1
  }
})

const selectId = useId()
const query = ref('')
const input = ref(null)
const frame = ref(null)

// -> A stale filter would otherwise still be narrowing the list the next time the popup opens
watch(isOpen, (open) => {
  if (!open) {
    query.value = ''
  }
})

const isDisabled = computed(() => props.disabled)

/**
 * The caller's plain attributes, forwarded onto the real control rather than stranded on the wrapper.
 * `class`/`style` are carved out because the frame takes them as `rootClass`/`rootStyle`; binding an
 * element straight to `$attrs` would land the caller's class on it a second time.
 */
const controlAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})

const normalizedOptions = computed(() =>
  props.options.map((opt) => {
    if (opt !== null && typeof opt === 'object') {
      return {
        value: props.emitValue ? opt[props.optionValue] : opt,
        label: String(opt[props.optionLabel] ?? ''),
        disable: props.optionDisable ? Boolean(opt[props.optionDisable]) : false,
        // -> handed to the `option` slot, so callers can read their own fields
        raw: opt
      }
    }
    return { value: opt, label: String(opt), disable: false, raw: opt }
  })
)

const filteredOptions = computed(() => {
  if (!props.useInput || !query.value) {
    return normalizedOptions.value
  }
  const needle = query.value.toLowerCase()
  return normalizedOptions.value.filter((o) => o.label.toLowerCase().includes(needle))
})

/*
  Typing narrows the list under the cursor, and one left past the end made Enter read an option that
  was no longer there.
*/
watch(filteredOptions, (options) => {
  if (activeIndex.value >= options.length) {
    activeIndex.value = options.length > 0 ? 0 : -1
  }
})

const selectedValues = computed(() => {
  if (props.multiple) {
    return Array.isArray(props.modelValue) ? props.modelValue : []
  }
  return props.modelValue === null || props.modelValue === undefined ? [] : [props.modelValue]
})

const hasSelection = computed(() => selectedValues.value.length > 0)

const showsChips = computed(() => props.useChips && hasSelection.value)

const displayText = computed(() => {
  if (props.displayValue !== null) {
    return props.displayValue
  }
  if (!hasSelection.value) {
    return props.placeholder
  }
  return selectedValues.value
    .map((v) => {
      const match = normalizedOptions.value.find((o) => sameValue(o.value, v))
      return match && props.mapOptions !== false ? match.label : String(v?.[props.optionLabel] ?? v)
    })
    .join(', ')
})

/** A standout control carries its state in its fill, so it takes no ring at all. */
const standoutClass = computed(() => {
  if (!props.standout) {
    return null
  }
  if (props.dark) {
    return isOpen.value ? 'bg-white/22 text-white' : 'bg-white/10 text-white'
  }
  return isOpen.value ? 'bg-black/16 dark:bg-white/22' : 'bg-black/6 dark:bg-white/10'
})

/*
  "Active" here is the open dropdown, this control's equivalent of focus; `standout` draws no frame at
  all and so takes no floating label either.
*/
const { controlStyle, controlClasses, showsBottom, errorMessage, validate } = useFieldFrame({
  props,
  active: isOpen,
  hovered: isHovered,
  hasValue: computed(() => hasSelection.value || Boolean(props.displayValue)),
  hasLeadingAdornment: computed(() => Boolean(slots.prepend)),
  noFrame: computed(() => props.standout),
  surface: computed(
    () =>
      standoutClass.value ??
      (props.readonly ? 'bg-[#f8f9fc] dark:bg-dark-3-5' : 'bg-surface dark:bg-dark-3')
  ),
  // -> readonly keeps full contrast; only the pointer affordance goes away
  extraClasses: computed(() =>
    props.readonly ? 'cursor-default' : isDisabled.value ? '' : 'cursor-pointer'
  )
})

/**
 * A plain select IS the combobox, so it carries the role, its `aria-*` and the forwarded attrs. The
 * filtering variant's control is an inert `<div>` whose nested `<input>` carries all of that instead,
 * which is why every entry reads `useInput ? undefined : …` -- otherwise both elements would.
 */
const controlProps = computed(() => ({
  ...(props.useInput ? {} : controlAttrs.value),
  id: props.useInput ? undefined : selectId,
  type: props.useInput ? undefined : 'button',
  role: props.useInput ? undefined : 'combobox',
  'aria-expanded': props.useInput ? undefined : String(isOpen.value),
  'aria-haspopup': props.useInput ? undefined : 'listbox',
  'aria-label': props.useInput || props.label ? undefined : props.ariaLabel,
  'aria-readonly': !props.useInput && props.readonly ? true : undefined,
  'aria-controls': !props.useInput && isOpen.value ? `${selectId}-listbox` : undefined,
  'aria-activedescendant':
    !props.useInput && isOpen.value && activeIndex.value >= 0
      ? optionId(activeIndex.value)
      : undefined,
  disabled: props.useInput ? undefined : isDisabled.value,
  onClick: onControlClick,
  onPointerenter: () => {
    isHovered.value = true
  },
  onPointerleave: () => {
    isHovered.value = false
  },
  onKeydown: (ev) => {
    if (!props.useInput) {
      onKeydown(ev)
    }
  }
}))

/** Options are frequently objects rebuilt on each render, so identity comparison is not enough. */
function sameValue(a, b) {
  if (a === b) {
    return true
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return a[props.optionValue] !== undefined && a[props.optionValue] === b[props.optionValue]
  }
  return false
}

function isSelected(value) {
  return selectedValues.value.some((v) => sameValue(v, value))
}

function focus() {
  if (props.useInput) {
    input.value?.focus()
  } else {
    frame.value?.controlEl?.focus()
  }
}

const registerWithForm = inject('wFormRegister', null)
registerWithForm?.({ validate, focus })

defineExpose({ validate, focus })

onMounted(() => {
  if (props.autofocus) {
    focus()
  }
})

function labelFor(value) {
  const match = normalizedOptions.value.find((o) => sameValue(o.value, value))
  return match ? match.label : String(value?.[props.optionLabel] ?? value)
}

function deselect(value) {
  const next = selectedValues.value.filter((v) => !sameValue(v, value))
  emit('update:modelValue', props.multiple ? next : (next[0] ?? null))
  revalidate(props.multiple ? next : (next[0] ?? null))
}

/** The filtering variant's control is an inert div, so a click anywhere on it focuses the input. */
function onControlClick() {
  if (props.readonly || isDisabled.value) {
    return
  }
  if (props.useInput) {
    input.value?.focus()
    return
  }
  toggle()
}

function optionId(idx) {
  return `${selectId}-opt-${idx}`
}

function toggle() {
  isOpen.value = !isOpen.value
}

/** `block: 'nearest'` brings the option into view without scrolling the page. */
async function revealActive() {
  await nextTick()
  document.getElementById(optionId(activeIndex.value))?.scrollIntoView({ block: 'nearest' })
}

function moveActive(delta) {
  const list = filteredOptions.value
  const count = list.length
  if (count === 0) {
    return
  }
  // -> Wraps, and steps past a disabled option rather than landing on one nothing can select --
  //    bounded by `count` so an entirely disabled list terminates instead of looping forever.
  let next = activeIndex.value
  for (let i = 0; i < count; i++) {
    next = (next + delta + count) % count
    if (!list[next]?.disable) {
      break
    }
  }
  activeIndex.value = next
  revealActive()
}

/** Starts the cursor on the current selection, so arrowing continues from the value. */
function open(startAt) {
  isOpen.value = true
  const selected = filteredOptions.value.findIndex((opt) => isSelected(opt.value))
  activeIndex.value = selected >= 0 ? selected : startAt
  revealActive()
}

function onKeydown(ev) {
  if (isDisabled.value || props.readonly) {
    return
  }

  const count = filteredOptions.value.length

  switch (ev.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      ev.preventDefault()
      const delta = ev.key === 'ArrowDown' ? 1 : -1
      if (isOpen.value) {
        moveActive(delta)
      } else {
        open(delta === 1 ? 0 : count - 1)
      }
      return
    }
    case 'Home':
    case 'End':
      if (isOpen.value) {
        ev.preventDefault()
        activeIndex.value = ev.key === 'Home' ? 0 : count - 1
        revealActive()
      }
      return
    case 'Enter':
    case ' ': {
      /*
        Both would otherwise reach the <button> as a click and toggle the popup shut, discarding the
        cursor. When closed, the default click opens as usual.
      */
      // -> With a text input, Space is a character in the query rather than a commit key
      if (ev.key === ' ' && props.useInput) {
        return
      }
      if (!isOpen.value) {
        return
      }
      ev.preventDefault()
      if (activeIndex.value >= 0) {
        select(filteredOptions.value[activeIndex.value].value)
        return
      }
      // -> Nothing highlighted, so what was typed is the value
      const typed = query.value.trim()
      if (props.create && typed) {
        emit('create', typed)
        query.value = ''
        return
      }
      isOpen.value = false
      return
    }
    case 'Escape':
      if (isOpen.value) {
        ev.preventDefault()
        ev.stopPropagation()
        isOpen.value = false
      }
      return
    case 'Tab':
      // -> Leaves without committing the cursor, as a listbox should
      isOpen.value = false
  }
}

function select(value) {
  const opt = normalizedOptions.value.find((o) => sameValue(o.value, value))
  if (opt?.disable) {
    return
  }
  if (props.multiple) {
    const next = isSelected(value)
      ? selectedValues.value.filter((v) => !sameValue(v, value))
      : [...selectedValues.value, value]
    emit('update:modelValue', next)
    revalidate(next)
    query.value = ''
    // -> Multi-select stays open so several options can be picked in one go
    return
  }
  emit('update:modelValue', value)
  revalidate(value)
  isOpen.value = false
}

/**
 * In `ondemand` mode nothing is validated up front, but an error already on screen clears as soon as
 * the selection satisfies the rules -- leaving it up while the field is being fixed would mislead.
 */
function revalidate(nextValue) {
  if (!props.rules.length) {
    return
  }
  if (props.lazyRules === 'ondemand' && !errorMessage.value) {
    return
  }
  validate(nextValue)
}
</script>
