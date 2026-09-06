<template>
  <!--
    Absent at the root rather than sitting disabled: a control that can never be used from where the
    reader is standing is noise, and one that is only ever disabled AT the root is a control that
    spends the whole of the root level saying nothing. `v-if` inside the transition is what makes it
    genuinely absent from the DOM, not merely hidden -- so nothing focusable, nothing readable and
    nothing measurable is left behind.

    It slides in from the inline start as its own space opens up, and back out the same way, so the
    name beside it moves WITH it rather than jumping the moment the level changes.
  -->
  <transition name="up-one-level">
    <div v-if="props.show" class="up-one-level-slot">
      <!--
        The glyph comes through the slot rather than through WBtn's `icon` prop, which is the only
        way to size it: WBtn draws a prop icon at WIcon's own default of 24px, which does not fit a
        28px plate.
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
 * Go up one level.
 *
 * One control, three call sites -- `NavBrowseMenu.vue`'s Browse panel header, `FileManager.vue`'s
 * toolbar and `TreeBrowserDialog.vue`'s folder row. The design (`docs/ui-redesign-supplementary/
 * Cardinal Wiki - Menus 3x.dc.html`, "03 -- Up one level") calls for the same 28px plate carrying the
 * same meaning at all three, so the plate, the absent-at-the-root rule, the slide-in, the 70%-at-rest
 * glyph and the accent focus ring all live here; a caller supplies only where it sits, whether it is
 * currently disabled, and what happens on click.
 *
 * NOT in `components/shared/`, deliberately. Every member of that library is a generic `W*` primitive
 * -- a button, an input, an icon -- registered globally by `boot/components.js` and again by
 * `test/setup.js`, with no vocabulary of its own. This control hard-codes an app glyph, an app locale
 * key and a tooltip; it is a piece of this application, not a piece of its component library, and
 * three named importers do not justify handing every component and every test suite in the app a new
 * global tag.
 */
const props = defineProps({
  /**
   * Whether there is a level above the one being shown. `false` removes the control from the DOM --
   * see the template comment: the design asks for absent, not disabled.
   */
  show: {
    type: Boolean,
    default: false
  },
  /** Disabled while the level it would leave is still loading. Distinct from `show`. */
  disabled: {
    type: Boolean,
    default: false
  },
  /**
   * Surface-specific treatment for the plate, composed onto the button.
   *
   * `acrylic-btn` (`css/_base.scss`) travels this way rather than being baked in: it is the
   * translucent-menu treatment, correct in the Browse panel and wrong on the two opaque surfaces the
   * other two call sites sit on.
   */
  plateClass: {
    type: [String, Array, Object],
    default: null
  },
  /** Passed straight to the tooltip, for a call site whose default placement would be clipped. */
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
  The transition wraps a single child, so a fallthrough `class` would land on the SLOT rather than on
  the plate inside it -- silently styling the animated footprint instead of the button. `plateClass`
  is the supported way in, and this is what keeps the two from being confusable.
*/
defineOptions({ inheritAttrs: false })

const { t } = useI18n()
</script>

<style>
/*
  A 28px square plate.

  `dense` already lands WBtn on 28px tall -- `min-height: 2.24em` against the 12.5px it sets on itself
  -- but its dense padding (`0 0.8em`, 10px a side) makes the box 38px wide around an 18px glyph, so
  the plate is not actually square. The padding goes through the `padding` prop rather than a rule
  here, because WBtn writes both as inline styles that a stylesheet could not beat; `width`/`height`
  then state the square outright, since neither of those two is what WBtn sets inline.
*/
.up-one-level-btn.w-btn {
  width: 28px;
  height: 28px;
}

/* -> Dimmed at rest: it is the one control up here, and it should not compete with the name beside
      it. Full strength once the pointer is on it. */
.up-one-level-btn .w-icon {
  opacity: 0.7;
}

.up-one-level-btn:hover .w-icon {
  opacity: 1;
}

/*
  The accent focus ring. WBtn already draws a 2px ring 2px clear of its own box
  (`outline-offset-2 focus-visible:outline-2`); only the colour is stated here, since the ring's
  default is `currentColor` -- the same dimmed glyph tone the plate is trying not to compete with.
*/
.up-one-level-btn:focus-visible {
  outline-color: var(--color-accent);
}

.body--dark .up-one-level-btn:focus-visible {
  outline-color: var(--color-accent-dark);
}

/*
  The plate's footprint, as its own element: `width` is what animates, so the space closes up WITH the
  button rather than after it. Sized to match the plate, which fills it exactly, plus the gap that
  separates it from whatever is beside it -- which belongs to the button, and so goes when it goes.
*/
.up-one-level-slot {
  flex: none;
  width: 28px;
  margin-inline-end: 12px;
}

/*
  Clipped only while it moves. At rest the slot must not clip, or it would cut off the focus ring the
  button draws just outside its own box.
*/
.up-one-level-enter-active,
.up-one-level-leave-active {
  overflow: hidden;
  transition:
    width 0.18s var(--ease-standard),
    margin-inline-end 0.18s var(--ease-standard),
    opacity 0.18s var(--ease-standard);
}

/* -> The slide itself is on the button: a percentage transform on the slot would resolve against a
      width that is zero at exactly that moment, and move nothing */
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

/* -> A physical translate, unlike everything else here: CSS has no logical equivalent, and the slot's
      own width/margin animation (which IS logical) is what actually opens and closes the space. Under
      `dir="rtl"` the plate therefore travels the same 28px, just from the other side of its slot. */
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
