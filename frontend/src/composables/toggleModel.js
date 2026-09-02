import { computed } from 'vue'

/**
 * The boolean-or-array model both binary controls take — `WCheckbox` and `WToggle`.
 *
 * Bound to a boolean, a control is its own value. Bound to an array, it contributes its `val` to a
 * set of selected values, so a group of them can share one model: exactly what the classification
 * grids in the API-key dialogs do.
 *
 * @param {{ modelValue: boolean|Array, val: * }} props The component's own props.
 * @param {(event: string, value: *) => void} emit The component's own `emit`.
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
