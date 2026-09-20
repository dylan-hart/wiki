<template>
  <nav class="w-breadcrumbs" :aria-label="resolvedAriaLabel">
    <ol class="flex flex-wrap items-center gap-2">
      <template v-for="(item, idx) of items" :key="item.key ?? idx">
        <li class="flex items-center" :style="idx < items.length - 1 ? activeStyle : null">
          <component
            :is="item.to ? 'router-link' : 'span'"
            :to="item.to"
            :aria-label="item.ariaLabel"
            :aria-current="idx === items.length - 1 ? 'page' : undefined"
            class="w-breadcrumbs__el relative inline-flex items-center text-inherit no-underline">
            <!-- -> `me-2`, not `mr-2`: the gap belongs on the icon's trailing side, whichever
                    physical side that is under the reader's text direction -->
            <w-icon
              v-if="item.icon"
              :name="item.icon"
              class="w-breadcrumbs__el-icon"
              :class="item.label ? 'me-2' : ''" />
            <span v-if="item.label">{{ item.label }}</span>
            <w-tooltip v-if="item.tooltip">{{ item.tooltip }}</w-tooltip>
          </component>
        </li>
        <li
          v-if="idx < items.length - 1"
          class="w-breadcrumbs__separator flex items-center"
          :style="separatorStyle"
          aria-hidden="true">
          <slot name="separator">{{ separator }}</slot>
        </li>
      </template>
    </ol>
  </nav>
</template>

<script setup>
import { computed } from 'vue'
import WTooltip from './WTooltip.vue'
import WIcon from './WIcon.vue'
import { useDictText } from '@/composables/i18nText'

/**
 * Takes the trail as an array rather than as child components: the component this replaces walked
 * its own default slot's vnodes to find them, and an array does the same job while letting the list
 * be real `<ol>`/`<li>` markup, which is what assistive technology expects.
 *
 * Every crumb BUT the last takes `active-color`, and the last inherits the surrounding text colour.
 * That reads backwards until you notice the last crumb is the current page -- it is the one that is
 * not a destination.
 */
const props = defineProps({
  /** The trail, root first. Each entry is `{ key?, icon?, label?, ariaLabel?, to?, tooltip? }`. */
  items: {
    type: Array,
    required: true
  },
  activeColor: {
    type: String,
    default: 'primary'
  },
  separatorColor: {
    type: String,
    default: null
  },
  separator: {
    type: String,
    default: '/'
  },
  ariaLabel: {
    type: String,
    default: null
  }
})

const dictText = useDictText()
const resolvedAriaLabel = computed(
  () => props.ariaLabel ?? dictText('common.breadcrumbs.ariaLabel', 'Breadcrumb')
)

/*
  Inline styles rather than `text-<colour>` classes: the colour names arrive at runtime, so a
  dynamic class string would never be seen by Tailwind's scanner and the utility would not be
  generated. Every other w-* component taking a colour name does the same.
*/
const activeStyle = computed(() => ({ color: `var(--color-${props.activeColor})` }))
const separatorStyle = computed(() =>
  props.separatorColor ? { color: `var(--color-${props.separatorColor})` } : null
)
</script>

<style scoped>
/* Oversized on purpose, so an icon-only crumb stays larger than a label crumb */
.w-breadcrumbs__el-icon {
  font-size: 125%;
}
</style>
