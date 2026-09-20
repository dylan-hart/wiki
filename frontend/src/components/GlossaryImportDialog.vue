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
import { useAesthetic } from '@/composables/aesthetic'
import { defineMonacoThemes, monacoThemeName } from '@/helpers/monacoTheme'
import { isTimeoutError } from 'ky'

import { confirm, dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

/**
 * Submitting replaces the ENTIRE live glossary immediately, with no staging through "Save
 * Glossary" -- which is what the confirm() below exists for.
 */

/**
 * Past `ky`'s own 10s default: the server resolves every term's `path` to a page with its own
 * database lookup, one at a time, so a glossary of thousands of terms outruns that default long
 * before the request has actually failed.
 */
const GLOSSARY_IMPORT_TIMEOUT = 60 * 1000

const props = defineProps({
  siteId: {
    type: String,
    required: true
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const { t } = useI18n()

/*
  Monaco cannot read the design-token layer (`defineTheme()` takes plain hex, not `var()`), so the
  aesthetic is applied by registering both themes and switching between them.
*/
const aesthetic = useAesthetic()

const state = reactive({
  isDraggingOver: false,
  importing: false
})

let editor
const monacoRef = ref(null)
const fileIpt = ref(null)

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
      caption: apiErrorMessage(err)
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
      // -> A client-side timeout is not a failed import: the whole-glossary replace has already
      //    started server-side, so this must not read like something to blindly retry.
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

onMounted(() => {
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

  editor = monaco.editor.create(monacoRef.value, {
    automaticLayout: true,
    fontSize: 14,
    language: 'json',
    lineNumbersMinChars: 3,
    padding: { top: 10, bottom: 10 },
    scrollBeyondLastLine: false,
    tabSize: 2,
    theme: monacoThemeName(aesthetic.current),
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

<style>
.glossary-import-dropzone {
  border: 2px dashed rgba(0, 0, 0, 0.2);
  transition: border-color 0.15s ease;
  overflow: hidden;
}

.glossary-import-dropzone--over {
  border-color: var(--color-primary);
}

.glossary-import-editor {
  height: 320px;

  > div {
    height: 100%;
  }
}
</style>
