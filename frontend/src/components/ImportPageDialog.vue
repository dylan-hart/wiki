<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`pages.import.title`)" @hide="onDialogHide">
    <w-card class="import-page-dialog" style="width: 700px; max-width: 94vw">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-document-in-folder.svg" size="sm" class="me-2" />
        <span>{{ t(`pages.import.title`) }}</span>
      </w-card-section>

      <template v-if="state.step === `select`">
        <w-card-section>
          <p class="text-body2 text-grey mb-3">{{ t(`pages.import.description`) }}</p>
          <div class="flex flex-wrap items-center gap-3 mb-3">
            <w-btn
              outline
              color="primary"
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
 * Pick a file — Wiki.js's own Markdown, or one of Pandoc's supported formats — convert it to Markdown
 * through `POST sites/:siteId/pages/import`, and hand the result back to whoever opened this dialog —
 * it only converts and previews, it never saves anything itself. `PageNewMenu.vue` is the only opener
 * today: it takes the `ok` payload straight into `pageStore.pageCreate()`, exactly like every other
 * "New … Page" entry there.
 *
 * `format: 'markdown'` (OpenProject #1092) needs no Pandoc extension at all — it is a pass-through
 * read of the file's own bytes, so this dialog (unlike the other formats it offers) works on an
 * instance with no Pandoc installed. A leading YAML front-matter block, if the file has one, is parsed
 * server-side into `title`/`description`/`tags`, which is why `convert()` below reads those back off
 * the response rather than only ever defaulting the title from the file name.
 */

/**
 * Source formats this dialog offers, matching `SUPPORTED_IMPORT_FORMATS` in
 * `backend/models/import.ts`. Not imported from there: `backend/` and `frontend/` are separate,
 * independently-installed workspaces with no shared module between them (see CLAUDE.md's `Layout`
 * section), so the two lists are kept in step by hand. `markdown` is listed first as the native
 * format needing no Pandoc extension — every other entry still does.
 */
const FORMATS = [
  { value: 'markdown', label: 'Markdown (.md)', needsPandoc: false },
  { value: 'mediawiki', label: 'MediaWiki', needsPandoc: true },
  { value: 'textile', label: 'Textile', needsPandoc: true },
  { value: 'docbook', label: 'DocBook', needsPandoc: true },
  { value: 'rst', label: 'reStructuredText', needsPandoc: true },
  { value: 'docx', label: 'Word Document (.docx)', needsPandoc: true },
  { value: 'odt', label: 'OpenDocument Text (.odt)', needsPandoc: true }
]

/** File extension -> format, for auto-detecting `state.format` off the chosen file's name. */
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
  odt: 'odt'
}

/**
 * How long the client gives a single-file conversion, in milliseconds -- past `ky`'s own 10s default,
 * which is well under what a Pandoc-backed conversion can take.
 *
 * Sized against the server's own ceiling on the same work: `backend/models/import.ts`'s
 * `IMPORT_TIMEOUT` kills a stalled pandoc process after 30s, and `MAX_IMPORT_SIZE` caps the upload at
 * 25MB. This adds 30s of margin on top of that 30s pandoc ceiling for the upload itself to complete on
 * a slow connection, rather than trying to compute a byte-accurate figure for a single file the way
 * `ImportBatchPageDialog.vue`'s batch request has to.
 */
const IMPORT_TIMEOUT = 60 * 1000

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
  title: '',
  description: '',
  tags: []
})

const fileIpt = ref(null)

// -> Whether Pandoc is installed decides which formats are pickable at all (OpenProject #1209);
//    fetched once per dialog open rather than assumed stale from an earlier visit to this page.
onMounted(() => {
  siteStore.fetchExtensionsStatus()
})

// COMPUTED

/** True once we know for sure this instance has no Pandoc extension -- before the check resolves, nothing is disabled yet rather than flashing every format grayed out. */
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
    // -> A `markdown` import's front matter (OpenProject #1092) names the actual title/description/
    //    tags the file was authored with -- preferred here over the file-name default set on pick.
    if (resp?.title) {
      state.title = resp.title
    }
    state.description = resp?.description ?? ''
    state.tags = resp?.tags ?? []
    state.step = 'preview'
  } catch (err) {
    // -> A client-side `TimeoutError` firing while pandoc is still genuinely working server-side must
    //    not read like a real failure: it looks identical to one otherwise, and retrying converts the
    //    same file a second time for nothing. Same distinction `AdminExtensions.vue`'s `install()`
    //    draws for `INSTALL_TIMEOUT`. Anything else -- unsupported format, missing Pandoc, a genuine
    //    conversion failure -- falls through to the generic caption, where the server's own message
    //    (via `apiErrorMessage`) says which of those it was.
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
