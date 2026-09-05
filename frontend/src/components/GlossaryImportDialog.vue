<template>
  <w-dialog
    v-model="dialogVisible"
    :aria-label="t('admin.glossary.importTitle')"
    @hide="onDialogHide">
    <w-card class="glossary-import-dialog" style="width: 760px; max-width: 94vw">
      <w-card-section class="card-header">
        <w-icon name="tabler:file-import" size="sm" class="me-2" />
        <span>{{ t('admin.glossary.importTitle') }}</span>
      </w-card-section>
      <w-separator />

      <w-card-section>
        <p class="text-body2 text-grey mb-3">{{ t('admin.glossary.importDescription') }}</p>

        <div
          class="glossary-import-dropzone rounded"
          :class="{ 'glossary-import-dropzone--over': state.isDraggingOver }"
          @dragenter.prevent="state.isDraggingOver = true"
          @dragover.prevent
          @dragleave.prevent="state.isDraggingOver = false"
          @drop.prevent="onDrop">
          <div class="glossary-import-editor"><div ref="monacoRef" /></div>
        </div>

        <div class="flex items-center justify-between mt-2">
          <span class="text-caption text-grey">{{ t('admin.glossary.importDropzoneLabel') }}</span>
          <w-btn
            outline
            dense
            color="primary"
            icon="tabler:folder-open"
            :label="t('common.actions.browse')"
            @click="pickFile" />
          <input
            ref="fileIpt"
            type="file"
            accept=".json,application/json"
            style="display: none"
            @change="onFileSelected" />
        </div>
      </w-card-section>

      <w-card-actions class="card-actions">
        <w-space />
        <w-btn
          class="acrylic-btn"
          flat
          :label="t(`common.actions.cancel`)"
          color="grey"
          padding="xs md"
          @click="onDialogCancel" />
        <w-btn
          class="acrylic-btn"
          color="primary"
          padding="xs md"
          :label="t('common.actions.import')"
          :loading="state.importing"
          @click="submit" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import * as monaco from 'monaco-editor'
import { isTimeoutError } from 'ky'

import { confirm, dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

/**
 * Glossary JSON import (OpenProject #1114, review feedback #1207): replaces the old bare OS file
 * picker (`browser-fs-access`'s `fileOpen()`) with a dialog the admin can actually see and edit
 * before committing to it -- a Monaco JSON editor that is directly editable/pasteable AND accepts a
 * dropped or browsed-for `.json` file, matching `ImportBatchPageDialog.vue`'s dropzone convention and
 * `EditorCode.vue`'s Monaco boot pattern (the `wikijs` theme, `monaco.editor.create`).
 *
 * The whole-glossary replace semantics are unchanged from the old flow: submitting still POSTs
 * straight to `sites/:siteId/glossary/import`, which replaces the ENTIRE live glossary immediately
 * (no staging through "Save Glossary") -- the confirm() below exists for exactly that reason.
 */

/**
 * How long the client gives the import request, in milliseconds -- past `ky`'s own 10s default.
 *
 * There's no file conversion here (this dialog only ever sends already-parsed JSON), but
 * `models/glossary.ts`'s `importTerms` resolves every term's `path` to a page with its own database
 * lookup, one at a time rather than batched -- a large glossary (hundreds or thousands of terms,
 * plausible for a real wiki's export) can add up past ky's default well before the request itself has
 * failed.
 */
const GLOSSARY_IMPORT_TIMEOUT = 60 * 1000

// PROPS

const props = defineProps({
  siteId: {
    type: String,
    required: true
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// I18N

const { t } = useI18n()

// STATE

const state = reactive({
  isDraggingOver: false,
  importing: false
})

let editor
const monacoRef = ref(null)
const fileIpt = ref(null)

// METHODS

function pickFile() {
  fileIpt.value?.click()
}

async function loadFile(file) {
  if (!file) {
    return
  }
  if (!/\.json$/i.test(file.name) && file.type !== 'application/json') {
    notify({
      type: 'negative',
      message: t('admin.glossary.importInvalidFormat')
    })
    return
  }
  const text = await file.text()
  editor?.setValue(text)
}

function onFileSelected(ev) {
  const file = ev.target.files?.[0]
  if (file) {
    loadFile(file)
  }
  ev.target.value = null
}

function onDrop(ev) {
  state.isDraggingOver = false
  const file = ev.dataTransfer?.files?.[0]
  if (file) {
    loadFile(file)
  }
}

function submit() {
  let data
  try {
    data = JSON.parse(editor?.getValue() ?? '')
  } catch (err) {
    return notify({
      type: 'negative',
      message: t('admin.glossary.importInvalidJson'),
      caption: err.message
    })
  }
  if (!data || !Array.isArray(data.terms)) {
    return notify({
      type: 'negative',
      message: t('admin.glossary.importInvalidFormat')
    })
  }

  confirm({
    title: t('admin.glossary.importConfirmTitle'),
    message: t('admin.glossary.importConfirmMessage', { count: data.terms.length }),
    cancel: true,
    color: 'negative',
    okLabel: t('common.actions.import')
  }).onOk(async () => {
    state.importing = true
    try {
      await API_CLIENT.post(`sites/${props.siteId}/glossary/import`, {
        timeout: GLOSSARY_IMPORT_TIMEOUT,
        json: data
      }).json()
      notify({
        type: 'positive',
        message: t('admin.glossary.importSuccess')
      })
      onDialogOK()
    } catch (err) {
      // -> A client-side `TimeoutError` while the server is still genuinely working through a large
      //    term list must not read like a real failure -- the whole-glossary replace has already
      //    started (or finished) server-side, and retrying blind risks nothing new but is confusing.
      //    Same distinction `AdminExtensions.vue`'s `install()` draws for `INSTALL_TIMEOUT`.
      if (isTimeoutError(err)) {
        notify({
          type: 'negative',
          message: t('admin.glossary.importTimedOut'),
          caption: t('admin.glossary.importTimedOutHint'),
          timeout: 0
        })
      } else {
        notify({
          type: 'negative',
          message: t('admin.glossary.importFailed'),
          caption: apiErrorMessage(err)
        })
      }
    }
    state.importing = false
  })
}

// MOUNTED

onMounted(() => {
  // -> Same theme `EditorCode.vue` defines, redefined here rather than shared: only one editor
  //    instance is ever mounted at a time, so there is nothing to deduplicate against.
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

  editor = monaco.editor.create(monacoRef.value, {
    automaticLayout: true,
    fontSize: 14,
    language: 'json',
    lineNumbersMinChars: 3,
    padding: { top: 10, bottom: 10 },
    scrollBeyondLastLine: false,
    tabSize: 2,
    theme: 'wikijs',
    value: '',
    wordWrap: 'on'
  })
})

onBeforeUnmount(() => {
  if (editor) {
    editor.dispose()
  }
})
</script>

<style lang="scss">
.glossary-import-dropzone {
  border: 2px dashed rgba(0, 0, 0, 0.2);
  transition: border-color 0.15s ease;
  overflow: hidden;

  &--over {
    border-color: $primary;
  }
}

.glossary-import-editor {
  height: 320px;

  > div {
    height: 100%;
  }
}
</style>
