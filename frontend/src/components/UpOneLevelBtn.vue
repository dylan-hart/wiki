<template>
  <!--
    Absent at the root rather than disabled: `v-if` inside the transition leaves nothing focusable
    or readable behind, where a hidden control would still be both. It slides in as its own space
    opens up so the name beside it moves with it rather than jumping.
  -->
  <transition name="up-one-level">
    <div v-if="props.show" class="up-one-level-slot">
      <!--
        The glyph goes through the slot, not WBtn's `icon` prop: a prop icon draws at WIcon's
        default 24px, which does not fit a 28px plate.
      -->
      <w-btn
        class="up-one-level-btn"
        :class="props.plateClass"
        flat
        dense
        padding="none"
        :disabled="props.disabled"
        :aria-label="t('common.browse.upOneLevel')"
        @click="emit('click', $event)">
        <w-icon name="tabler:arrow-up" size="xs" />
        <w-tooltip :anchor="props.tooltipAnchor" :self="props.tooltipSelf">{{
          t('common.browse.upOneLevel')
        }}</w-tooltip>
      </w-btn>
    </div>
  </transition>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

/**
 * The plate, the absent-at-the-root rule, the slide-in, the dimmed glyph and the accent focus ring
 * all live here so every call site carries the same control; a caller supplies only placement,
 * disabled state and the click handler.
 *
 * Deliberately not in `components/shared/`: that library is generic `W*` primitives with no
 * vocabulary of their own, registered globally for every component and test. This hard-codes an app
 * glyph, locale key and tooltip, so it stays an ordinary import.
 */
const props = defineProps({
  /** Whether there is a level above the one being shown. */
  show: {
    type: Boolean,
    default: false
  },
  /** For a level that is still loading -- distinct from `show`, which removes the control. */
  disabled: {
    type: Boolean,
    default: false
  },
  /**
   * Surface-specific treatment, composed onto the button. `acrylic-btn` travels this way rather
   * than being baked in: it is correct on a translucent menu and wrong on an opaque toolbar.
   */
  plateClass: {
    type: [String, Array, Object],
    default: null
  },
  /** For a call site whose default tooltip placement would be clipped. */
  tooltipAnchor: {
    type: String,
    default: undefined
  },
  tooltipSelf: {
    type: String,
    default: undefined
  }
})

const emit = defineEmits(['click'])

/*
  A fallthrough `class` would land on the animated slot, not the plate inside it, silently styling
  the footprint instead of the button. `plateClass` is the way in.
*/
defineOptions({ inheritAttrs: false })

const { t } = useI18n()
</script>

<style>
/*
  `dense` alone lands WBtn on 28px tall but 38px wide, so the plate is not square. Its padding is
  killed through the `padding` prop rather than a rule here, because WBtn writes padding inline
  where a stylesheet cannot beat it; `width`/`height` it does not set inline, so they state the
  square outright.
*/
.up-one-level-btn.w-btn {
  width: 28px;
  height: 28px;
}

/* -> Dimmed at rest so it does not compete with the name beside it. */
.up-one-level-btn .w-icon {
  opacity: 0.7;
}

.up-one-level-btn:hover .w-icon {
  opacity: 1;
}

/*
  WBtn already draws the 2px ring 2px clear of its box; only the colour is stated here, since the
  default `currentColor` would be the dimmed glyph tone.
*/
.up-one-level-btn:focus-visible {
  outline-color: var(--color-accent);
}

.body--dark .up-one-level-btn:focus-visible {
  outline-color: var(--color-accent-dark);
}

/*
  The footprint is its own element so `width` can animate, closing the space up with the button
  rather than after it. It carries the trailing gap too, which belongs to the button and goes with
  it.
*/
.up-one-level-slot {
  flex: none;
  width: 28px;
  margin-inline-end: 12px;
}

/*
  Clipped only while moving: at rest the slot must not clip, or it cuts off the focus ring the
  button draws outside its own box.
*/
.up-one-level-enter-active,
.up-one-level-leave-active {
  overflow: hidden;
  transition:
    width 0.18s var(--ease-standard),
    margin-inline-end 0.18s var(--ease-standard),
    opacity 0.18s var(--ease-standard);
}

/* -> The slide is on the button: a percentage transform on the slot resolves against a width that
      is zero at exactly that moment, and moves nothing. */
.up-one-level-enter-active .up-one-level-btn,
.up-one-level-leave-active .up-one-level-btn {
  transition: transform 0.18s var(--ease-standard);
}

.up-one-level-enter-from,
.up-one-level-leave-to {
  width: 0;
  margin-inline-end: 0;
  opacity: 0;
}

/* -> Physical, unlike everything else here: CSS has no logical translate. The slot's own
      width/margin animation is logical, so under `dir="rtl"` the plate travels the same distance
      from the other side. */
.up-one-level-enter-from .up-one-level-btn,
.up-one-level-leave-to .up-one-level-btn {
  transform: translateX(-100%);
}

@media (prefers-reduced-motion: reduce) {
  .up-one-level-enter-active,
  .up-one-level-leave-active,
  .up-one-level-enter-active .up-one-level-btn,
  .up-one-level-leave-active .up-one-level-btn {
    transition-duration: 0.01ms;
  }
}
</style>
