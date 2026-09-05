<template>
  <!--
    A plain select is a <button>: it gets keyboard activation, disabled semantics and focus for
    free. A filtering one cannot be, because an <input> inside a <button> is invalid and does not
    receive typing -- so that variant is a <div> and the combobox role moves onto the input. The
    listbox below is shared by both rather than duplicated. Either way it is the frame that renders
    that element, since the notched outline and the floated label sit inside it.
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
    control-base-class="w-unstyled w-input-control flex w-full flex-nowrap items-center gap-2 text-start"
    :control-classes="controlClasses"
    :control-style="controlStyle"
    :shows-bottom="showsBottom"
    :error-message="errorMessage">
    <slot name="prepend" />

    <!--
      The selection as chips rather than a comma-joined string. Each carries its own remove
      affordance, so a value can be dropped without reopening the list.
    -->
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
      outline drew a second, black one inside the rounded frame. Placeholder colour matched to
      WInput's, which this had been leaving to the browser as well.
    -->
    <input
      v-if="useInput"
      v-bind="$attrs"
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
        `selected` lets a caller summarise the selection instead of listing it -- e.g. "3 groups
        selected" rather than three comma-joined names.

        Empty once the chips above are drawing the selection: the comma-joined text is what chips
        REPLACE, and rendering both said the same thing twice, side by side. The element stays for
        the layout -- it is what holds the row open and pushes the dropdown arrow to the end.
      -->
      <slot name="selected">{{ showsChips ? '' : displayText }}</slot>
    </span>
    <w-spinner v-if="loading" size="1em" class="shrink-0" />
    <w-icon
      v-else-if="!readonly && !hideDropdownIcon"
      name="mdi:menu-down"
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
          The options are plain <div>s, not buttons: focus never leaves the combobox. Keyboard
          users move a virtual cursor (`aria-activedescendant`) instead, which is the pattern for
          a listbox whose popup is teleported -- moving real focus into it would take focus out
          of the control and, on close, leave it on a detached node.
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
            A check, not a checkbox. The icon takes the row's own font size unless told otherwise,
            which made a 14px square that read as a rendering fault rather than a control -- and the
            row already announces its state by colouring itself. The column is held open when
            nothing is drawn, so labels line up whatever is selected.
          -->
          <span v-if="multiple" class="flex w-5 shrink-0 justify-center">
            <w-icon v-if="isSelected(opt.value)" name="mdi:check" size="20px" />
          </span>
          <span class="min-w-0 flex-1">
            <!--
              `option` customises the row's content only. Selection mechanics (the check and the
              click handling) stay with the component, so a caller cannot accidentally wire a
              nested control that toggles twice -- which is what the markup this replaces had to
              guard against by hand.
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
 * Dropdown select.
 *
 * `options` may be plain values or objects. For objects, `optionValue` / `optionLabel` name the
 * fields to read, and `emitValue` controls whether the model receives the option's value or the
 * whole object -- the same contract the existing markup is written against.
 *
 * Simplification: no free-text filtering or async search. Every current usage picks from a fixed,
 * short list.
 *
 * The label, the notched outline, the hint/error line and the state that colours them are shared
 * with `WInput`, and live in `WFieldFrame.vue` / `composables/fieldFrame.js`. What is here is the
 * selection model, the listbox and the keyboard handling.
 */

/*
 * Same wrapper-root shape as WInput, and the same fix -- see the note there. The real control is
 * the `<button>` for a plain select or the nested `<input>` for the filtering (`useInput`) variant;
 * `$attrs` is bound onto whichever one is actually rendered, never onto the frame's wrapper `<div>`
 * or onto the control element when it is only standing in for the popup's anchor.
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
  /** Field holding the value, when options are objects. */
  optionValue: {
    type: String,
    default: 'value'
  },
  /** Field holding the display text, when options are objects. */
  optionLabel: {
    type: String,
    default: 'label'
  },
  /**
   * Field holding whether an option is selectable, when options are objects. A disabled option
   * still shows -- grayed out, not hidden -- but click and keyboard selection skip it, same as a
   * native `<option disabled>`.
   */
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
   * Renders for a dark surface regardless of the app theme -- the admin sidebar is dark in both
   * themes, so its controls cannot key off the `dark:` variant.
   */
  dark: {
    type: Boolean,
    default: false
  },
  /** Tighter rows in the dropdown. */
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
  /** Falls back to the `common.select.noOptions` dictionary entry when not given. */
  noOptionsLabel: {
    type: String,
    default: null
  },
  /**
   * Type to narrow the list.
   *
   * Simplification: the component this replaces delegated filtering to the caller through a
   * `@filter` event and an `update(cb)` callback, so every caller reimplemented the same
   * case-insensitive substring match over its own list and kept the filtered copy in its own state.
   * This filters `options` itself, which is what all of them were doing by hand.
   */
  useInput: {
    type: Boolean,
    default: false
  },
  /**
   * Let what has been typed become a value of its own.
   *
   * With `useInput`, Enter on a query that matches no highlighted option emits `create` with the
   * trimmed text instead of closing the popup. The caller decides what that means — adding it to
   * `options` and to the selection, typically — because only the caller knows whether the thing is
   * allowed to exist.
   */
  create: {
    type: Boolean,
    default: false
  },
  /** Show the selection as removable chips instead of comma-joined text. */
  useChips: {
    type: Boolean,
    default: false
  },
  hideDropdownIcon: {
    type: Boolean,
    default: false
  },
  /** Replaces the computed display text outright -- for a summary like "3 locales". */
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
/** Index of the option the keyboard cursor is on; -1 when there is none. */
const activeIndex = ref(-1)

// -> A popup closed by any route (click-away, selection, Escape) leaves no stale cursor behind
watch(isOpen, (open) => {
  if (!open) {
    activeIndex.value = -1
  }
})

const selectId = useId()
/** What has been typed into the filter, when `useInput`. */
const query = ref('')
const input = ref(null)
/** The frame, which renders the control element this field's `focus()` reaches for. */
const frame = ref(null)

// -> A stale filter would otherwise still be narrowing the list the next time the popup opens
watch(isOpen, (open) => {
  if (!open) {
    query.value = ''
  }
})

// COMPUTED

const isDisabled = computed(() => props.disabled)

/**
 * Everything the caller passed through as a plain HTML attribute -- `name`, `data-*`, ... --
 * forwarded onto the real control rather than left stranded on the wrapper. For the plain variant
 * that's the frame's `<button>`; `class`/`style` are carved out because they're handed to the frame
 * as `rootClass`/`rootStyle` instead, see the matching note in `WInput`. For the `useInput` variant
 * the real control is the nested `<input>` instead (it binds `$attrs` itself, below) -- forwarding
 * here too would land every attribute on both elements, so this resolves to nothing in that case.
 */
const controlAttrs = computed(() => {
  if (props.useInput) {
    return {}
  }
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})

/** Options flattened to `{ value, label, raw }`, whatever shape they came in as. */
const normalizedOptions = computed(() =>
  props.options.map((opt) => {
    if (opt !== null && typeof opt === 'object') {
      return {
        value: props.emitValue ? opt[props.optionValue] : opt,
        label: String(opt[props.optionLabel] ?? ''),
        disable: props.optionDisable ? Boolean(opt[props.optionDisable]) : false,
        // -> the untouched option, handed to the `option` slot so callers can read their own fields
        raw: opt
      }
    }
    return { value: opt, label: String(opt), disable: false, raw: opt }
  })
)

/**
 * What the listbox actually shows. Only `useInput` narrows it -- everything else lists `options`
 * whole, so the popup and the keyboard cursor agree on one list either way.
 */
const filteredOptions = computed(() => {
  if (!props.useInput || !query.value) {
    return normalizedOptions.value
  }
  const needle = query.value.toLowerCase()
  return normalizedOptions.value.filter((o) => o.label.toLowerCase().includes(needle))
})

/*
  Keep the keyboard cursor inside the list it is pointing at. Typing narrows the options under it, and
  a cursor left past the end made Enter read an option that was no longer there.
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

/** Whether the selection is being drawn as chips, which is a different thing from being able to. */
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
      // -> mapOptions resolves a bare value back to its label; without it the raw value is shown
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
  The field chrome, shared with WInput -- see `composables/fieldFrame.js`. "Active" here is the open
  dropdown, which is this control's equivalent of focus; `standout` is the variant that draws no
  frame at all and so takes no floating label either.

  The `pt-0.5` on the value span is optical centring, matching WInput -- Roboto's ascent exceeds
  its descent, so a geometrically centred line box renders its glyphs 2px high. See WInput for the
  full note.
*/
const { controlStyle, controlClasses, showsBottom, errorMessage, validate } = useFieldFrame({
  props,
  active: isOpen,
  hovered: isHovered,
  hasValue: computed(() => hasSelection.value || Boolean(props.displayValue)),
  hasLeadingAdornment: computed(() => Boolean(slots.prepend)),
  noFrame: computed(() => props.standout),
  // -> Its own surface, white or the dark panel tone, matching WInput; see the note there
  surface: computed(
    () =>
      standoutClass.value ??
      (props.readonly ? 'bg-[#f8f9fc] dark:bg-dark-4' : 'bg-surface dark:bg-dark-3')
  ),
  // -> readonly keeps full contrast; only the pointer affordance goes away
  extraClasses: computed(() =>
    props.readonly ? 'cursor-default' : isDisabled.value ? '' : 'cursor-pointer'
  )
})

/**
 * Everything bound onto the frame's control element.
 *
 * A plain select IS the combobox, so it carries the role and every `aria-*` that goes with it; the
 * filtering variant's control is an inert `<div>` and hands all of that to its nested `<input>`
 * instead, which is why each entry reads `useInput ? undefined : …`.
 */
const controlProps = computed(() => ({
  ...controlAttrs.value,
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

// METHODS

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

/**
 * Focuses the real interactive element: the filtering variant's `<input>`, or the plain variant's
 * `<button>` (which the frame renders) -- whichever one the combobox role actually lives on. Same
 * shape as `WInput`'s `focus()`, and the guard against a hidden field.
 */
function focus() {
  if (props.useInput) {
    input.value?.focus()
  } else {
    frame.value?.controlEl?.focus()
  }
}

/*
  Join the enclosing WForm, if there is one, so submitting validates this control too. Optional by
  design -- plenty of selects in the codebase stand alone.
*/
const registerWithForm = inject('wFormRegister', null)
registerWithForm?.({ validate, focus })

defineExpose({ validate, focus })

// -> A hidden field (e.g. one behind a `v-if` that hasn't mounted yet) leaves both refs null; the
//    same optional chaining `focus()` uses above is the guard.
onMounted(() => {
  if (props.autofocus) {
    focus()
  }
})

/** Display text for a bound value, resolved back through the options where possible. */
function labelFor(value) {
  const match = normalizedOptions.value.find((o) => sameValue(o.value, value))
  return match ? match.label : String(value?.[props.optionLabel] ?? value)
}

function deselect(value) {
  const next = selectedValues.value.filter((v) => !sameValue(v, value))
  emit('update:modelValue', props.multiple ? next : (next[0] ?? null))
  revalidate(props.multiple ? next : (next[0] ?? null))
}

/**
 * A click anywhere on the filtering variant lands on the input, since the control is a plain div
 * there and only the input is focusable. The button variant just toggles, as before.
 */
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

/** Brings the active option into view without scrolling the page. */
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
  // -> Wraps, so ArrowUp from the top lands on the last option. Steps past a disabled option rather
  //    than landing the cursor on one nothing can select -- bounded by `count` so a list that is
  //    entirely disabled still terminates instead of looping forever.
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

/**
 * Opens the popup with the cursor on the current selection, so arrowing starts from where the
 * value already is rather than from the top of the list.
 */
function open(startAt) {
  isOpen.value = true
  const selected = filteredOptions.value.findIndex((opt) => isSelected(opt.value))
  activeIndex.value = selected >= 0 ? selected : startAt
  revealActive()
}

/**
 * Keyboard handling for the combobox, following the listbox pattern: the arrows move a virtual
 * cursor, Enter commits it, Escape abandons it, and Tab leaves the control as it found it.
 */
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
        Both would otherwise reach the <button> as a click and toggle the popup shut, discarding
        the cursor. When open they commit instead; when closed the default click opens as usual.
      */
      // -> Space is a character to a field with a text input, not a commit key: it belongs to the query
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
      // -> Nothing to commit, so what was typed is the value -- see the `create` prop
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
 * Re-runs validation after a change, against the incoming value. In 'ondemand' mode nothing is
 * validated up front, but an error already on screen is cleared as soon as the selection satisfies
 * the rules -- leaving it visible while the user fixes the field would be misleading.
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
