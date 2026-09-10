<template>
  <w-dialog
    v-model="dialogVisible"
    persistent
    :aria-label="t(`editor.collab.draftRecovery.title`)"
    @hide="onDialogHide">
    <w-card style="min-width: 450px; max-width: 640px">
      <w-card-section class="card-header">
        <w-icon name="tabler:history" size="sm" class="me-2" />
        <span>{{ t(`editor.collab.draftRecovery.title`) }}</span>
      </w-card-section>
      <w-card-section>
        <div class="text-body2">
          {{
            props.authorName
              ? t(`editor.collab.draftRecovery.messageBy`, { authorName: props.authorName })
              : t(`editor.collab.draftRecovery.message`)
          }}
        </div>
        <div v-if="state.loading" class="text-caption text-grey mt-2" aria-live="polite">
          {{ t(`editor.collab.draftRecovery.loading`) }}
        </div>
        <div
          v-else-if="state.loadFailed"
          class="text-caption text-negative mt-2"
          aria-live="polite">
          {{ t(`editor.collab.draftRecovery.loadFailed`) }}
        </div>
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`editor.collab.draftRecovery.discard`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          :label="t(`editor.collab.draftRecovery.restore`)"
          color="primary"
          padding="xs md"
          :loading="state.loading"
          @click="onDialogOK(true)" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'

/**
 * The recovery-draft prompt (OpenProject #2455), opened by `composables/collab.js#offerDraftRestore`
 * once a collaboration session's first sync lands on a page whose room last closed with unsaved
 * edits.
 *
 * Bespoke rather than a `confirm()` (OpenProject #2897/#2929): the generic `WConfirmDialog` can show
 * a title and a message and nothing else, and this prompt is about to show the draft itself -- a
 * compact diff of what the draft would change against what the editor holds now. That is why the
 * draft is fetched the moment the prompt OPENS rather than once Restore is clicked, and why both
 * halves of that comparison arrive here as props: `draftRequest`, the in-flight fetch of the stored
 * draft, and `currentContent`, the room's live content at the moment the prompt went up. The caller
 * keeps every side effect (applying the restore, discarding the stored draft, the toasts); this
 * component only answers the question.
 */
const props = defineProps({
  /** Who was last known to be editing when the draft was recorded, or null when unattributed. */
  authorName: {
    type: String,
    required: false,
    default: null
  },
  /** The editor's content as it stood when the prompt opened -- the "before" of any comparison. */
  currentContent: {
    type: String,
    required: false,
    default: ''
  },
  /**
   * The `GET sites/:siteId/pages/:pageId/draft` call, already in flight when the prompt opens.
   * Resolves to `{ content, title, description, icon, authorName, updatedAt }`; a rejection is
   * reported as a caption here and is the caller's to recover from on Restore.
   */
  draftRequest: {
    type: Promise,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  /** The resolved draft, once `draftRequest` settles successfully. */
  draft: null,
  loading: true,
  loadFailed: false
})

/*
  Neither outcome disables a button: Restore stays available on a failed fetch because the caller
  retries the request when it confirms, and Discard never needed the content in the first place.
*/
props.draftRequest.then(
  (draft) => {
    state.draft = draft
    state.loading = false
  },
  () => {
    state.loadFailed = true
    state.loading = false
  }
)
</script>
