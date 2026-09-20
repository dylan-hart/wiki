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
        <div v-else-if="state.draft" ref="diffEl" class="draft-diff mt-2" />
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
import { onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { useMonacoDiff } from '@/composables/monacoDiff'

/**
 * Bespoke rather than a `confirm()`: the generic dialog shows a title and a message and nothing
 * else, and this prompt shows the draft itself as a diff against what the editor holds now. Hence
 * the draft being fetched as the prompt OPENS rather than on Restore, and both halves of the
 * comparison arriving as props. Every side effect -- applying, discarding, the toasts -- stays with
 * the caller; this component only answers the question.
 */
const props = defineProps({
  authorName: {
    type: String,
    required: false,
    default: null
  },
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

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const { t } = useI18n()

const state = reactive({
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

const diffEl = ref(null)
const { showDiff, disposeEditor } = useMonacoDiff(diffEl, { isInline: () => true })

onUnmounted(disposeEditor)

/*
  Both halves have to hold before `diffEl` exists to mount into, and either can land first: a cached
  `draftRequest` regularly resolves before `<w-dialog>` has rendered its panel, so showing the diff
  from the `.then()` above would silently find no container and never be retried.
*/
watch(
  () => dialogVisible.value && Boolean(state.draft),
  (ready) => {
    if (!ready) {
      return
    }
    showDiff({
      original: { text: props.currentContent, language: 'markdown' },
      modified: { text: state.draft.content ?? '', language: 'markdown' },
      scrollToFirstChange: true
    })
  }
)
</script>

<style>
/*
  A fixed height plus `overflow: hidden` is enough for this prompt-sized pane: Monaco's
  `automaticLayout` fills exactly this box and its own scrollbar handles anything taller.

  FIXME: `rgba(#fff, 0.08)` is Sass syntax, invalid in plain CSS, so the border below never renders.
  Write the color as `rgb(255 255 255 / 8%)`. `PageSaveConflictDialog.vue` carries the same bug.
*/
.draft-diff {
  height: 240px;
  border: 1px solid rgb(255 255 255 / 8%);
  overflow: hidden;
}
</style>
