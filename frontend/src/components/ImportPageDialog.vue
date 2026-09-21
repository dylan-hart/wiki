<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`pages.import.title`)" @hide="onDialogHide">
    <w-card class="import-page-dialog" style="width: 700px; max-width: 94vw">
      <w-card-section class="card-header">
        <w-icon name="tabler:folder" size="sm" class="me-2" />
        <span>{{ t(`pages.import.title`) }}</span>
      </w-card-section>

      <template v-if="state.step === `select`">
        <w-card-section>
          <p class="text-body2 text-grey mb-3">{{ t(`pages.import.description`) }}</p>
          <div class="flex flex-wrap items-center gap-3 mb-3">
            <w-btn
              outline
              color="primary"
              icon="tabler:folder-open"
              :label="state.fileName || t(`common.actions.browse`)"
              @click="pickFile" />
            <input
              ref="fileIpt"
              type="file"
              style="display: none"
              :accept="acceptExtensions"
              @change="onFileSelected" />
          </div>
          <w-select
            v-model="state.format"
            dense
            :options="formatOptions"
            map-options
            emit-value
            option-value="value"
            option-label="label"
            option-disable="disable"
            options-dense
            hide-bottom-space
            :label="t(`pages.import.format`)" />
          <p v-if="pandocMissing" class="text-caption text-grey mt-2">
            {{ t(`pages.import.pandocMissing`) }}
            <router-link to="/_admin/extensions">{{
              t(`pages.import.pandocMissingLink`)
            }}</router-link>
          </p>
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
            class="import-convert-btn"
            color="primary"
            padding="xs md"
            :label="t(`pages.import.convert`)"
            :loading="state.converting"
            :disabled="!canConvert"
            @click="convert" />
        </w-card-actions>
      </template>

      <template v-else>
        <w-card-section class="import-page-dialog-preview">
          <pre v-text="state.markdown" />
        </w-card-section>
        <w-card-actions class="import-page-dialog-actions">
          <w-btn
            class="acrylic-btn"
            flat
            icon="tabler:arrow-left"
            color="grey-5"
            padding="xs md"
            :label="t(`pages.import.back`)"
            @click="state.step = `select`" />
          <w-space />
          <w-btn
            class="acrylic-btn"
            flat
            :label="t(`common.actions.cancel`)"
            color="grey-5"
            padding="xs md"
            @click="onDialogCancel" />
          <w-btn
            class="import-confirm-btn"
            color="primary"
            padding="xs md"
            :label="t(`pages.import.useContent`)"
            @click="confirm" />
        </w-card-actions>
      </template>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { isTimeoutError } from 'ky'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

import { useSiteStore } from '@/stores/site'

/**
 * Converts and previews only — the result is handed back to whoever opened the dialog, which saves
 * it. `markdown` is a pass-through read of the file's bytes, so that one format works on an
 * instance with no Pandoc installed; a YAML front-matter block is parsed server-side into
 * `title`/`description`/`tags`, which `convert()` reads back off the response.
 */

/**
 * Mirrors `SUPPORTED_IMPORT_FORMATS` in `backend/models/import.ts`, by hand: the two workspaces are
 * installed independently and share no module.
 */
const FORMATS = [
  { value: 'markdown', label: 'Markdown (.md)', needsPandoc: false },
  { value: 'mediawiki', label: 'MediaWiki', needsPandoc: true },
  { value: 'textile', label: 'Textile', needsPandoc: true },
  { value: 'docbook', label: 'DocBook', needsPandoc: true },
  { value: 'rst', label: 'reStructuredText', needsPandoc: true },
  { value: 'docx', label: 'Word Document (.docx)', needsPandoc: true },
  { value: 'odt', label: 'OpenDocument Text (.odt)', needsPandoc: true },
  { value: 'html', label: 'HTML (.htm, .html)', needsPandoc: true }
]

const EXTENSION_FORMATS = {
  md: 'markdown',
  markdown: 'markdown',
  wiki: 'mediawiki',
  mediawiki: 'mediawiki',
  textile: 'textile',
  dbk: 'docbook',
  docbook: 'docbook',
  rst: 'rst',
  docx: 'docx',
  odt: 'odt',
  htm: 'html',
  html: 'html'
}

/**
 * `ky`'s 10s default is well under what a Pandoc-backed conversion takes: this covers the server's
 * own 30s ceiling on a stalled pandoc process plus margin for the upload on a slow connection.
 */
const IMPORT_TIMEOUT = 60 * 1000

const props = defineProps({
  basePath: {
    type: String,
    default: null
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  step: 'select',
  file: null,
  fileName: '',
  format: null,
  converting: false,
  markdown: '',
  title: '',
  description: '',
  tags: []
})

const fileIpt = ref(null)

onMounted(() => {
  siteStore.fetchExtensionsStatus()
})

/** Gated on the check having resolved, so formats do not flash grayed out before it answers. */
const pandocMissing = computed(
  () => siteStore.extensionsStatusLoaded && !siteStore.extensionsStatus.pandoc
)

const formatOptions = computed(() =>
  FORMATS.map((f) => ({
    ...f,
    disable: f.needsPandoc && pandocMissing.value,
    label: f.needsPandoc && pandocMissing.value ? `${f.label} (needs Pandoc)` : f.label
  }))
)

const acceptExtensions = computed(() => `.${Object.keys(EXTENSION_FORMATS).join(',.')}`)

const selectedFormatNeedsPandoc = computed(
  () => FORMATS.find((f) => f.value === state.format)?.needsPandoc ?? false
)

const canConvert = computed(
  () =>
    Boolean(state.file) &&
    Boolean(state.format) &&
    !(selectedFormatNeedsPandoc.value && pandocMissing.value)
)

function pickFile() {
  fileIpt.value?.click()
}

function onFileSelected(ev) {
  const file = ev.target.files?.[0]
  if (!file) {
    return
  }
  state.file = file
  state.fileName = file.name
  state.title = file.name.replace(/\.[^.]+$/, '')

  const ext = file.name.split('.').pop()?.toLowerCase()
  const detected = ext ? EXTENSION_FORMATS[ext] : null
  if (detected) {
    state.format = detected
  }
}

async function convert() {
  if (!canConvert.value) {
    return
  }
  state.converting = true
  try {
    const resp = await API_CLIENT.post(`sites/${siteStore.id}/pages/import`, {
      timeout: IMPORT_TIMEOUT,
      searchParams: {
        fileName: state.fileName,
        format: state.format,
        path: props.basePath || ''
      },
      headers: {
        'content-type': state.file.type || 'application/octet-stream'
      },
      body: state.file
    }).json()

    state.markdown = resp?.markdown ?? ''
    // -> Front matter the server parsed out beats the file-name default set on pick.
    if (resp?.title) {
      state.title = resp.title
    }
    state.description = resp?.description ?? ''
    state.tags = resp?.tags ?? []
    state.step = 'preview'
  } catch (err) {
    // -> A client-side timeout while pandoc is still working server-side must not read as a real
    //    failure: retrying converts the same file a second time for nothing.
    if (isTimeoutError(err)) {
      notify({
        type: 'negative',
        message: t('pages.import.convertTimedOut'),
        caption: t('pages.import.convertTimedOutHint'),
        timeout: 0
      })
    } else {
      notify({
        type: 'negative',
        message: t('pages.import.convertFailed'),
        caption: apiErrorMessage(err)
      })
    }
  }
  state.converting = false
}

function confirm() {
  onDialogOK({
    content: state.markdown,
    title: state.title,
    description: state.description,
    tags: state.tags
  })
}
</script>

<style>
.import-page-dialog-preview {
  padding: 0;
  background-color: var(--color-dark-6);
  color: #fff;
}
.import-page-dialog-preview pre {
  max-height: 60vh;
  overflow: auto;
  padding: 1rem;
  font-family: 'Roboto Mono', monospace;
  font-size: 0.8rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.import-page-dialog-actions {
  background-color: var(--color-dark-3);
  background-image: radial-gradient(at top left, var(--color-dark-3), var(--color-dark-5));
  border-top: 1px solid #000;
  box-shadow: 0 -1px 0 0 rgba(255, 255, 255, 0.06);
  color: #fff;
}
</style>
