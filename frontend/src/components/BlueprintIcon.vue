<template>
  <w-item-section avatar>
    <div class="blueprint-icon" :class="{ 'blueprint-icon--compact': props.compact }">
      <w-badge v-if="indicatorDot" :color="indicatorDot" floating>
        <w-tooltip v-if="props.indicatorText">{{ props.indicatorText }}</w-tooltip>
      </w-badge>
      <w-icon v-if="!textMode" :name="icon" />
      <span v-else class="blueprint-icon__text">{{ props.text }}</span>
    </div>
  </w-item-section>
</template>

<script setup>
import { computed } from 'vue'

/**
 * The icon at the head of a settings row.
 *
 * Cardinal draws it as a square hairline plate on paper with a monochrome line glyph inside, in the
 * chrome tone -- the treatment the primitives sheet's "section header & row" and the profile
 * overlay's info rows both use (`ui-redesign/Cardinal Wiki - Primitives 3x.dc.html`).
 *
 * What it replaces: a rounded blue-tinted avatar holding one of ~148 colourful `ultraviolet-*`
 * illustrations, which is where the admin area's last remaining 2.x-era artwork lived. Two props
 * went with them. `hueRotate` tinted a coloured asset by rotating its hue -- meaningless against a
 * glyph that draws in `currentColor` -- and the avatar's own `color`/`textColor` pair, which chose
 * between a light-blue and a dark-grey fill and is now the plate.
 *
 * `icon` is an ordinary Iconify reference (`tabler:key`), not an asset name assembled here: a name
 * built by concatenation is invisible to `scripts/generate-icons.mjs`'s scanner, so it would resolve
 * at runtime through `/_icons` instead of being inlined at build time -- see CLAUDE.md's note under
 * Icons, and `WIcon`'s own header.
 */
const props = defineProps({
  /** An Iconify reference, e.g. `tabler:key`. */
  icon: {
    type: String,
    default: ''
  },
  indicator: {
    type: String,
    default: null
  },
  indicatorText: {
    type: String,
    default: null
  },
  /** Two or three letters in place of a glyph, for a row identified by a code rather than a thing. */
  text: {
    type: String,
    default: null
  },
  /**
   * The smaller of the two plates the design draws: 28px rather than 34px.
   *
   * A menu opened at the pointer takes it (`PageNewMenu.vue`, in `contextMenu` mode) -- "a menu at
   * the finger should not be taller than the tree it covers", per handoff 2's own screen notes. A
   * boolean rather than a free-form `size`, because the design names exactly these two plates and
   * nothing should be able to introduce a third by passing a number.
   *
   * Off by default, so every settings row -- which is most of this component's call sites -- keeps
   * the 34px the primitives sheet measures.
   */
  compact: {
    type: Boolean,
    default: false
  }
})

// COMPUTED

const textMode = computed(() => props.text !== null)

const indicatorDot = computed(() => {
  if (props.indicator === null) {
    return null
  }
  return props.indicator === '' ? 'accent' : props.indicator
})
</script>

<style scoped>
/*
  34px is the primitives sheet's own measurement, and the glyph inside it is half that -- which is
  what leaves the plate reading as a frame rather than as a border drawn tight around an icon.
*/
.blueprint-icon {
  position: relative;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--color-hairline);
  background-color: var(--color-paper);
  color: var(--color-slate);
  font-size: 17px;
}

/*
  The pointer-anchored variant. 28px with a 15px glyph -- the same ratio held a little tighter, which
  is what the design draws rather than a proportional scale of the 34px plate.
*/
.blueprint-icon--compact {
  width: 28px;
  height: 28px;
  font-size: 15px;
}

:global(body.body--dark) .blueprint-icon {
  border-color: var(--color-hairline-dark);
  background-color: var(--color-dark-4);
  color: var(--color-slate-light);
}

/* -> A code rather than a glyph: mono, because that is what Cardinal sets every short code in */
.blueprint-icon__text {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
</style>
