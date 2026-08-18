<template>
  <w-dialog v-model="dialogVisible" @hide="onDialogHide">
    <w-card class="import-page-dialog" style="width: 700px; max-width: 94vw">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-document-in-folder.svg" size="sm" class="mr-2" />
        <span>{{ t(`pages.import.title`) }}</span>
      </w-card-section>

      <template v-if="state.step === `select`">
        <w-card-section>
          <p class="text-body2 text-grey mb-3">{{ t(`pages.import.description`) }}</p>
          <div class="flex flex-wrap items-center gap-3 mb-3">
            <w-btn
              outline
              color="primary"
              no-caps
              icon="la:folder-open"
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
            outlined
            dense
            :options="formatOptions"
            map-options
            emit-value
            option-value="value"
            option-label="label"
            options-dense
            hide-bottom-space
            :label="t(`pages.import.format`)" />
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
            unelevated
            color="primary"
            padding="xs md"
            :label="t(`pages.import.convert`)"
            :loading="state.converting"
            :disable="!canConvert"
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
            icon="la:arrow-left"
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
            unelevated
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
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'

import { useSiteStore } from '@/stores/site'

/**
 * Pick a file in one of Pandoc's supported formats, convert it to Markdown through
 * `POST sites/:siteId/pages/import`, and hand the result back to whoever opened this dialog — it
 * only converts and previews, it never saves anything itself. `PageNewMenu.vue` is the only opener
 * today: it takes the `ok` payload straight into `pageStore.pageCreate()`, exactly like every other
 * "New … Page" entry there.
 */

/**
 * Source formats this dialog offers, matching `SUPPORTED_IMPORT_FORMATS` in
 * `backend/models/import.ts`. Not imported from there: `backend/` and `frontend/` are separate,
 * independently-installed workspaces with no shared module between them (see CLAUDE.md's `Layout`
 * section), so the two lists are kept in step by hand.
 */
const FORMATS = [
  { value: 'mediawiki', label: 'MediaWiki' },
  { value: 'textile', label: 'Textile' },
  { value: 'docbook', label: 'DocBook' },
  { value: 'rst', label: 'reStructuredText' },
  { value: 'docx', label: 'Word Document (.docx)' },
  { value: 'odt', label: 'OpenDocument Text (.odt)' }
]

/** File extension -> format, for auto-detecting `state.format` off the chosen file's name. */
const EXTENSION_FORMATS = {
  wiki: 'mediawiki',
  mediawiki: 'mediawiki',
  textile: 'textile',
  dbk: 'docbook',
  docbook: 'docbook',
  rst: 'rst',
  docx: 'docx',
  odt: 'odt'
}

// PROPS

const props = defineProps({
  /** Passed straight through to `pageStore.pageCreate()` on confirm, same as `PageNewMenu`'s own. */
  basePath: {
    type: String,
    default: null
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent()

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  step: 'select',
  file: null,
  fileName: '',
  format: null,
  converting: false,
  markdown: '',
  title: ''
})

const fileIpt = ref(null)

// COMPUTED

const formatOptions = computed(() => FORMATS)

const acceptExtensions = computed(() => `.${Object.keys(EXTENSION_FORMATS).join(',.')}`)

const canConvert = computed(() => Boolean(state.file) && Boolean(state.format))

// METHODS

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
  // -> Title defaults to the file name minus its extension, a starting point the new-page flow's
  //    own properties step lets the author change like any other
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
    const markdown = await API_CLIENT.post(`sites/${siteStore.id}/pages/import`, {
      searchParams: {
        format: state.format,
        path: props.basePath || ''
      },
      headers: {
        'content-type': state.file.type || 'application/octet-stream'
      },
      body: state.file
    })
      .json()
      .then((resp) => resp?.markdown ?? '')

    state.markdown = markdown
    state.step = 'preview'
  } catch (err) {
    // -> The server's own message carries which of unsupported format / missing Pandoc / a failed
    //    conversion this was, same pattern `AdminExtensions.vue`'s `install()` uses for its errors
    notify({
      type: 'negative',
      message: t('pages.import.convertFailed'),
      caption: apiErrorMessage(err)
    })
  }
  state.converting = false
}

function confirm() {
  onDialogOK({
    content: state.markdown,
    title: state.title
  })
}
</script>

<style lang="scss">
.import-page-dialog {
  &-preview {
    padding: 0;
    background-color: $dark-6;
    color: #fff;

    pre {
      max-height: 60vh;
      overflow: auto;
      padding: 1rem;
      font-family: 'Roboto Mono', monospace;
      font-size: 0.8rem;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
  }

  &-actions {
    background-color: $dark-3;
    background-image: radial-gradient(at top left, $dark-3, $dark-5);
    border-top: 1px solid #000;
    box-shadow: 0 -1px 0 0 rgba(#fff, 0.06);
    color: #fff;
  }
}
</style>
