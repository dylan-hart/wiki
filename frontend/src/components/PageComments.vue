<template>
  <section class="page-comments">
    <header class="page-comments-header flex items-center gap-2">
      <h2 class="text-h6 m-0">{{ t(`common.comments.title`) }}</h2>
      <span
        class="page-comments-count text-caption text-text-caption dark:text-text-caption-dark"
        >{{ pageStore.commentsCount }}</span
      >
    </header>

    <CommentComposer v-if="canWrite" class="page-comments-composer mb-4" @posted="onPosted" />

    <div
      v-if="loading"
      class="page-comments-loading flex items-center gap-2 py-4 text-text-caption dark:text-text-caption-dark">
      <w-spinner size="20px" />
      <span>{{ t(`common.comments.loading`) }}</span>
    </div>

    <div
      v-else-if="flatComments.length === 0"
      class="page-comments-empty py-4 text-text-caption dark:text-text-caption-dark">
      {{ canWrite ? t(`common.comments.beFirst`) : t(`common.comments.none`) }}
    </div>

    <ul v-else class="page-comments-list flex flex-col gap-4">
      <li
        v-for="entry in flatComments"
        :key="entry.comment.id"
        class="page-comments-item"
        :style="{ marginInlineStart: `${entry.depth * INDENT_PX}px` }">
        <div class="page-comments-card group flex gap-3">
          <w-avatar size="sm" color="primary" text-color="white">{{
            initialsFor(entry.comment)
          }}</w-avatar>
          <div class="min-w-0 flex-1">
            <div class="page-comments-meta flex flex-wrap items-baseline gap-2">
              <strong class="text-text-body dark:text-text-body-dark">{{
                entry.comment.authorName
              }}</strong>
              <span class="text-caption text-text-caption dark:text-text-caption-dark">
                {{ userStore.formatDateTime(t, entry.comment.createdAt) }}
              </span>

              <!--
                `focus-within:opacity-100` alongside the hover reveal: a real `:hover` never fires
                for a tab-focused button, so these would otherwise be invisible to the keyboard.
              -->
              <div
                v-if="canModerate"
                class="page-comments-actions ml-auto flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <w-btn
                  class="page-comments-edit-toggle"
                  icon="tabler:pencil"
                  flat
                  round
                  dense
                  size="xs"
                  :aria-label="t(`common.comments.updateComment`)"
                  @click="startEdit(entry.comment)" />
                <w-btn
                  class="page-comments-delete-toggle"
                  icon="tabler:trash"
                  flat
                  round
                  dense
                  size="xs"
                  color="negative"
                  :aria-label="t(`common.comments.deleteConfirmTitle`)"
                  @click="confirmDelete(entry.comment)" />
              </div>
            </div>
            <div
              v-if="isModified(entry.comment)"
              class="text-caption text-text-caption dark:text-text-caption-dark">
              {{
                t(`common.comments.modified`, {
                  reldate: userStore.formatDateTime(t, entry.comment.updatedAt)
                })
              }}
            </div>
            <!--
              The body is `comment.render` -- server-rendered and sanitized -- never
              `comment.content`, which is the raw, unsanitized markdown source.
            -->
            <template v-if="editingIds.has(entry.comment.id)">
              <w-input
                :ref="(el) => setEditInputRef(entry.comment.id, el)"
                v-model="editDrafts[entry.comment.id]"
                type="textarea"
                dense
                :rows="3"
                :hint="t(`common.comments.markdownFormat`)"
                :rules="editContentRules"
                lazy-rules="ondemand"
                :aria-label="t(`common.comments.fieldContent`)" />
              <div class="page-comments-edit-actions mt-2 flex flex-wrap items-center gap-3">
                <w-btn
                  dense
                  color="primary"
                  :loading="editSubmittingIds.has(entry.comment.id)"
                  :label="t(`common.comments.updateComment`)"
                  @click="saveEdit(entry.comment)" />
                <w-btn
                  flat
                  dense
                  color="grey"
                  :label="t(`common.actions.cancel`)"
                  @click="cancelEdit(entry.comment.id)" />
              </div>
            </template>
            <div v-else class="page-comments-content page-contents" v-html="entry.comment.render" />

            <div v-if="canWrite" class="page-comments-reply-row mt-2">
              <button
                type="button"
                class="page-comments-reply-toggle cursor-pointer border-0 bg-transparent p-0 text-caption text-primary hover:underline"
                @click="toggleReply(entry.comment.id)">
                {{ t(`common.comments.reply`) }}
              </button>
            </div>
            <CommentComposer
              v-if="openReplyIds.has(entry.comment.id)"
              class="page-comments-reply-composer mt-2"
              :reply-to="entry.comment.id"
              @posted="onPosted"
              @cancel="closeReply(entry.comment.id)" />
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import CommentComposer from '@/components/CommentComposer.vue'
import { confirm } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { initials } from '@/helpers/initials'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/** Page identity comes from `pageStore`, not props, so this mounts wherever the page view wants it. */

const { t } = useI18n()

const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

/** Capped so a long reply chain cannot run the indent off the side of the card. */
const MAX_DEPTH = 3
const INDENT_PX = 32

const canWrite = computed(() => userStore.can('write:comments'))

/**
 * FIXME: the list endpoint sends `authorId` but no resolved `canEdit`/`canDelete` flag, so this
 * falls back to the global `manage:comments` permission -- a comment's own author cannot edit or
 * delete their own comment here, even though `maySelfModerate()` (`backend/api/comments.ts`) lets
 * them. The fix is putting those flags on the wire and gating per comment.
 */
const canModerate = computed(() => userStore.can('manage:comments'))

const loading = ref(true)
const comments = ref([])

const openReplyIds = ref(new Set())

function toggleReply(id) {
  if (openReplyIds.value.has(id)) {
    openReplyIds.value.delete(id)
  } else {
    openReplyIds.value.add(id)
  }
}

function closeReply(id) {
  openReplyIds.value.delete(id)
}

const flatComments = computed(() => flatten(comments.value, 0))

function flatten(nodes, depth) {
  const cappedDepth = Math.min(depth, MAX_DEPTH)
  return nodes.flatMap((comment) => [
    { comment, depth: cappedDepth },
    ...flatten(comment.replies ?? [], depth + 1)
  ])
}

/**
 * An account holder goes through the shared helper so a three-part name reads the same here as in
 * the account menu and the collab strip; the single letter is a local rule for a guest, whose
 * `authorName` the server resolved from `guestName`.
 */
function initialsFor(comment) {
  const name = comment.authorName ?? ''
  if (!comment.authorId) {
    return name.charAt(0).toUpperCase()
  }
  return initials(name)
}

function isModified(comment) {
  return Boolean(comment.updatedAt) && comment.updatedAt !== comment.createdAt
}

function findNode(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) {
      return node
    }
    const found = findNode(node.replies ?? [], id)
    if (found) {
      return found
    }
  }
  return null
}

/** No re-fetch: the post response already carries everything the list needs to draw the comment. */
function onPosted(newComment) {
  if (newComment.replyTo) {
    const parent = findNode(comments.value, newComment.replyTo)
    if (parent) {
      parent.replies = [...(parent.replies ?? []), newComment]
    } else {
      // -> Parent missing from the loaded tree (should not happen): show the reply top-level rather
      //    than drop it.
      comments.value = [...comments.value, newComment]
    }
    closeReply(newComment.replyTo)
  } else {
    comments.value = [...comments.value, newComment]
  }
  pageStore.commentsCount += 1
}

const editingIds = ref(new Set())
const editSubmittingIds = ref(new Set())
const editDrafts = ref({})
/** A plain `Map`, not a ref: it holds `w-input` instances to call `validate()`/`focus()` on, not
 *  data anything renders from. */
const editInputRefs = new Map()

function setEditInputRef(id, el) {
  if (el) {
    editInputRefs.set(id, el)
  } else {
    editInputRefs.delete(id)
  }
}

/** Same threshold as `CommentComposer.vue`'s `contentRules`: an edit is held to a new comment's bar. */
const editContentRules = [
  (val) => (val ?? '').trim().length >= 2 || t(`common.comments.contentMissingError`)
]

function startEdit(comment) {
  editDrafts.value[comment.id] = comment.content
  editingIds.value.add(comment.id)
  // -> The textarea is a `v-if` swap for the rendered body, so `setEditInputRef` has not run for
  //    this id yet in this tick.
  nextTick(() => {
    editInputRefs.get(comment.id)?.focus()
  })
}

function cancelEdit(id) {
  editingIds.value.delete(id)
  delete editDrafts.value[id]
  editInputRefs.delete(id)
}

/** `comment` is a reference into the reactive tree, so the response is written onto it in place. */
async function saveEdit(comment) {
  const inputRef = editInputRefs.get(comment.id)
  if (inputRef && !(await inputRef.validate())) {
    return
  }
  editSubmittingIds.value.add(comment.id)
  try {
    const updated = await API_CLIENT.patch(
      `sites/${siteStore.id}/pages/${pageStore.id}/comments/${comment.id}`,
      { json: { content: (editDrafts.value[comment.id] ?? '').trim() } }
    ).json()
    if (updated?.ok === false) {
      throw new Error(updated.message || t(`common.error.generic.title`))
    }
    comment.content = updated.content
    comment.render = updated.render
    comment.updatedAt = updated.updatedAt
    notify({ type: 'positive', message: t(`common.comments.updateSuccess`) })
    cancelEdit(comment.id)
  } catch (err) {
    notify({
      type: 'negative',
      message: t(`common.error.generic.title`),
      caption: apiErrorMessage(err)
    })
  } finally {
    editSubmittingIds.value.delete(comment.id)
  }
}

function countCommentTree(comment) {
  return 1 + (comment.replies ?? []).reduce((sum, reply) => sum + countCommentTree(reply), 0)
}

function removeCommentFromTree(nodes, id) {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({ ...node, replies: removeCommentFromTree(node.replies ?? [], id) }))
}

/**
 * The server cascades a delete to every reply under the comment (`Comments.delete()`,
 * `backend/models/comments.ts`), so this mirrors it client-side: the whole subtree goes and
 * `commentsCount` drops by its full size, not by one.
 */
function confirmDelete(comment) {
  confirm({
    title: t(`common.comments.deleteConfirmTitle`),
    message: t(`common.comments.deleteWarn`),
    caption: t(`common.comments.deletePermanentWarn`),
    cancel: true,
    persistent: true,
    color: 'negative',
    okLabel: t(`common.actions.delete`)
  }).onOk(() => deleteComment(comment))
}

async function deleteComment(comment) {
  try {
    const resp = await API_CLIENT.delete(
      `sites/${siteStore.id}/pages/${pageStore.id}/comments/${comment.id}`
    )
    if (!resp?.ok) {
      throw new Error((await resp.json())?.message || t(`common.error.generic.title`))
    }
    comments.value = removeCommentFromTree(comments.value, comment.id)
    pageStore.commentsCount -= countCommentTree(comment)
    notify({ type: 'positive', message: t(`common.comments.deleteSuccess`) })
  } catch (err) {
    notify({
      type: 'negative',
      message: t(`common.error.generic.title`),
      caption: apiErrorMessage(err)
    })
  }
}

/**
 * A no-op while `pageStore.id` is unknown -- the first tick of a page still loading -- rather than
 * requesting a malformed URL; the `watch` below re-runs it once an id arrives.
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
// -> SPA navigation does not remount this component, so a fresh `pageStore.id` is the only signal
//    that there is a different page's comments to fetch.
watch(() => pageStore.id, fetchComments)
</script>
