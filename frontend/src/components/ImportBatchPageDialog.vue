<template>
  <w-dialog v-model="dialogVisible" :aria-label="t(`pages.importBatch.title`)" @hide="onDialogHide">
    <w-card class="import-batch-page-dialog" style="width: 760px; max-width: 94vw">
      <w-card-section class="card-header">
        <w-icon name="tabler:folder" size="sm" class="me-2" />
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
            <w-icon name="tabler:cloud-upload" size="40px" class="mb-2" />
            <div class="text-body2 mb-2">{{ t(`pages.importBatch.dropzoneLabel`) }}</div>
            <w-btn
              outline
              color="primary"
              icon="tabler:folder-open"
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
              <w-icon name="tabler:file-text" class="me-2" />
              <w-item-section>{{ file.name }}</w-item-section>
              <w-select
                v-model="state.formats[idx]"
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
                icon="tabler:x"
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
                  dense
                  class="flex-1"
                  hide-bottom-space
                  :disabled="row.saveStatus === `saving` || row.saveStatus === `saved`"
                  :label="t(`pages.importBatch.pageTitle`)" />
                <w-input
                  v-model="row.path"
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
            icon="tabler:arrow-left"
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
import { convertCheckboxGlyphs, htmlToMarkdown } from '@/helpers/htmlToMarkdown'
import { normalizePagePath, pagePathHash } from '@/helpers/pagePaths'
import { MarkdownRenderer } from '@/renderers/markdown'

import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useEditorStore } from '@/stores/editor'

/**
 * Unlike `ImportPageDialog.vue`, which hands converted content back to a caller, this dialog saves
 * the pages itself: opening N editors for N files is not a usable flow, so review and save both
 * happen here, each file with its own outcome.
 *
 * A dropped **folder** of markdown files is the flow this exists for: `onDrop` below walks the
 * browser's FileSystem Entry API to preserve that folder's structure into each row's destination
 * path, rather than flattening every file straight into `basePath`.
 */

/** Mirrored by hand in `ImportPageDialog.vue` — keep the two in step. */
const FORMATS = [
  { value: 'markdown', label: 'Markdown (.md)', needsPandoc: false },
  { value: 'mediawiki', label: 'MediaWiki', needsPandoc: true },
  { value: 'textile', label: 'Textile', needsPandoc: true },
  { value: 'docbook', label: 'DocBook', needsPandoc: true },
  { value: 'rst', label: 'reStructuredText', needsPandoc: true },
  { value: 'docx', label: 'Word Document (.docx)', needsPandoc: true },
  { value: 'odt', label: 'OpenDocument Text (.odt)', needsPandoc: true },
  { value: 'html', label: 'HTML (.htm, .html)', needsPandoc: false }
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

const CLIENT_SIDE_FORMATS = new Set(['html'])

/** Must match the backend's own `MAX_IMPORT_BATCH_FILES` (`backend/models/import.ts`). */
const MAX_BATCH_FILES = 20

const MAX_PATH_ATTEMPTS = 25

/**
 * `ky`'s 10s default is far short of what a batch conversion takes, and unlike a fixed ceiling this
 * request's cost varies batch to batch, so `computeBatchImportTimeout` derives it from the files
 * selected: the base is what one file alone needs (the route converts them in parallel, so it is
 * not one ceiling times file count), the per-file term is the CPU and disk contention each extra
 * pandoc process adds, and the throughput term covers a large upload over a slow connection -- the
 * one thing a fixed ceiling cannot.
 */
const IMPORT_BATCH_TIMEOUT_BASE = 40 * 1000
const IMPORT_BATCH_TIMEOUT_PER_FILE = 3 * 1000
const IMPORT_BATCH_ASSUMED_BYTES_PER_MS = 100

function computeBatchImportTimeout(files) {
  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0)
  return (
    IMPORT_BATCH_TIMEOUT_BASE +
    files.length * IMPORT_BATCH_TIMEOUT_PER_FILE +
    Math.ceil(totalBytes / IMPORT_BATCH_ASSUMED_BYTES_PER_MS)
  )
}

const props = defineProps({
  basePath: {
    type: String,
    default: null
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogCancel } = useDialogComponent()

const pageStore = usePageStore()
const siteStore = useSiteStore()
const editorStore = useEditorStore()

const { t } = useI18n()

const state = reactive({
  step: 'select',
  files: [],
  /** Parallel to `files` by index; `null` where the extension is not recognized. */
  formats: [],
  isDraggingOver: false,
  converting: false,
  saving: false,
  conflictBehavior: 'reject',
  results: []
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

const conflictOptions = computed(() => [
  { value: 'overwrite', label: t('pages.importBatch.conflictOverwrite') },
  { value: 'reject', label: t('pages.importBatch.conflictReject') },
  { value: 'new', label: t('pages.importBatch.conflictNew') }
])

const acceptExtensions = computed(() => `.${Object.keys(EXTENSION_FORMATS).join(',.')}`)

/*
  A file whose extension went undetected is still allowed into the batch: it fails only its own row
  once converted, so this blocks on there being no files at all and on nothing else.
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

function pickFiles() {
  fileIpt.value?.click()
}

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
 * Walks into dropped directories rather than reading the top level only, which is what lets
 * `onDrop` preserve a dropped folder's structure.
 *
 * @returns Each file paired with its path relative to the drop root — `'notes.md'` for a bare file,
 *   `'docs/guide/intro.md'` for one found inside a dropped folder.
 */
async function filesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer?.items ?? [])]
  const topEntries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter(Boolean)

  // -> No FileSystem Entry API support (older Firefox): fall back to the flat file list.
  if (topEntries.length === 0) {
    return [...(dataTransfer?.files ?? [])]
      .filter((file) => file.size > 0)
      .map((file) => ({ file, relativePath: file.name }))
  }

  const collected = []
  async function readAllEntries(reader) {
    const all = []
    // -> `readEntries()` returns children in browser-capped batches, signalled exhausted by an
    //    empty array -- one call does not see every child of a large directory.
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
      Not `webkitRelativePath`: it is a getter-only IDL attribute on `File.prototype`, and assigning
      to one from this module's strict-mode scope throws rather than silently no-opping. An own
      property of this dialog's own naming sidesteps that; `defaultPath` reads it back.
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

function decodeHtmlBytes(buffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

function imageDestination(src) {
  return /[\s()]/.test(src) ? `<${src}>` : src
}

async function convertHtmlFile(file) {
  try {
    const { markdown, images } = htmlToMarkdown(decodeHtmlBytes(await file.arrayBuffer()))
    const resolved = images.reduce(
      (md, { token, src, alt }) =>
        md.replace(`![${alt}](${token})`, () => `![${alt}](${imageDestination(src)})`),
      markdown
    )
    if (!resolved.trim()) {
      return { fileName: file.name, ok: false, message: t('pages.importBatch.htmlNoContent') }
    }
    return { fileName: file.name, ok: true, markdown: resolved }
  } catch {
    return { fileName: file.name, ok: false, message: t('pages.importBatch.htmlReadFailed') }
  }
}

async function convertOnServer(files, formats) {
  const form = new FormData()
  // -> One `formats` field right after each `files` field: the backend pairs a `formats` part
  //    with whichever upload it most recently saw, so the interleaving is load-bearing. An empty
  //    string lets the backend attempt its own detection and answer with a per-file error.
  files.forEach((file, idx) => {
    form.append('files', file, file.name)
    form.append('formats', formats[idx] ?? '')
  })
  const resp = await API_CLIENT.post(`sites/${siteStore.id}/pages/import/batch`, {
    timeout: computeBatchImportTimeout(files),
    searchParams: {
      path: props.basePath || ''
    },
    body: form
  }).json()
  return resp?.results ?? []
}

async function convert() {
  if (!canConvert.value) {
    return
  }
  state.converting = true
  try {
    const indexes = state.files.map((_, idx) => idx)
    const clientIdxs = indexes.filter((idx) => CLIENT_SIDE_FORMATS.has(state.formats[idx]))
    const serverIdxs = indexes.filter((idx) => !CLIENT_SIDE_FORMATS.has(state.formats[idx]))

    const [clientItems, serverItems] = await Promise.all([
      Promise.all(clientIdxs.map((idx) => convertHtmlFile(state.files[idx]))),
      serverIdxs.length
        ? convertOnServer(
            serverIdxs.map((idx) => state.files[idx]),
            serverIdxs.map((idx) => state.formats[idx])
          )
        : []
    ])
    const items = []
    clientIdxs.forEach((idx, n) => (items[idx] = clientItems[n]))
    serverIdxs.forEach((idx, n) => (items[idx] = serverItems[n]))

    /*
      Zipped by index, not looked up by name: the endpoint answers one result per file in the order
      they were sent, and `state.files` is the only place `relativePath` is still reachable.
    */
    state.results = indexes
      .filter((idx) => items[idx])
      .map((idx) => {
        const item = items[idx]
        const file = state.files[idx]
        return {
          id: uuid(),
          fileName: item.fileName,
          ok: Boolean(item.ok),
          markdown: convertCheckboxGlyphs(item.markdown ?? ''),
          convertMessage: item.message ?? '',
          // -> A title the server parsed out of front matter beats the file-name default.
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
    // -> A client-side timeout while the server is still converting must not read as a failure:
    //    retrying resends every file and re-runs every pandoc conversion for nothing.
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
 * `file.relativePath` — set by `onDrop`'s directory walk, absent for a browse-button selection —
 * carries a dropped folder's segments ahead of the file name, each slugified independently.
 */
function defaultPath(file) {
  const segments = (file.relativePath || file.name).split('/').filter(Boolean)
  const fileName = segments.pop()
  const fileSlug = slugify(defaultTitle(fileName), { lower: true, strict: true })
  const dirSlugs = segments.map((segment) => slugify(segment, { lower: true, strict: true }))
  return [props.basePath, ...dirSlugs, fileSlug].filter(Boolean).join('/')
}

/**
 * The markdown pipeline lives in the frontend (`renderers/markdown.js`), so nothing server-side
 * turns `content` into `render`. A page view reads `render`, not `content`, so saving without this
 * would store pages that show blank until somebody re-saves them in the editor.
 */
async function renderMarkdown(markdown, pagePath) {
  // -> `ensureConfigs()`, not a bare `configIsLoaded` check: it also refreshes the glossary term
  //    list when the rest of the config is already loaded.
  await editorStore.ensureConfigs()
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
 * Page creation has no site-wide conflict setting of its own to read, so a duplicate-path refusal
 * resolves against `state.conflictBehavior`, chosen per import.
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

  // -> 'new', the one behavior left: try successive suffixes until one is free
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

/** Sequential, not parallel: 'new' resolution retries against paths a previous row may just have taken. */
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
    Each new page can change what an `auto`/`mixed` menu generates from the tree; invalidated once
    here rather than inside `saveRow()`, which would re-walk the tree per row.
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
  if (!row.ok || row.saveStatus === 'failed') return 'tabler:alert-circle'
  if (row.saveStatus === 'saved') return 'tabler:circle-check'
  return 'tabler:file-text'
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

<style>
/* Written out in full rather than nested: `&--suffix` is Sass string concatenation, not valid
   native CSS nesting, and a browser silently drops such a rule instead of erroring. */
.import-batch-page-dialog-review {
  max-height: 60vh;
  overflow: auto;
}
.import-batch-page-dialog-actions {
  background-color: var(--color-dark-3);
  background-image: radial-gradient(at top left, var(--color-dark-3), var(--color-dark-5));
  border-top: 1px solid #000;
  box-shadow: 0 -1px 0 0 rgba(255, 255, 255, 0.06);
  color: #fff;
}

.import-batch-dropzone {
  border: 2px dashed rgba(0, 0, 0, 0.2);
  transition: border-color 0.15s ease;
}

.import-batch-dropzone--over {
  border-color: var(--color-primary);
}

.import-batch-row {
  border: 1px solid rgba(0, 0, 0, 0.1);
}

.import-batch-row--failed {
  border-color: color-mix(in srgb, var(--color-negative) 40%, transparent);
}

.import-batch-row--saved {
  border-color: color-mix(in srgb, var(--color-positive) 40%, transparent);
}
</style>
