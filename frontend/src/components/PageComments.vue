<template>
  <section class="page-comments">
    <header class="page-comments-header flex items-center gap-2">
      <h2 class="text-h6 m-0">{{ t(`common.comments.title`) }}</h2>
      <span class="page-comments-count text-caption text-grey-6">{{
        pageStore.commentsCount
      }}</span>
    </header>

    <CommentComposer v-if="canWrite" class="page-comments-composer mb-4" @posted="onPosted" />

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
        <div class="page-comments-card group flex gap-3">
          <w-avatar size="sm" color="primary" text-color="white">{{
            initialsFor(entry.comment)
          }}</w-avatar>
          <div class="min-w-0 flex-1">
            <div class="page-comments-meta flex flex-wrap items-baseline gap-2">
              <strong>{{ entry.comment.authorName }}</strong>
              <span class="text-caption text-grey-6">
                {{ userStore.formatDateTime(t, entry.comment.createdAt) }}
              </span>

              <!--
                Hover-revealed, per `group-hover` on `.page-comments-card` above --
                `focus-within:opacity-100` keeps them reachable by keyboard, since a real `:hover`
                never fires for a tab-focused button. Gated on `canModerate`, not per-comment: see
                that computed's doc comment for why.
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
            <div v-if="isModified(entry.comment)" class="text-caption text-grey-6">
              {{
                t(`common.comments.modified`, {
                  reldate: userStore.formatDateTime(t, entry.comment.updatedAt)
                })
              }}
            </div>
            <!--
              Editing swaps this same slot for a plain-markdown textarea (`editingIds`); see the
              `saveEdit`/`cancelEdit` doc comments below. Not editing: server-rendered, sanitized HTML
              -- `comment.render`, never `comment.content` -- the same contract `pageStore.render` is
              consumed under in `Index.vue`. Populating `render` is Feature 390's job; until then this
              is empty and the card shows no body, which is the correct rendering of "nothing to show
              yet" rather than a reason to fall back to the raw, unsanitized markdown source.
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
            <div v-else class="page-comments-content" v-html="entry.comment.render" />

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

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

/**
 * Page-view comments list.
 *
 * The top-level section for Feature 392: header + live count, loading/empty states, the threaded
 * list itself, and the composer -- a new top-level comment (`CommentComposer.vue`, mounted once,
 * always visible when `canWrite`) plus, per comment, a small 'Reply' affordance that toggles open a
 * second instance of the same composer scoped to that comment via `replyTo`. Guest-name/email capture
 * and client-side validation both live inside `CommentComposer.vue` itself. The edit/delete
 * affordances are a separate task of the same feature, and so is `Index.vue` wiring (where this
 * mounts, gated on `siteStore.features.comments && pageStore.allowComments`); this component is
 * self-contained and reads `pageStore` directly rather than taking page identity as a prop, so it can
 * be dropped in once that wiring lands.
 *
 * Comments come back from Feature 391's list endpoint already threaded server-side --
 * `Comments.listForPage()` (`backend/models/comments.ts`) does one flat, `createdAt`-ordered query and
 * nests each reply under its parent via a `replies` array before the route ever hands it back, rather
 * than shipping a flat `{ ..., replyTo }[]` for the client to re-derive structure from. That tree is
 * flattened again here into `flatComments`, in the same depth-first order, purely to cap the visual
 * indent at {@link MAX_DEPTH} levels -- 2.5.x never had nesting to draw a line at, so this fork picks
 * a small constant rather than letting a deep reply chain run the indent off the side of the card.
 *
 * A freshly-posted comment is spliced straight into `comments` by `onPosted` (into the matching
 * parent's `replies` for a reply, appended top-level otherwise) rather than re-fetching the whole
 * list, and bumps `pageStore.commentsCount` by one -- both list and header count stay live with no
 * extra round trip.
 *
 * Edit/delete (task 630): a hover-revealed pencil/trash pair per comment, gated on `canModerate` --
 * see that computed's doc comment for why this reads a single global permission rather than a
 * per-comment flag. Edit swaps the card's rendered body for a `w-input` textarea pre-filled with
 * `comment.content` (raw markdown, matching what `CommentComposer.vue`'s own textarea edits) and
 * PATCHes on save. Delete opens `confirm()` and DELETEs on confirmation; the server cascades a
 * delete to a comment's replies (`Comments.delete()`, `backend/models/comments.ts` on
 * `feature/comments-data-model`, inspected read-only -- its own doc comment says so explicitly), so
 * this component mirrors that rather than inventing separate orphan/reparent semantics: `deleteComment`
 * removes the whole subtree client-side and decrements `commentsCount` by its full size, not just
 * one.
 *
 * Cross-branch note: `feature/comments-rest-api` -- Feature 391's shipped route, inspected read-only
 * the same way -- confirms the PATCH/DELETE URLs this component posts to
 * (`sites/:siteId/pages/:pageId/comments/:commentId`) and that a comment's own author may self-edit
 * or self-delete without `manage:comments` (`maySelfModerate()` there). Neither route puts that
 * decision on the wire as a flag, though, which is the gap `canModerate` documents.
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

/**
 * Whether this viewer sees edit/delete controls, on ANY comment on this page.
 *
 * The spec for this control (task 630) is to read a per-comment capability flag off the comment
 * object -- `comment.canEdit` / `comment.canDelete` -- straight from Feature 391's list response,
 * precisely so this component does not re-derive the author-vs-`manage:comments` decision that 391
 * owns (`maySelfModerate()` in `backend/api/comments.ts`). As shipped on `feature/comments-rest-api`
 * (inspected read-only for this task -- see the file-level doc comment above), `toPublicComment()`
 * sends `authorId`, never a resolved boolean, so there is no such flag on the wire to read yet.
 *
 * Per that same task's explicit fallback, this gates on the global `manage:comments` permission
 * alone until 391 ships the flags. A comment's own author therefore cannot edit/delete their own
 * comment through this UI in the meantime, even though the server already allows it for them --
 * a real gap, not a design choice, and one only 391 can close by putting the flags on the wire.
 */
const canModerate = computed(() => userStore.can('manage:comments'))

const loading = ref(true)
/** The threaded tree exactly as Feature 391's list endpoint returns it -- see the component doc above. */
const comments = ref([])

/** Comment ids whose inline reply composer is currently open. */
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

/** Depth-first search of the threaded tree for the comment with `id`, or null if none matches. */
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

/**
 * Handles `CommentComposer`'s `posted` event, from either the top composer or a comment's reply
 * box: splices the new comment straight into `comments` -- under its parent's `replies` when it is a
 * reply, appended top-level otherwise -- closes that reply box if it was one, and bumps the live
 * header count. No re-fetch: the server already handed back everything the list needs to show it.
 */
function onPosted(newComment) {
  if (newComment.replyTo) {
    const parent = findNode(comments.value, newComment.replyTo)
    if (parent) {
      parent.replies = [...(parent.replies ?? []), newComment]
    } else {
      // -> Parent not found in the currently loaded tree (should not happen): still show the new
      //    comment rather than silently drop it.
      comments.value = [...comments.value, newComment]
    }
    closeReply(newComment.replyTo)
  } else {
    comments.value = [...comments.value, newComment]
  }
  pageStore.commentsCount += 1
}

/** Comment ids currently showing their edit textarea instead of rendered body. */
const editingIds = ref(new Set())
/** Comment ids whose PATCH is currently in flight, for the Update button's `:loading`. */
const editSubmittingIds = ref(new Set())
/** Draft content per comment id currently being edited, keyed by id. */
const editDrafts = ref({})
/** `w-input` component instances for the open edit textareas, keyed by comment id -- `validate()` is
 *  called on the right one before a save, the same way `CommentComposer.vue`'s `composerForm` ref
 *  gates its own submit. A plain `Map`, not a ref: it holds component instances, not data to react
 *  to, and several can be open at once (one per comment in edit mode). */
const editInputRefs = new Map()

function setEditInputRef(id, el) {
  if (el) {
    editInputRefs.set(id, el)
  } else {
    editInputRefs.delete(id)
  }
}

/** Same threshold as `CommentComposer.vue`'s `contentRules` -- an edit is held to the same bar a new
 *  comment is. */
const editContentRules = [
  (val) => (val ?? '').trim().length >= 2 || t(`common.comments.contentMissingError`)
]

function startEdit(comment) {
  editDrafts.value[comment.id] = comment.content
  editingIds.value.add(comment.id)
  /*
    The textarea doesn't exist until this reactive update lands (it's `v-if`, swapping in for the
    rendered body), so the `ref` callback -- `setEditInputRef` -- hasn't populated `editInputRefs` for
    this id yet at this point in the same tick. `nextTick` waits for that render before looking it up.
  */
  nextTick(() => {
    editInputRefs.get(comment.id)?.focus()
  })
}

function cancelEdit(id) {
  editingIds.value.delete(id)
  delete editDrafts.value[id]
  editInputRefs.delete(id)
}

/**
 * PATCHes `comment`'s content and, on success, writes the server's response straight onto the same
 * node object already in `comments` -- it is mutated in place rather than re-spliced, since `entry`
 * (and therefore `comment`) is a reference into the reactive tree, not a copy.
 */
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
    // -> The API client does not throw for a 400, so a refusal comes back as a parsed error
    //    envelope rather than a rejection: without this check it reads as a successful edit.
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

/** `comment` plus every reply under it, recursively -- how many rows a delete of `comment` removes. */
function countCommentTree(comment) {
  return 1 + (comment.replies ?? []).reduce((sum, reply) => sum + countCommentTree(reply), 0)
}

/** `nodes` with the comment named `id`, and everything under it, filtered out -- immutable, matching
 *  `onPosted`'s style of replacing arrays rather than splicing them in place. */
function removeCommentFromTree(nodes, id) {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({ ...node, replies: removeCommentFromTree(node.replies ?? [], id) }))
}

/**
 * Opens the shared `confirm()` dialog and, on confirmation, DELETEs `comment`.
 *
 * The server cascades a delete to every reply under the deleted comment (`Comments.delete()`,
 * `backend/models/comments.ts` on `feature/comments-data-model` -- its own doc comment: "Cascades to
 * its replies via the `replyTo` foreign key"). This mirrors that rather than inventing separate
 * client-side semantics: the whole subtree is removed from `comments` and `pageStore.commentsCount`
 * drops by its full size ({@link countCommentTree}), not just one.
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
    // -> The API client does not throw for a 400, so a refusal comes back as a response with
    //    `ok: false` rather than a rejection: without this check it reads as a successful delete.
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
