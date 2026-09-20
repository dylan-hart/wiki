<template>
  <!--
    A flex column, not the `<form>` default of `display: block`: call sites space their fields with
    `gap-*`, which does nothing on a block container. Flex children stretch to full width exactly as
    block-level ones do, so a form that sets no gap is unaffected.
  -->
  <form novalidate class="flex flex-col" @submit.prevent="onSubmit">
    <slot />
  </form>
</template>

<script setup>
import { onBeforeUnmount, provide, ref } from 'vue'

/**
 * Fields opt in by injecting `wFormRegister` -- see `WInput`. `novalidate` is set so validation is
 * driven entirely by the `rules` convention rather than the browser's own bubbles.
 */
const emit = defineEmits(['submit', 'validation-error'])

const fields = ref(new Set())

provide('wFormRegister', (field) => {
  fields.value.add(field)
  onBeforeUnmount(() => fields.value.delete(field))
})

function validate() {
  let ok = true
  let firstInvalid = null
  for (const field of fields.value) {
    // -> Every field runs, so the user sees all errors at once rather than one per submit
    if (field.validate?.() === false) {
      ok = false
      firstInvalid ??= field
    }
  }
  if (!ok) {
    /*
      Without this a failed submit leaves focus on the submit button, nowhere near the now-red
      fields or their aria-live messages -- which is also where a screen-reader user needs to be for
      the message they are about to hear. Registration order matches DOM/tab order, since fields
      register from their own `setup()` as they mount top-to-bottom, so the first Set entry is the
      first invalid control.
    */
    firstInvalid?.focus?.()
  }
  return ok
}

function onSubmit(ev) {
  if (validate()) {
    emit('submit', ev)
  } else {
    emit('validation-error')
  }
}

defineExpose({ validate })
</script>
