<template>
  <!--
    The root has to stay a single element for `class="me-2"` fallthrough from `PageHeader.vue` to
    still land on `.collab-presence` (see `inheritAttrs: false` below) -- so the announcement region
    below is a sibling INSIDE it, not a sibling of it. It contributes no box of its own (an empty div
    around a single `position: absolute` child collapses to 0x0), so it costs no layout.
  -->
  <div>
    <!--
      Always in the DOM rather than appearing along with its first announcement: a live region has to
      already exist for assistive tech to pick up a change inside it, and one that appears with its
      text already filled in is not reliably announced.
    -->
    <span class="sr-only" role="status" aria-live="polite">{{ announcement }}</span>
    <!-- Nothing at all when you are on your own: a bubble of your own face says nothing new. -->
    <div
      v-if="collabStore.people.length > 1"
      v-bind="$attrs"
      class="collab-presence"
      role="group"
      :aria-label="t('editor.collab.participants')">
      <!--
        The bubble is wrapped rather than styled alone because it clips the avatar to a circle, and a
        ring rippling outwards from it would be cut off at the very edge it is supposed to leave.
      -->
      <div
        v-for="person of visible"
        :key="person.id"
        class="collab-presence-person"
        :class="{ 'is-typing': person.typing }">
        <span
          class="collab-presence-wave"
          :style="{ borderColor: person.color }"
          aria-hidden="true" />
        <div class="collab-presence-bubble" :style="{ backgroundColor: person.color }">
          <!--
            No `alt`: the name is already on the group's label and in the tooltip, and an avatar that
            fails to load should fall back to the coloured circle, not to the person's name in plain
            text across the header.
          -->
          <img
            v-if="person.hasAvatar"
            :src="`/_user/${person.id}/avatar`"
            alt=""
            loading="lazy"
            width="30"
            height="30" />
          <!-- -> A manual upload always wins; the provider-synced picture is only a fallback -->
          <img
            v-else-if="person.avatarProviderUrl"
            :src="person.avatarProviderUrl"
            alt=""
            loading="lazy"
            width="30"
            height="30" />
          <span v-else>{{ initials(person.name) }}</span>
        </div>
        <w-tooltip>
          {{ personLabel(person) }}
        </w-tooltip>
      </div>
      <!-- The count pulses on behalf of whoever it stands in for, so typing out of sight still shows. -->
      <div
        v-if="overflow > 0"
        class="collab-presence-person collab-presence-person--overflow"
        :class="{ 'is-typing': overflowTyping }">
        <span class="collab-presence-wave" aria-hidden="true" />
        <div class="collab-presence-bubble collab-presence-overflow">+{{ overflow }}</div>
        <w-tooltip>{{ overflowNames }}</w-tooltip>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { initials } from '@/helpers/initials'
import { useCollabStore } from '@/stores/collab'

/**
 * Fed entirely by `stores/collab.js`, so this is empty whenever there is no session — which covers
 * the site having the feature off, the editor being anything other than markdown, and an edit being
 * suggested rather than made.
 */

defineOptions({ inheritAttrs: false })

const collabStore = useCollabStore()

const { t } = useI18n()

/** Past this many the row starts costing more space than it is worth, and the rest become a count. */
const MAX_VISIBLE = 4

const visible = computed(() => collabStore.people.slice(0, MAX_VISIBLE))
const hidden = computed(() => collabStore.people.slice(MAX_VISIBLE))
const overflow = computed(() => hidden.value.length)
const overflowTyping = computed(() => hidden.value.some((person) => person.typing))
const overflowNames = computed(() => hidden.value.map(personLabel).join(', '))

/**
 * The `aria-live` text: fires the moment somebody OTHER than the reader first shows up among
 * `collabStore.people` -- off the deduplicated person, not the raw `participants` list, so a second
 * tab from someone already on-screen says nothing new.
 *
 * One-directional on purpose: a departure stays visually obvious but silent. Arriving is the moment
 * someone needs to be told they are not alone in the document; announcing every departure would fire
 * on each drop of a merely flaky connection.
 */
const announcement = ref('')
let knownIds = new Set(nonSelfIds())

function nonSelfIds() {
  return collabStore.people.filter((person) => !person.isSelf).map((person) => person.id)
}

watch(nonSelfIds, (ids) => {
  const joinedId = ids.find((id) => !knownIds.has(id))
  if (joinedId) {
    const person = collabStore.people.find((candidate) => candidate.id === joinedId)
    announcement.value = t('editor.collab.editingWithYou', { name: person.name })
  }
  knownIds = new Set(ids)
})

function personLabel(person) {
  return person.isSelf ? t('editor.collab.you') : person.name
}
</script>

<style scoped>
/* These selectors stay flat: a `&-suffix` concatenation is a Sass idiom, and native CSS nesting
   silently drops such a rule rather than matching it. */
@charset "UTF-8";
.collab-presence {
  display: flex;
  align-items: center;
  /* -> Leaves the leftmost bubble's own overlap margin with nothing to overlap into */
  padding-inline-start: 8px;
}
.collab-presence-person {
  position: relative;
  /* -> The overlap that makes the row read as a group rather than a list of separate faces */
  margin-inline-start: -8px;
}
.collab-presence {
  /*
    The ripple sits under the faces rather than over them -- `z-index: 0` against the bubbles' `1` --
    so a wave passing the next avatar along does not wash over it.
  */
}
.collab-presence-wave {
  position: absolute;
  z-index: 0;
  inset: 0;
  border-radius: 9999px;
  border: 1px solid transparent;
  opacity: 0;
  pointer-events: none;
}
.collab-presence-person.is-typing .collab-presence-wave {
  animation: collab-presence-wave 1.6s ease-out infinite;
}
.collab-presence-bubble {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 9999px;
  color: #fff;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  overflow: hidden;
  user-select: none;
  /*
    The ring is what stops two adjacent faces from reading as one shape, so it has to be the header
    behind them rather than a fixed colour — near-white on one theme, near-black on the other.
  */
}
.body--light .collab-presence-bubble {
  box-shadow: 0 0 0 2px var(--color-surface);
}
.body--dark .collab-presence-bubble {
  box-shadow: 0 0 0 2px var(--color-dark-3);
}
.collab-presence-bubble img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.body--light .collab-presence-overflow {
  background-color: var(--color-grey-6);
}
.body--dark .collab-presence-overflow {
  background-color: var(--color-grey-8);
}
.collab-presence {
  /*
    The count stands in for several people at once and so has no one colour to ripple in; it borrows
    the grey it is drawn in. Every other wave takes its owner's colour, inline.
  */
}
.body--light .collab-presence-person--overflow .collab-presence-wave {
  border-color: var(--color-grey-6);
}
.body--dark .collab-presence-person--overflow .collab-presence-wave {
  border-color: var(--color-grey-8);
}

@keyframes collab-presence-wave {
  0% {
    transform: scale(1);
    opacity: 0.35;
  }
  100% {
    transform: scale(2);
    opacity: 0;
  }
}

/*
  A ring that never stops moving is what someone asking for less motion asked to be spared, but the
  information it carries -- who is typing -- would go with it. So it holds still instead.
*/
@media (prefers-reduced-motion: reduce) {
  .collab-presence-person.is-typing .collab-presence-wave {
    animation: none;
    transform: scale(1.35);
    /* -> Held a little stronger than the moving ring, having only stillness to be noticed by */
    opacity: 0.45;
  }
}
</style>
