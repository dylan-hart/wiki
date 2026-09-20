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
        <w-icon name="tabler:git-branch" size="sm" class="me-2" />
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

import { useAesthetic } from '@/composables/aesthetic'
import { defineMonacoThemes, monacoThemeName } from '@/helpers/monacoTheme'
import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'

const props = defineProps({
  authorName: {
    type: String,
    required: false,
    default: ''
  },
  serverContent: {
    type: String,
    required: false,
    default: ''
  },
  pendingContent: {
    type: String,
    required: false,
    default: ''
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK } = useDialogComponent()

const { t } = useI18n()

/*
  Monaco cannot read the design-token layer (`defineTheme()` takes plain hex, not `var()`), so the
  aesthetic is applied by registering both themes and switching between them.
*/
const aesthetic = useAesthetic()

/*
  `<w-dialog>` only renders its teleported slot content -- `diffEl` included -- once `dialogVisible`
  flips true on the tick after mount, so mounting Monaco waits for that rather than for `onMounted`.
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
  defineMonacoThemes(monaco, {
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
    theme: monacoThemeName(aesthetic.current),
    wordWrap: 'on'
  })

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

<style>
.save-conflict-diff-labels {
  display: flex;
  justify-content: space-around;
  font-size: 0.75rem;
  opacity: 0.7;
  margin-bottom: 4px;
}

/*
  FIXME: `rgba(#fff, 0.08)` is Sass syntax, invalid in plain CSS, so the border below never renders.
  Write the color as `rgb(255 255 255 / 8%)`. `PageDraftRestoreDialog.vue` carries the same bug.
*/
.save-conflict-diff {
  height: 320px;
  border: 1px solid rgb(255 255 255 / 8%);
  overflow: hidden;
}
</style>
