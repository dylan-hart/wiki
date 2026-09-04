<template>
  <w-dialog
    v-model="dialogVisible"
    persistent
    full-width
    max-width="900px"
    :aria-label="t(`editor.collab.saveConflict.title`)"
    @hide="onDialogHide">
    <w-card style="min-width: 450px">
      <w-card-section class="card-header">
        <w-icon name="mdi:source-branch-sync" size="sm" class="me-2" />
        <span>{{ t(`editor.collab.saveConflict.title`) }}</span>
      </w-card-section>
      <w-card-section class="pb-0">
        <div class="text-body2">
          {{ t(`editor.collab.saveConflict.message`, { authorName: props.authorName }) }}
        </div>
      </w-card-section>
      <w-card-section>
        <div class="save-conflict-diff-labels">
          <span>{{ t(`editor.collab.saveConflict.serverVersion`) }}</span>
          <span>{{ t(`editor.collab.saveConflict.yourVersion`) }}</span>
        </div>
        <div ref="diffEl" class="save-conflict-diff" />
      </w-card-section>
      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`editor.collab.saveConflict.discard`)"
          color="grey"
          padding="xs md"
          @click="onDialogOK('discard')" />
        <w-btn
          unelevated
          :label="t(`editor.collab.saveConflict.saveAnyway`)"
          color="primary"
          padding="xs md"
          @click="onDialogOK('overwrite')" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import * as monaco from 'monaco-editor'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'

// PROPS

const props = defineProps({
  /** Whoever saved the newer version the server now has, for the dialog message. */
  authorName: {
    type: String,
    required: false,
    default: ''
  },
  /** The content the server actually has stored -- what this author's save was refused against. */
  serverContent: {
    type: String,
    required: false,
    default: ''
  },
  /** This author's own unsaved edit, as it stood at the moment the conflict was detected. */
  pendingContent: {
    type: String,
    required: false,
    default: ''
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK } = useDialogComponent()

// I18N

const { t } = useI18n()

// DIFF EDITOR

/*
  Same shape as `PageHistoryOverlay.vue`'s own lazy diff-editor mount: `<w-dialog>` only renders its
  teleported slot content -- including this template's `diffEl` container -- once `dialogVisible`
  flips true on the tick after mount (see `useDialogComponent()`), so mounting Monaco has to wait for
  that flip rather than running in this component's own `onMounted`.
*/
const diffEl = ref(null)
let diffEditor = null
let originalModel = null
let modifiedModel = null

function mountEditor() {
  if (diffEditor || !diffEl.value) {
    return
  }

  // -> The markdown editor's theme, defined again here because that component may never have mounted
  monaco.editor.defineTheme('wikijs', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#070a0d',
      'editor.lineHighlightBackground': '#0d1117',
      'editorLineNumber.foreground': '#546e7a',
      'editorGutter.background': '#0d1117'
    }
  })

  diffEditor = monaco.editor.createDiffEditor(diffEl.value, {
    automaticLayout: true,
    fontSize: 13,
    renderSideBySide: true,
    originalEditable: false,
    // -> A reader, not an editor: choosing which side wins is what the two buttons below are for.
    readOnly: true,
    scrollBeyondLastLine: false,
    theme: 'wikijs',
    wordWrap: 'on'
  })

  // -> Always markdown: this dialog is only ever opened from `PageHeader.vue`'s save-conflict
  //    handling, unlike `PageHistoryOverlay.vue`'s multi-format history, so no `languageOf()` needed.
  originalModel = monaco.editor.createModel(props.serverContent, 'markdown')
  modifiedModel = monaco.editor.createModel(props.pendingContent, 'markdown')
  diffEditor.setModel({ original: originalModel, modified: modifiedModel })
}

function disposeEditor() {
  diffEditor?.setModel(null)
  originalModel?.dispose()
  modifiedModel?.dispose()
  originalModel = null
  modifiedModel = null
  diffEditor?.dispose()
  diffEditor = null
}

watch(dialogVisible, async (visible) => {
  if (visible) {
    await nextTick()
    mountEditor()
  }
})

onBeforeUnmount(disposeEditor)
</script>

<style lang="scss">
.save-conflict-diff-labels {
  display: flex;
  justify-content: space-around;
  font-size: 0.75rem;
  opacity: 0.7;
  margin-bottom: 4px;
}

.save-conflict-diff {
  height: 320px;
  border: 1px solid rgba(#fff, 0.08);
  border-radius: 4px;
  overflow: hidden;
}
</style>
