import { computed } from 'vue'

/**
 * Bound to an array rather than a boolean, a control contributes its `val` to a set of selected
 * values, so a group of them can share one model.
 *
 * @param {{ modelValue: boolean|Array, val: * }} props
 * @param {(event: string, value: *) => void} emit
 * @returns {{ isOn: import('vue').ComputedRef<boolean>, toggle: () => void }}
 */
export function useToggleModel(props, emit) {
  const isArrayModel = computed(() => Array.isArray(props.modelValue))

  const isOn = computed(() =>
    isArrayModel.value ? props.modelValue.includes(props.val) : props.modelValue === true
  )

  function toggle() {
    if (isArrayModel.value) {
      const next = isOn.value
        ? props.modelValue.filter((v) => v !== props.val)
        : [...props.modelValue, props.val]
      emit('update:modelValue', next)
    } else {
      emit('update:modelValue', !isOn.value)
    }
  }

  return { isOn, toggle }
}
