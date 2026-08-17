<template>
  <section class="page-comments">
    <header class="page-comments-header flex items-center gap-2">
      <h2 class="text-h6 m-0">{{ t(`common.comments.title`) }}</h2>
      <span class="page-comments-count text-caption text-grey-6">{{
        pageStore.commentsCount
      }}</span>
    </header>

    <div v-if="loading" class="page-comments-loading flex items-center gap-2 py-4 text-grey-6">
      <w-spinner size="20px" />
      <span>{{ t(`common.comments.loading`) }}</span>
    </div>

    <!--
      Distinguishes an invitation to write the first comment from a flat "there are none" -- the
      former would be misleading (and clutter a read-only visitor's screen with a call to action they
      cannot act on) for anyone who does not hold `write:comments` at this path. Page-scoped, per
      CLAUDE.md's permissions section: `can()` also ORs in the global list and treats `manage:system`
      as a wildcard, which is what lets an administrator see the same invitation everywhere.
    -->
    <div v-else-if="flatComments.length === 0" class="page-comments-empty py-4 text-grey-6">
      {{ canWrite ? t(`common.comments.beFirst`) : t(`common.comments.none`) }}
    </div>

    <ul v-else class="page-comments-list flex flex-col gap-4">
      <li
        v-for="entry in flatComments"
        :key="entry.comment.id"
        class="page-comments-item"
        :style="{ marginInlineStart: `${entry.depth * INDENT_PX}px` }">
        <div class="page-comments-card flex gap-3">
          <w-avatar size="sm" color="primary" text-color="white">{{
            initialsFor(entry.comment)
          }}</w-avatar>
          <div class="min-w-0 flex-1">
            <div class="page-comments-meta flex flex-wrap items-baseline gap-2">
              <strong>{{ entry.comment.authorName }}</strong>
              <span class="text-caption text-grey-6">
                {{ userStore.formatDateTime(t, entry.comment.createdAt) }}
              </span>
            </div>
            <div v-if="isModified(entry.comment)" class="text-caption text-grey-6">
              {{
                t(`common.comments.modified`, {
                  reldate: userStore.formatDateTime(t, entry.comment.updatedAt)
                })
              }}
            </div>
            <!--
              Server-rendered, sanitized HTML -- `comment.render`, never `comment.content` -- the same
              contract `pageStore.render` is consumed under in `Index.vue`. Populating `render` is
              Feature 390's job; until then this is empty and the card shows no body, which is the
              correct rendering of "nothing to show yet" rather than a reason to fall back to the raw,
              unsanitized markdown source.
            -->
            <div class="page-comments-content" v-html="entry.comment.render" />
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * Page-view comments list.
 *
 * The top-level section for Feature 392: header + live count, loading/empty states, and the threaded
 * list itself. Deliberately just the reading surface -- the composer (new comment / reply / guest
 * identity capture) and the edit/delete affordances are separate tasks of the same feature, and
 * `Index.vue` wiring (where this mounts, gated on `siteStore.features.comments && pageStore.allowComments`)
 * is a further one; this component is self-contained and reads `pageStore` directly rather than taking
 * page identity as a prop, so it can be dropped in once that wiring lands.
 *
 * Comments come back from Feature 391's list endpoint already threaded server-side --
 * `Comments.listForPage()` (`backend/models/comments.ts`) does one flat, `createdAt`-ordered query and
 * nests each reply under its parent via a `replies` array before the route ever hands it back, rather
 * than shipping a flat `{ ..., replyTo }[]` for the client to re-derive structure from. That tree is
 * flattened again here into `flatComments`, in the same depth-first order, purely to cap the visual
 * indent at {@link MAX_DEPTH} levels -- 2.5.x never had nesting to draw a line at, so this fork picks
 * a small constant rather than letting a deep reply chain run the indent off the side of the card.
 */

const { t } = useI18n()

const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

/** Visual indent cap, in levels. A reply past this depth still renders, just flush with level 3. */
const MAX_DEPTH = 3
/** Indent per level, in pixels. */
const INDENT_PX = 32

/** Whether this reader may post here, i.e. the empty state should invite rather than just inform. */
const canWrite = computed(() => userStore.can('write:comments'))

const loading = ref(true)
/** The threaded tree exactly as Feature 391's list endpoint returns it -- see the component doc above. */
const comments = ref([])

/**
 * `comments`, walked depth-first into a flat `{ comment, depth }[]` with `depth` capped at
 * {@link MAX_DEPTH} -- a reply's card sits immediately after its parent's, indented one level more,
 * until the cap is reached, after which every deeper reply still follows immediately but stops
 * indenting further.
 */
const flatComments = computed(() => flatten(comments.value, 0))

function flatten(nodes, depth) {
  const cappedDepth = Math.min(depth, MAX_DEPTH)
  return nodes.flatMap((comment) => [
    { comment, depth: cappedDepth },
    ...flatten(comment.replies ?? [], depth + 1)
  ])
}

/**
 * Initials for the avatar: a guest (no `authorId`) gets a single initial off `authorName`, which the
 * server already resolved to `guestName` for that case; an account holder gets up to two, one per
 * word of their display name, so "Jane Doe" reads as "JD" rather than just "J".
 */
function initialsFor(comment) {
  const name = comment.authorName ?? ''
  if (!comment.authorId) {
    return name.charAt(0).toUpperCase()
  }
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('')
}

function isModified(comment) {
  return Boolean(comment.updatedAt) && comment.updatedAt !== comment.createdAt
}

/**
 * Fetches this page's comments. A no-op while `pageStore.id` is not yet known -- e.g. the very first
 * tick of a page still loading -- rather than firing a request against a malformed URL; the `watch`
 * below re-runs this once an id arrives.
 */
async function fetchComments() {
  if (!pageStore.id) {
    return
  }
  loading.value = true
  try {
    comments.value = await API_CLIENT.get(
      `sites/${siteStore.id}/pages/${pageStore.id}/comments`
    ).json()
  } catch (err) {
    notify({
      type: 'negative',
      message: t(`common.error.generic.title`),
      caption: apiErrorMessage(err)
    })
  } finally {
    loading.value = false
  }
}

onMounted(fetchComments)
// -> SPA navigation between pages does not remount this component, so a fresh `pageStore.id` is the
//    only signal that there is a different page's comments to fetch.
watch(() => pageStore.id, fetchComments)
</script>

<style scoped>
.page-comments-content :deep(p:first-child) {
  margin-top: 0;
}
</style>
