<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`pages.importBatch.title`)" @hide="onDialogHide">
    <w-card class="import-batch-page-dialog" style="width: 760px; max-width: 94vw">
      <w-card-section class="card-header">
        <w-icon name="img:/_assets/icons/fluent-document-in-folder.svg" size="sm" class="me-2" />
        <span>{{ t(`pages.importBatch.title`) }}</span>
      </w-card-section>

      <template v-if="state.step === `select`">
        <w-card-section>
          <p class="text-body2 text-grey mb-3">{{ t(`pages.importBatch.description`) }}</p>
          <div
            class="import-batch-dropzone rounded p-6 text-center"
            :class="{ 'import-batch-dropzone--over': state.isDraggingOver }"
            @dragenter.prevent="state.isDraggingOver = true"
            @dragover.prevent
            @dragleave.prevent="state.isDraggingOver = false"
            @drop.prevent="onDrop">
            <w-icon name="la:cloud-upload-alt" size="40px" class="mb-2" />
            <div class="text-body2 mb-2">{{ t(`pages.importBatch.dropzoneLabel`) }}</div>
            <w-btn
              outline
              color="primary"
              no-caps
              icon="la:folder-open"
              :label="t(`common.actions.browse`)"
              @click="pickFiles" />
            <input
              ref="fileIpt"
              type="file"
              multiple
              style="display: none"
              :accept="acceptExtensions"
              @change="onFilesSelected" />
          </div>

          <w-list v-if="state.files.length" padding class="mt-3">
            <w-item v-for="(file, idx) in state.files" :key="`${file.name}-${idx}`">
              <w-icon name="la:file-alt" class="me-2" />
              <w-item-section>{{ file.name }}</w-item-section>
              <w-select
                v-model="state.formats[idx]"
                outlined
                dense
                style="width: 180px"
                class="me-2 shrink-0"
                :options="formatOptions"
                map-options
                emit-value
                option-value="value"
                option-label="label"
                option-disable="disable"
                options-dense
                hide-bottom-space
                :aria-label="t('pages.importBatch.formatForFile', { file: file.name })" />
              <w-btn
                flat
                dense
                round
                icon="mdi:close"
                :aria-label="t(`common.actions.remove`)"
                @click="removeFile(idx)" />
            </w-item>
          </w-list>

          <p v-if="pandocMissing" class="text-caption text-grey mt-2">
            {{ t('pages.import.pandocMissing') }}
            <router-link to="/_admin/extensions">{{
              t('pages.import.pandocMissingLink')
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
            unelevated
            color="primary"
            padding="xs md"
            :label="t(`pages.importBatch.convert`)"
            :loading="state.converting"
            :disabled="!canConvert"
            @click="convert" />
        </w-card-actions>
      </template>

      <template v-else>
        <w-card-section class="import-batch-page-dialog-review">
          <w-banner
            class="mb-3"
            :class="allSaved ? 'bg-positive/10' : 'bg-black/5 dark:bg-white/10'">
            {{ summaryLabel }}
          </w-banner>

          <w-select
            v-model="state.conflictBehavior"
            outlined
            dense
            class="mb-3"
            :options="conflictOptions"
            map-options
            emit-value
            option-value="value"
            option-label="label"
            options-dense
            hide-bottom-space
            :disabled="state.saving"
            :label="t(`pages.importBatch.conflictBehavior`)" />

          <div
            v-for="row in state.results"
            :key="row.id"
            class="import-batch-row rounded p-3 mb-2"
            :class="rowClasses(row)">
            <div class="flex items-center gap-2 mb-1">
              <w-spinner v-if="row.saveStatus === `saving`" size="18px" />
              <w-icon v-else :name="statusIcon(row)" :color="statusColor(row)" />
              <span class="text-body2 font-medium truncate">{{ row.fileName }}</span>
              <w-space />
              <w-chip v-if="row.saveStatus !== 'pending'" :label="statusLabel(row)" dense />
            </div>

            <template v-if="row.ok">
              <div class="flex flex-wrap gap-2">
                <w-input
                  v-model="row.title"
                  outlined
                  dense
                  class="flex-1"
                  hide-bottom-space
                  :disabled="row.saveStatus === `saving` || row.saveStatus === `saved`"
                  :label="t(`pages.importBatch.pageTitle`)" />
                <w-input
                  v-model="row.path"
                  outlined
                  dense
                  class="flex-1"
                  hide-bottom-space
                  :disabled="row.saveStatus === `saving` || row.saveStatus === `saved`"
                  :label="t(`pages.importBatch.destinationPath`)" />
              </div>
              <p v-if="row.saveMessage" class="text-caption text-negative mt-1">
                {{ row.saveMessage }}
              </p>
            </template>
            <p v-else class="text-caption text-negative">{{ row.convertMessage }}</p>
          </div>
        </w-card-section>
        <w-card-actions class="import-batch-page-dialog-actions">
          <w-btn
            class="acrylic-btn"
            flat
            icon="la:arrow-left"
            color="grey-5"
            padding="xs md"
            :disabled="state.saving"
            :label="t(`pages.import.back`)"
            @click="backToSelect" />
          <w-space />
          <w-btn
            class="acrylic-btn"
            flat
            :label="t(`common.actions.close`)"
            color="grey-5"
            padding="xs md"
            @click="onDialogCancel" />
          <w-btn
            class="import-batch-save-btn"
            unelevated
            color="primary"
            padding="xs md"
            :label="t(`pages.importBatch.saveAll`)"
            :loading="state.saving"
            :disabled="!canSaveAll"
            @click="saveAll" />
        </w-card-actions>
      </template>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { v4 as uuid } from 'uuid'
import slugify from 'slugify'
import { isTimeoutError } from 'ky'

import { dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { normalizePagePath, pagePathHash } from '@/helpers/pagePaths'
import { MarkdownRenderer } from '@/renderers/markdown'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useEditorStore } from '@/stores/editor'

/**
 * Pick several files — Wiki.js's own Markdown, or one of Pandoc's supported formats — convert them
 * all in one request through `POST sites/:siteId/pages/import/batch` (OpenProject #849), then save
 * each converted result as its own new page through the ordinary `POST sites/:siteId/pages` — the
 * same endpoint the ordinary "New Page" flow uses. Unlike `ImportPageDialog.vue`, this dialog saves
 * the pages itself rather than handing content back to a caller: opening N editors for N files is not
 * a usable flow, so review and save both happen here, with each file's own progress and outcome shown
 * independently.
 *
 * `format: 'markdown'` (OpenProject #1092) needs no Pandoc extension, and a dropped **folder** of
 * markdown files (an Obsidian vault, a Hugo/Jekyll content directory, a whole docs-as-markdown repo)
 * is the flow this exists for: `onDrop` below walks the browser's FileSystem Entry API to preserve
 * that folder's relative structure into each row's destination path automatically, rather than
 * flattening every file straight into `basePath`. Front matter parsed server-side into
 * title/description/tags flows through to each row exactly like it does in `ImportPageDialog.vue`.
 */

/** Kept in step by hand with `ImportPageDialog.vue`'s own copy — see that file's header comment. */
const FORMATS = [
  { value: 'markdown', label: 'Markdown (.md)', needsPandoc: false },
  { value: 'mediawiki', label: 'MediaWiki', needsPandoc: true },
  { value: 'textile', label: 'Textile', needsPandoc: true },
  { value: 'docbook', label: 'DocBook', needsPandoc: true },
  { value: 'rst', label: 'reStructuredText', needsPandoc: true },
  { value: 'docx', label: 'Word Document (.docx)', needsPandoc: true },
  { value: 'odt', label: 'OpenDocument Text (.odt)', needsPandoc: true }
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
  odt: 'odt'
}

/**
 * The most files `convert()` will send in one request — matches the backend's own
 * `MAX_IMPORT_BATCH_FILES` (`backend/models/import.ts`), kept in step by hand for the same reason
 * `FORMATS` above is.
 */
const MAX_BATCH_FILES = 20

/** How many `-1`, `-2`, ... suffixes the `new` conflict behavior will try before giving up on a row. */
const MAX_PATH_ATTEMPTS = 25

/**
 * How long the client gives the batch-conversion request, in milliseconds -- past `ky`'s own 10s
 * default, which no batch of any real size finishes inside (`backend/models/import.ts`'s
 * `MAX_IMPORT_BATCH_FILES = 20` at up to `MAX_IMPORT_SIZE = 25MB` each routinely takes far longer).
 *
 * Unlike `EXPORT_PDF_TIMEOUT` (`PageActionsCol.vue`) or `INSTALL_TIMEOUT` (`AdminExtensions.vue`),
 * which are both fixed ceilings for a request whose own duration barely varies, this request's size
 * varies batch to batch -- so `computeBatchImportTimeout` below computes it from the files actually
 * selected, out of three terms:
 *
 * - A base of `IMPORT_BATCH_TIMEOUT_BASE`: past the server's own single-conversion ceiling
 *   (`backend/models/import.ts`'s `IMPORT_TIMEOUT`, 30s -- one pandoc process killed if it stalls),
 *   with margin. The batch route converts every file in parallel (one `Promise.all`, `api/pages/import.ts`),
 *   so this is not "30s times file count" -- it is what one file alone would already need.
 * - `IMPORT_BATCH_TIMEOUT_PER_FILE` per file: even run in parallel, more files mean more pandoc
 *   processes contending for the same CPU, more disk I/O staging each upload, and a slower parallel
 *   conversion overall than a single file's -- this is the marginal cost of each additional one.
 * - The full upload transfer time at a deliberately pessimistic `IMPORT_BATCH_ASSUMED_BYTES_PER_MS`
 *   throughput (100 KB/s) -- the one thing a fixed ceiling genuinely cannot cover: a large batch (a
 *   20-file, 25MB-each worst case is 500MB) sent over a slow or congested connection.
 */
const IMPORT_BATCH_TIMEOUT_BASE = 40 * 1000
const IMPORT_BATCH_TIMEOUT_PER_FILE = 3 * 1000
const IMPORT_BATCH_ASSUMED_BYTES_PER_MS = 100

/**
 * The `timeout` to send with a batch-conversion request carrying exactly these files -- see
 * `IMPORT_BATCH_TIMEOUT_BASE`'s doc comment for what each term accounts for.
 */
function computeBatchImportTimeout(files) {
  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0)
  return (
    IMPORT_BATCH_TIMEOUT_BASE +
    files.length * IMPORT_BATCH_TIMEOUT_PER_FILE +
    Math.ceil(totalBytes / IMPORT_BATCH_ASSUMED_BYTES_PER_MS)
  )
}

// PROPS

const props = defineProps({
  /** Where converted pages are saved by default, and what `write:pages` is checked against. */
  basePath: {
    type: String,
    default: null
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogCancel } = useDialogComponent()

// STORES

const pageStore = usePageStore()
const siteStore = useSiteStore()
const editorStore = useEditorStore()

// I18N

const { t } = useI18n()

// DATA

const state = reactive({
  step: 'select',
  files: [],
  /** Parallel to `files` -- each entry is that file's detected/overridden format, or `null` when its extension is not recognized (OpenProject #1209: no more one format shared by the whole batch). */
  formats: [],
  isDraggingOver: false,
  converting: false,
  saving: false,
  conflictBehavior: 'reject',
  results: []
})

const fileIpt = ref(null)

// -> Whether Pandoc is installed decides which per-file formats are pickable at all (OpenProject
//    #1209); fetched once per dialog open rather than assumed stale from an earlier visit.
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

const conflictOptions = computed(() => [
  { value: 'overwrite', label: t('pages.importBatch.conflictOverwrite') },
  { value: 'reject', label: t('pages.importBatch.conflictReject') },
  { value: 'new', label: t('pages.importBatch.conflictNew') }
])

const acceptExtensions = computed(() => `.${Object.keys(EXTENSION_FORMATS).join(',.')}`)

/*
  A file whose extension went undetected (`state.formats[i]` is `null`) is still allowed into the
  batch: it fails only its own row once converted (OpenProject #1209), the same as a Pandoc-missing
  or genuinely corrupt file already does -- Convert All never blocks on any one file's format being
  unresolved, only on there being no files at all.
*/
const canConvert = computed(() => state.files.length > 0)

const canSaveAll = computed(
  () => !state.saving && state.results.some((r) => r.ok && r.saveStatus === 'pending')
)

const allSaved = computed(
  () => state.results.length > 0 && state.results.every((r) => !r.ok || r.saveStatus === 'saved')
)

const summaryLabel = computed(() => {
  const total = state.results.length
  const converted = state.results.filter((r) => r.ok).length
  const saved = state.results.filter((r) => r.saveStatus === 'saved').length
  if (!state.saving && saved === 0) {
    return t('pages.importBatch.summaryConverted', { converted, total })
  }
  return t('pages.importBatch.summarySaved', { saved, converted })
})

// METHODS

function pickFiles() {
  fileIpt.value?.click()
}

/** A file's own format, from its extension -- `null` when the extension is not one this endpoint recognizes (OpenProject #1209: per file, not one guess for the whole batch). */
function detectFormat(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase()
  return ext ? (EXTENSION_FORMATS[ext] ?? null) : null
}

function addFiles(fileList) {
  const room = MAX_BATCH_FILES - state.files.length
  if (room <= 0) {
    notify({
      type: 'warning',
      message: t('pages.importBatch.tooManyFiles', { max: MAX_BATCH_FILES })
    })
    return
  }
  const incoming = [...fileList].slice(0, room)
  state.files.push(...incoming)
  state.formats.push(...incoming.map((file) => detectFormat(file.name)))
  if (fileList.length > incoming.length) {
    notify({
      type: 'warning',
      message: t('pages.importBatch.tooManyFiles', { max: MAX_BATCH_FILES })
    })
  }
}

function onFilesSelected(ev) {
  if (ev.target.files?.length) {
    addFiles(ev.target.files)
  }
  ev.target.value = null
}

/**
 * Reads every `FileSystemEntry` a drop's `DataTransferItemList` names, in the shape the standard
 * (non-Chromium-only) `.webkitGetAsEntry()` exposes it — walking into directories rather than only
 * reading the top-level drop, which is what lets `onDrop` below preserve a dropped folder's relative
 * structure (OpenProject #1092).
 *
 * @returns Each file paired with its path relative to the drop root — `'notes.md'` for a bare file,
 *   `'docs/guide/intro.md'` for one found inside a dropped folder.
 */
async function filesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer?.items ?? [])]
  const topEntries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter(Boolean)

  // -> No FileSystem Entry API support at all (older Firefox): fall back to the flat file list, the
  //    same shape this dropzone always handled before folder support existed.
  if (topEntries.length === 0) {
    return [...(dataTransfer?.files ?? [])]
      .filter((file) => file.size > 0)
      .map((file) => ({ file, relativePath: file.name }))
  }

  const collected = []
  async function readAllEntries(reader) {
    const all = []
    // -> `readEntries()` returns entries in batches (a browser-imposed cap per call, not "all of
    //    them"), signalled by an empty array once the directory is exhausted -- has to be called
    //    repeatedly, not just once, to see every child of a large directory.
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
      if (batch.length === 0) {
        break
      }
      all.push(...batch)
    }
    return all
  }
  async function walk(entry, prefix) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
      if (file.size > 0) {
        collected.push({ file, relativePath })
      }
    } else if (entry.isDirectory) {
      const children = await readAllEntries(entry.createReader())
      for (const child of children) {
        await walk(child, relativePath)
      }
    }
  }
  for (const entry of topEntries) {
    await walk(entry, '')
  }
  return collected
}

async function onDrop(ev) {
  state.isDraggingOver = false
  const dropped = await filesFromDataTransfer(ev.dataTransfer)
  if (dropped.length) {
    /*
      `File` carries no built-in notion of "the folder it was dropped from" -- `webkitRelativePath` is
      the closest native equivalent, but it is a getter-only IDL attribute on `File.prototype` in every
      engine that implements it, and this file's `<script setup>` runs in strict-mode ES module scope,
      where assigning to a getter-only property throws rather than silently no-opping. A plain own
      property under a name of this dialog's own choosing sidesteps that entirely -- `defaultPath`
      below reads it back the same way regardless of how the folder structure reached this dialog.
    */
    for (const { file, relativePath } of dropped) {
      if (relativePath !== file.name) {
        file.relativePath = relativePath
      }
    }
    addFiles(dropped.map((d) => d.file))
  }
}

function removeFile(idx) {
  state.files.splice(idx, 1)
  state.formats.splice(idx, 1)
}

function backToSelect() {
  state.step = 'select'
  state.results = []
}

async function convert() {
  if (!canConvert.value) {
    return
  }
  state.converting = true
  try {
    const form = new FormData()
    // -> One `formats` field right after each `files` field (OpenProject #1209): the backend pairs
    //    a `formats` part with whichever upload it most recently saw, so this exact interleaving is
    //    load-bearing, not cosmetic. An empty string here (an undetected extension) lets the backend
    //    make its own attempt and answer with a clear per-file error rather than the client guessing.
    state.files.forEach((file, idx) => {
      form.append('files', file, file.name)
      form.append('formats', state.formats[idx] ?? '')
    })
    const resp = await API_CLIENT.post(`sites/${siteStore.id}/pages/import/batch`, {
      timeout: computeBatchImportTimeout(state.files),
      searchParams: {
        path: props.basePath || ''
      },
      body: form
    }).json()

    /*
      Zipped by index against `state.files`, not looked up by name: the batch endpoint returns one
      result per file "in the order they were sent" (its own schema description), and `state.files`
      was sent in that same order by the loop just above -- the only place `relativePath`
      (OpenProject #1092's folder-structure carrier, set by `onDrop`) is still reachable from.
    */
    state.results = (resp?.results ?? []).map((item, idx) => {
      const file = state.files[idx]
      return {
        id: uuid(),
        fileName: item.fileName,
        ok: Boolean(item.ok),
        markdown: item.markdown ?? '',
        convertMessage: item.message ?? '',
        // -> A markdown import's own front matter (OpenProject #1092) names the real title -- used
        //    over the file-name default whenever the server found one.
        title: item.ok ? item.title || defaultTitle(item.fileName) : '',
        path: item.ok ? defaultPath(file ?? { name: item.fileName }) : '',
        description: item.description ?? '',
        tags: item.tags ?? [],
        saveStatus: item.ok ? 'pending' : 'skipped',
        saveMessage: ''
      }
    })
    state.step = 'review'
  } catch (err) {
    // -> A client-side `TimeoutError` firing while the server is still genuinely converting the batch
    //    must not read like a real failure -- retrying resends every file and re-runs every pandoc
    //    conversion a second time for nothing. Same distinction `AdminExtensions.vue`'s `install()`
    //    draws for `INSTALL_TIMEOUT`. Anything else -- missing Pandoc, a bad file, a real server
    //    refusal -- falls through to the generic caption, where the server's own message says which.
    if (isTimeoutError(err)) {
      notify({
        type: 'negative',
        message: t('pages.importBatch.convertTimedOut'),
        caption: t('pages.importBatch.convertTimedOutHint'),
        timeout: 0
      })
    } else {
      notify({
        type: 'negative',
        message: t('pages.importBatch.convertFailed'),
        caption: apiErrorMessage(err)
      })
    }
  }
  state.converting = false
}

function defaultTitle(fileName) {
  return fileName.replace(/\.[^.]+$/, '')
}

/**
 * Builds a row's destination path from its source file, preserving a dropped folder's relative
 * structure into the wiki automatically (OpenProject #1092): `file.relativePath` — set by `onDrop`'s
 * directory walk, absent for a plain browse-button selection — carries any folder segments ahead of
 * the file name, each slugified independently the same way the file name itself always has been.
 */
function defaultPath(file) {
  const segments = (file.relativePath || file.name).split('/').filter(Boolean)
  const fileName = segments.pop()
  const fileSlug = slugify(defaultTitle(fileName), { lower: true, strict: true })
  const dirSlugs = segments.map((segment) => slugify(segment, { lower: true, strict: true }))
  return [props.basePath, ...dirSlugs, fileSlug].filter(Boolean).join('/')
}

/**
 * The HTML for one row's converted markdown, produced the same way `InboxReview.vue`'s
 * `renderReviewed` does for an approval that also never passes through a mounted editor: the
 * markdown pipeline lives in the frontend (`renderers/markdown.js`), so nothing server-side ever
 * turns `content` into `render` on its own. Skipping this and sending `content` alone would save a
 * page whose `render` is empty -- and a page view reads `render`, not `content`
 * (`pages/Index.vue`'s `v-html="pageStore.render"`) -- so every imported page would show blank to
 * a reader until somebody happened to open and re-save it in the editor.
 *
 * Site-specific config (line breaks, typographer, ...) comes bundled with the editor configs
 * rather than on its own, so it is fetched once per dialog open, not per row.
 *
 * @throws Whatever `MarkdownRenderer#render` throws on unparsable source -- caught by the caller,
 *   same as a failed save.
 */
async function renderMarkdown(markdown, pagePath) {
  if (!editorStore.configIsLoaded) {
    await editorStore.fetchConfigs()
  }
  const md = new MarkdownRenderer(editorStore.editors.markdown ?? {})
  return md.render(markdown, { pagePath })
}

async function createPage(payload) {
  const resp = await API_CLIENT.post(`sites/${siteStore.id}/pages`, { json: payload }).json()
  return resp.page
}

async function fetchExistingPage(path) {
  const hash = pagePathHash(normalizePagePath(path))
  return API_CLIENT.get(`sites/${siteStore.id}/pages/${hash}`).json()
}

async function overwriteExisting(row, render) {
  const existing = await fetchExistingPage(row.path)
  const resp = await API_CLIENT.patch(`sites/${siteStore.id}/pages/${existing.id}`, {
    json: {
      title: row.title,
      description: row.description,
      tags: row.tags,
      content: row.markdown,
      render,
      expectedUpdatedAt: existing.updatedAt
    }
  }).json()
  return resp.page
}

/**
 * Saves one row, resolving a duplicate-path (409) refusal per `state.conflictBehavior` — the same
 * three-way choice the site's own asset-upload conflict setting offers (`uploads.conflictBehavior`,
 * `AdminGeneral.vue`), applied here per file since page creation has no such site-wide setting of
 * its own to read.
 */
async function saveRow(row) {
  row.saveStatus = 'saving'
  row.saveMessage = ''

  let render
  try {
    render = await renderMarkdown(row.markdown, row.path)
  } catch (err) {
    row.saveStatus = 'failed'
    row.saveMessage = apiErrorMessage(err, 'Failed to render this page.')
    return
  }

  try {
    const page = await createPage({
      editor: 'markdown',
      path: row.path,
      title: row.title,
      description: row.description,
      tags: row.tags,
      content: row.markdown,
      render
    })
    row.path = page.path
    row.saveStatus = 'saved'
    return
  } catch (err) {
    if (err.response?.status !== 409) {
      row.saveStatus = 'failed'
      row.saveMessage = apiErrorMessage(err, 'Failed to save the page.')
      return
    }
    // -> Falls through to the chosen conflict resolution below
  }

  if (state.conflictBehavior === 'reject') {
    row.saveStatus = 'failed'
    row.saveMessage = t('pages.importBatch.conflictRejectMessage')
    return
  }

  if (state.conflictBehavior === 'overwrite') {
    try {
      const page = await overwriteExisting(row, render)
      row.path = page.path
      row.saveStatus = 'saved'
    } catch (err) {
      row.saveStatus = 'failed'
      row.saveMessage = apiErrorMessage(err, 'Failed to save the page.')
    }
    return
  }

  // -> 'new': try successive `-1`, `-2`, ... suffixes until one is free
  const basePath = row.path
  for (let n = 1; n <= MAX_PATH_ATTEMPTS; n++) {
    const attemptPath = `${basePath}-${n}`
    try {
      const page = await createPage({
        editor: 'markdown',
        path: attemptPath,
        title: row.title,
        description: row.description,
        tags: row.tags,
        content: row.markdown,
        render
      })
      row.path = page.path
      row.saveStatus = 'saved'
      return
    } catch (err) {
      if (err.response?.status !== 409) {
        row.saveStatus = 'failed'
        row.saveMessage = apiErrorMessage(err, 'Failed to save the page.')
        return
      }
    }
  }
  row.saveStatus = 'failed'
  row.saveMessage = t('pages.importBatch.conflictNewExhausted')
}

/** Sequential, not parallel: 'new' resolution retries against paths the previous row may just have taken, and a shared conflict-behavior setting is simplest to reason about one row at a time. */
async function saveAll() {
  state.saving = true
  for (const row of state.results) {
    if (row.ok && row.saveStatus === 'pending') {
      await saveRow(row)
    }
  }
  state.saving = false
  const saved = state.results.filter((r) => r.saveStatus === 'saved').length
  const failed = state.results.filter((r) => r.saveStatus === 'failed').length
  /*
    OpenProject #1012: each new page can change what an `auto`/`mixed` menu generates from the tree,
    the same as a single `pageSave()` create -- but this is a whole batch of them, so invalidate once
    here rather than once per `saveRow()`, which would re-trigger the tree walk per row instead of
    per import.
  */
  if (saved > 0) {
    await siteStore.fetchNavigation(pageStore.navigationId, true)
  }
  if (failed === 0) {
    notify({ type: 'positive', message: t('pages.importBatch.saveAllSuccess', { saved }) })
  } else {
    notify({
      type: 'warning',
      message: t('pages.importBatch.saveAllPartial', { saved, failed })
    })
  }
}

function statusIcon(row) {
  if (!row.ok || row.saveStatus === 'failed') return 'mdi:alert-circle'
  if (row.saveStatus === 'saved') return 'mdi:check-circle'
  return 'la:file-alt'
}

function statusColor(row) {
  if (!row.ok || row.saveStatus === 'failed') return 'negative'
  if (row.saveStatus === 'saved') return 'positive'
  return null
}

function statusLabel(row) {
  if (row.saveStatus === 'saving') return t('pages.importBatch.statusSaving')
  if (row.saveStatus === 'saved') return t('pages.importBatch.statusSaved')
  if (row.saveStatus === 'failed') return t('pages.importBatch.statusFailed')
  return ''
}

function rowClasses(row) {
  return {
    'import-batch-row--failed': !row.ok || row.saveStatus === 'failed',
    'import-batch-row--saved': row.saveStatus === 'saved'
  }
}
</script>

<style lang="scss">
.import-batch-page-dialog {
  &-review {
    max-height: 60vh;
    overflow: auto;
  }

  &-actions {
    background-color: $dark-3;
    background-image: radial-gradient(at top left, $dark-3, $dark-5);
    border-top: 1px solid #000;
    box-shadow: 0 -1px 0 0 rgba(#fff, 0.06);
    color: #fff;
  }
}

.import-batch-dropzone {
  border: 2px dashed rgba(0, 0, 0, 0.2);
  transition: border-color 0.15s ease;

  &--over {
    border-color: $primary;
  }
}

.import-batch-row {
  border: 1px solid rgba(0, 0, 0, 0.1);

  &--failed {
    border-color: rgba($negative, 0.4);
  }

  &--saved {
    border-color: rgba($positive, 0.4);
  }
}
</style>
