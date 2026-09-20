<template>
  <div :class="classes">
    <slot />
  </div>
</template>

<script setup>
import { computed } from 'vue'

/** With no props this is the main section; `side`/`avatar`/`thumbnail` make it a flanking one. */
const props = defineProps({
  side: {
    type: Boolean,
    default: false
  },
  avatar: {
    type: Boolean,
    default: false
  },
  thumbnail: {
    type: Boolean,
    default: false
  },
  top: {
    type: Boolean,
    default: false
  }
})

const isFlanking = computed(() => props.side || props.avatar || props.thumbnail)

const classes = computed(() => [
  'w-item-section flex min-w-0 flex-col',
  props.top ? 'self-start' : 'justify-center',
  // -> The modifier classes are what the scoped rules below key off
  isFlanking.value ? 'w-item-section--side shrink-0' : 'w-item-section--main min-w-0 flex-1',
  props.avatar ? 'w-item-section--avatar' : '',
  props.side && !props.avatar ? 'text-black/54 dark:text-white/70' : ''
])
</script>

<style scoped>
/*
  Spacing between sections is section padding, not a gap on the item: a gap would also apply to
  children that are not sections (`BlueprintIcon` renders its own avatar section), doubling theirs.
*/
.w-item-section--side {
  align-items: flex-start;
  padding-inline-end: 16px;
}

.w-item-section--main ~ .w-item-section--side {
  align-items: flex-end;
  padding-inline-start: 16px;
  padding-inline-end: 0;
}

.w-item-section--main + .w-item-section--main {
  margin-inline-start: 8px;
}

/*
  Keyed off the ROW's width (`.w-item` is the query container, see `WItem.vue`) rather than the
  viewport, so a settings-style row stacks whenever something squeezes it -- a nav rail, a sidebar,
  a narrow dialog -- not only below a viewport breakpoint.

  `flex-basis` via the shorthand, not `width`: the section carries `flex-1` (`flex: 1 1 0%`) and a
  flex item is sized by its basis, so a bare `width: 100%` is ignored. The 100% basis against
  `WItem.vue`'s `flex-wrap` is what claims a line of its own.
*/
@container w-item (max-width: 599.98px) {
  .w-item-section--main + .w-item-section--main {
    flex: 1 0 100%;
    margin-top: 0.5rem;
    margin-inline-start: 0;
  }
}

.w-item-section--avatar {
  min-width: 56px;
  align-items: center;
}

.w-item-section--side > :deep(.w-icon) {
  font-size: 24px;
}

/*
  A flanking avatar is 40px, not the 48px `WAvatar` takes on its own. The box has to be set here and
  not just the font size: `WAvatar` sizes from explicit width/height, so overriding font-size alone
  leaves it at 48px.
*/
.w-item-section--side > :deep(.w-avatar) {
  width: 40px;
  height: 40px;
  font-size: 24px;
}
</style>
