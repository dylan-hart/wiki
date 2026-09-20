<template>
  <button
    type="button"
    role="tab"
    :aria-selected="String(isActive)"
    :tabindex="isActive ? 0 : -1"
    :disabled="disabled"
    class="w-tab w-unstyled flex min-h-10 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md px-4 py-1.5 text-sm transition-[background-color,box-shadow,color] duration-200 ease-[var(--ease-standard)]"
    :class="[
      tabs?.inlineLabel.value ? 'flex-row' : 'flex-col',
      tabs?.noCaps.value ? 'normal-case' : 'uppercase',
      /*
        Active is a raised pill: a light fill lifted off the track by a shadow, with the label at
        full strength and half a step bolder. Inactive carries its state in the ink alone -- a
        faded-out pill would still read as a pill, which is what makes the active one legible.
      */
      isActive
        ? 'w-tab--active bg-white font-semibold text-black shadow-sm dark:bg-dark-2 dark:text-white'
        : 'font-medium text-black/45 hover:text-black/70 dark:text-white/45 dark:hover:text-white/70',
      disabled ? 'pointer-events-none opacity-40' : ''
    ]"
    @click="tabs?.select(name)">
    <!--
      Sized explicitly: an unsized WIcon inherits the font size, which would draw a tab icon at the
      label's 14px rather than the 24px the app's other icon rows use.
    -->
    <w-icon v-if="icon" :name="icon" size="sm" />
    <span v-if="label">{{ label }}</span>
    <slot />
  </button>
</template>

<script setup>
import { computed, inject } from 'vue'
import WIcon from './WIcon.vue'

const props = defineProps({
  name: {
    type: [String, Number],
    required: true
  },
  label: {
    type: String,
    default: null
  },
  icon: {
    type: String,
    default: null
  },
  disabled: {
    type: Boolean,
    default: false
  }
})

const tabs = inject('wTabs', null)
const isActive = computed(() => tabs?.current.value === props.name)
</script>

<style scoped>
/*
  A scoped rule is unlayered, so it outranks the `uppercase`/`normal-case` utilities the template
  writes -- which is why the opt-out has to be restated here rather than left to the utility.
*/
.w-tab {
  text-transform: uppercase;
}
.w-tab.normal-case {
  text-transform: none;
}
</style>
