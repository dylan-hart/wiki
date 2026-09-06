<template>
  <!--
    The root has to stay a single element for `class="me-2"` fallthrough from `PageHeader.vue` to
    still land on `.collab-presence` (see `inheritAttrs: false` below) -- so the always-present
    announcement region below is a sibling INSIDE it, not a sibling of it. It contributes no box of
    its own (an empty div around a single `position: absolute` child collapses to 0x0), so it changes
    nothing about the "nothing at all when alone" layout the group div below still governs.
  -->
  <div>
    <!--
      Screen-reader-only, and deliberately always in the DOM rather than appearing along with its
      first announcement -- a live region has to already exist for assistive tech to pick up a change
      inside it; one that appears with its text already filled in is not reliably announced. See
      `announcement` for what fires it and, as importantly, what does not.
    -->
    <span class="sr-only" role="status" aria-live="polite">{{ announcement }}</span>
    <!--
      Nothing at all when you are on your own, which is the ordinary case: a single bubble of your own
      face says nothing you did not already know, and the header has better uses for the space.
    -->
    <div
      v-if="collabStore.people.length > 1"
      v-bind="$attrs"
      class="collab-presence"
      role="group"
      :aria-label="t('editor.collab.participants')">
      <!--
        The bubble is wrapped rather than styled alone because it has to clip the avatar to a circle,
        and a ring rippling outwards from something that clips its own children would be cut off at the
        edge it is supposed to leave.
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
            fails to load should fall back to the coloured circle rather than to the person's name in
            plain text across the header.
          -->
          <img
            v-if="person.hasAvatar"
            :src="`/_user/${person.id}/avatar`"
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
      <!--
        The count pulses on behalf of whoever it is standing in for, so that someone typing out of sight
        is not simply invisible.
      -->
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

import { useCollabStore } from '@/stores/collab'

/**
 * Who is editing this page right now, as a row of overlapping faces in the page header.
 *
 * Fed entirely by `stores/collab.js`, so it is empty whenever there is no session — which covers the
 * site having the feature off, the editor being anything other than markdown, and an edit being
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
 * The `aria-live` text: fires `editor.collab.editingWithYou` the moment somebody OTHER than the
 * reader first shows up among `collabStore.people` -- i.e. off the deduplicated person, not off the
 * raw `participants` list, so a second tab from someone already on-screen says nothing new.
 *
 * One-directional on purpose. There is no string for someone LEAVING -- `editingWithYou` reads as a
 * presence, not an absence, and coining new copy for it is a bigger call than this task's -- so a
 * departure stays visually obvious (their face leaves the row) but silent for a screen-reader user.
 * That is a real, considered trade, not an oversight: arriving is the moment someone needs to be told
 * "you are not alone in this document any more"; leaving mid-edit is lower-stakes, and announcing it
 * on every drop of a merely flaky connection (see the `disconnected` indicator in `PageHeader.vue`)
 * would be noise closer to what a `disconnected`-triggered departure already looks like without help.
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

/** A participant's name, or `You` for the reader's own face. */
function personLabel(person) {
  return person.isSelf ? t('editor.collab.you') : person.name
}

/**
 * Up to two letters, from the first and last word of the name — `Ada Lovelace` gives `AL`, and a
 * mononym gives its first letter. Falls back to a neutral glyph rather than an empty circle for an
 * account with no name on it.
 */
function initials(name) {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length < 1) {
    return '?'
  }
  const first = words[0][0]
  const last = words.length > 1 ? words.at(-1)[0] : ''
  return `${first}${last}`.toUpperCase()
}
</script>

<style scoped lang="scss">
.collab-presence {
  display: flex;
  align-items: center;
  /* -> Leaves the leftmost bubble's own overlap margin with nothing to overlap into */
  padding-inline-start: 8px;

  &-person {
    position: relative;
    /* -> The overlap that makes the row read as a group rather than a list of separate faces */
    margin-inline-start: -8px;
  }

  /*
    The ripple. Sits under the faces rather than over them, so a wave passing beneath the next avatar
    along does not wash over it -- `z-index: 0` against the bubbles' `1`, in document order, is what
    puts it there.
  */
  &-wave {
    position: absolute;
    z-index: 0;
    inset: 0;
    border-radius: 9999px;
    /* -> A hairline: the ring is meant to be noticed out of the corner of an eye, not read */
    border: 1px solid transparent;
    opacity: 0;
    pointer-events: none;
  }

  &-person.is-typing &-wave {
    animation: collab-presence-wave 1.6s ease-out infinite;
  }

  &-bubble {
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
      behind them rather than a fixed colour — the header is near-white on one theme and near-black
      on the other.
    */
    @at-root .body--light & {
      /* -> The header's own ground, `$surface` -- not the near-white it used to borrow from the
         Material ramp, which read as a faint grey halo against the white behind it */
      box-shadow: 0 0 0 2px $surface;
    }
    @at-root .body--dark & {
      box-shadow: 0 0 0 2px $dark-3;
    }

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  }

  &-overflow {
    @at-root .body--light & {
      background-color: $grey-6;
    }
    @at-root .body--dark & {
      background-color: $grey-8;
    }
  }

  /*
    The count stands in for several people at once and so has no one colour to ripple in; it borrows
    the grey it is drawn in. Every other wave takes its colour from its owner, inline.
  */
  &-person--overflow &-wave {
    @at-root .body--light & {
      border-color: $grey-6;
    }
    @at-root .body--dark & {
      border-color: $grey-8;
    }
  }
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
  A ring that never stops moving is exactly what someone who asked for less motion asked to be spared,
  and the information it carries -- who is typing -- would be lost with it. So it stops expanding and
  stays put instead: a steady halo that still says the same thing.
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
