<template>
  <w-dialog v-model="dialogVisible" :aria-label="dialogTitle" @hide="onDialogHide">
    <w-card class="page-save-dialog" style="width: 860px; max-width: 90vw">
      <!--
        Corner marks, as four elements rather than two pseudo-elements on the card: a box has only
        `::before` and `::after` to give, and the marks are four independent boxes sitting OUTSIDE
        the card's own edge.
      -->
      <span aria-hidden="true" class="page-save-dialog-corner page-save-dialog-corner--ss" />
      <span aria-hidden="true" class="page-save-dialog-corner page-save-dialog-corner--se" />
      <span aria-hidden="true" class="page-save-dialog-corner page-save-dialog-corner--es" />
      <span aria-hidden="true" class="page-save-dialog-corner page-save-dialog-corner--ee" />
      <w-card-section v-if="props.mode === `savePage`" class="card-header">
        <w-icon name="tabler:file-plus" size="sm" class="me-2" />
        <span>{{ t('pageSaveDialog.title') }}</span>
      </w-card-section>
      <w-card-section v-else-if="props.mode === `duplicatePage`" class="card-header">
        <w-icon name="tabler:copy" size="sm" class="me-2" />
        <span>{{ t('pageDuplicateDialog.title') }}</span>
      </w-card-section>
      <w-card-section v-else-if="props.mode === `renamePage`" class="card-header">
        <w-icon name="tabler:cursor-text" size="sm" class="me-2" />
        <span>{{ t('pageRenameDialog.title') }}</span>
      </w-card-section>
      <w-card-section v-else-if="isMoveItem" class="card-header">
        <w-icon name="tabler:folder" size="sm" class="me-2" />
        <span>{{ dialogTitle }}</span>
      </w-card-section>
      <!--
        The 300px is stated inline as well as in the stylesheet below: `TreeBrowserDialog.test.js`
        measures this geometry in a real Chromium page built out of this markup, and stating the
        height on the element keeps the claim answerable however the SFC's styles reach that page.
      -->
      <div
        class="page-save-dialog-browser flex flex-nowrap"
        style="height: 300px; overflow: hidden">
        <div class="page-save-dialog-tree" :class="isMoveItem ? `w-full` : `w-1/3`">
          <w-scroll-area style="height: 300px">
            <!-- -> No side padding: the rows carry their own and span the column, and padding here
                    would inset the highlight band with them -->
            <div>
              <tree
                ref="treeComp"
                v-model:selected="state.currentFolderId"
                :nodes="state.treeNodes"
                :roots="state.treeRoots"
                :use-lazy-load="true"
                :context-action-list="[`newFolder`]"
                :display-mode="state.displayMode"
                @lazy-load="treeLazyLoad"
                @context-action="treeContextAction" />
            </div>
          </w-scroll-area>
        </div>
        <div v-if="!isMoveItem" class="w-2/3">
          <w-scroll-area style="height: 300px">
            <w-list class="page-save-dialog-filelist" dense>
              <w-item
                v-for="item of files"
                :key="item.id"
                clickable
                active-class="active"
                :active="item.id === state.currentFileId"
                @click="selectItem(item)">
                <w-item-section side>
                  <w-icon :name="item.icon" size="sm" />
                </w-item-section>
                <w-item-section>
                  <w-item-label>{{ item.title }}</w-item-label>
                </w-item-section>
              </w-item>
            </w-list>
          </w-scroll-area>
        </div>
      </div>
      <div class="page-save-dialog-hint">{{ t('pageSaveDialog.newFolderHint') }}</div>
      <div class="page-save-dialog-path flex flex-nowrap items-center">
        <up-one-level-btn :show="Boolean(state.currentFolderId)" @click="goUp" />
        <span class="font-robotomono truncate">{{ assembledPath }}</span>
      </div>
      <w-list v-if="!isMoveItem" class="page-save-dialog-fields">
        <w-item>
          <blueprint-icon icon="tabler:file-plus" />
          <w-item-section>
            <w-input
              ref="iptTitle"
              v-model="state.title"
              :label="t(`pageSaveDialog.pageTitle`)"
              dense
              @focus="state.currentFileId = null"
              @keyup:enter="save" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="tabler:file-symlink" />
          <w-item-section>
            <!--
              `label` is load-bearing: `e2e/helpers/admin.js#savePage` resolves this field by
              `getByLabel('Path Name')`, and depends on the focus its `fill()` fires reaching
              `onPathFocus`. `hint` adds an `aria-describedby`, never an accessible name, so the
              locator is unaffected by it.
            -->
            <w-input
              v-model="state.path"
              :label="t(`pageSaveDialog.pathName`)"
              :hint="t(`pageSaveDialog.pathNameHint`)"
              :rules="pathRules"
              monospaced
              dense
              @focus="onPathFocus"
              @keyup:enter="onPathEnter" />
          </w-item-section>
        </w-item>
        <!-- -> Translations are found by path, so a locale-only rename has nothing to cascade -->
        <w-item
          v-if="props.mode === `renamePage` && state.translationsCount > 0"
          class="page-save-dialog-translations">
          <w-item-section>
            <w-checkbox
              v-model="state.includeTranslations"
              :label="
                t(`pageRenameDialog.includeTranslations`, { count: state.translationsCount })
              " />
          </w-item-section>
        </w-item>
      </w-list>
      <w-card-actions class="card-actions px-4">
        <w-btn
          v-if="!isMoveItem"
          class="acrylic-btn"
          icon="tabler:dots"
          color="blue-grey"
          padding="xs sm"
          flat>
          <w-tooltip labels anchor="center right" self="center left">{{
            t(`pageSaveDialog.displayOptions`)
          }}</w-tooltip>
          <w-menu auto-close anchor="top left" self="bottom left">
            <w-card class="p-2">
              <w-list dense>
                <w-item clickable @click="state.displayMode = `path`">
                  <w-item-section side>
                    <w-icon
                      :name="state.displayMode === `path` ? `tabler:circle-check` : `tabler:circle`"
                      :color="state.displayMode === `path` ? `positive` : `grey`"
                      size="xs" />
                  </w-item-section>
                  <w-item-section class="pe-2">{{
                    t('pageSaveDialog.displayModePath')
                  }}</w-item-section>
                </w-item>
                <w-item clickable @click="state.displayMode = `title`">
                  <w-item-section side>
                    <w-icon
                      :name="
                        state.displayMode === `title` ? `tabler:circle-check` : `tabler:circle`
                      "
                      :color="state.displayMode === `title` ? `positive` : `grey`"
                      size="xs" />
                  </w-item-section>
                  <w-item-section class="pe-2">{{
                    t('pageSaveDialog.displayModeTitle')
                  }}</w-item-section>
                </w-item>
              </w-list>
            </w-card>
          </w-menu>
        </w-btn>
        <!-- -> A tooltip is not readable without a pointer, so the sentence sits beside the button;
                the tooltip stays on as the button's accessible name -->
        <span v-if="!isMoveItem" class="page-save-dialog-display-hint">{{
          t('pageSaveDialog.displayOptionsHint')
        }}</span>
        <w-space />
        <w-btn
          class="acrylic-btn"
          icon="tabler:x"
          :label="t(`common.actions.cancel`)"
          color="grey-7"
          padding="xs md"
          flat
          @click="onDialogCancel" />
        <w-btn
          icon="tabler:check"
          :label="isMoveItem ? confirmLabelText : t(`common.actions.save`)"
          color="primary"
          padding="xs md"
          :disabled="!isMoveItem && pathHasSlash"
          @click="save" />
      </w-card-actions>
    </w-card>
  </w-dialog>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

import { dialog, dialogComponentEmits, useDialogComponent } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { computed, onMounted, reactive, ref, watch } from 'vue'

import slugify from 'slugify'

import fileTypes from '../helpers/fileTypes'

import FolderCreateDialog from '@/components/FolderCreateDialog.vue'
import Tree from '@/components/TreeNav.vue'
import UpOneLevelBtn from '@/components/UpOneLevelBtn.vue'

import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'
import { log } from '@/helpers/log'
import { fetchTreeEntries, mergeFolderEntries, parentFolderIdOf } from '@/helpers/treeNodes'
import { normalizePagePath } from '@/helpers/pagePaths'

const props = defineProps({
  mode: {
    type: String,
    required: false,
    default: 'savePage'
  },
  /**
   * The site to browse, when it isn't the one on screen: the admin area opens this dialog for
   * whichever site its own picker has selected, which `siteStore` knows nothing about.
   */
  siteId: {
    type: String,
    required: false,
    default: ''
  },
  itemId: {
    type: String,
    required: false,
    default: ''
  },
  folderPath: {
    type: String,
    required: false,
    default: ''
  },
  itemTitle: {
    type: String,
    required: false,
    default: ''
  },
  itemFileName: {
    type: String,
    required: false,
    default: ''
  },
  title: {
    type: String,
    required: false,
    default: ''
  },
  confirmLabel: {
    type: String,
    required: false,
    default: ''
  },
  /**
   * The content locale to browse. Null for a caller with no page context of its own: it is sent as
   * no `locale` param at all, so the tree falls back to the site's primary locale.
   */
  locale: {
    type: String,
    required: false,
    default: null
  }
})

defineEmits([...dialogComponentEmits])

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptTitle.value
})

const siteStore = useSiteStore()

const { t } = useI18n()

const state = reactive({
  displayMode: 'title',
  currentFolderId: null,
  currentFileId: null,
  isFetching: false,
  treeNodes: {},
  treeRoots: [],
  fileList: [],
  title: '',
  path: '',
  typesToFetch: [],
  pathDirty: false,
  translationsCount: 0,
  includeTranslations: true
})

const treeComp = ref(null)
const iptTitle = ref(null)

// -> Path Name is the leaf slug only -- the folder comes from the tree browser, not from typing
//    `/`-separated segments here -- and a rule refuses one pre-submit rather than leaving it to
//    `save()`'s notification
const pathRules = [(value) => !value?.includes('/') || t('pageSaveDialog.pathNoSlashes')]

/** Mirrors the header's own per-mode title, as the dialog's accessible name. */
const dialogTitle = computed(() => {
  switch (props.mode) {
    case 'moveItem':
      return props.title || t('fileman.moveTitle')
    case 'duplicatePage':
      return t('pageDuplicateDialog.title')
    case 'renamePage':
      return t('pageRenameDialog.title')
    default:
      return t('pageSaveDialog.title')
  }
})

const isMoveItem = computed(() => props.mode === 'moveItem')

const confirmLabelText = computed(() => props.confirmLabel || t('fileman.moveConfirm'))

const currentFolderPath = computed(() => {
  const folderNode = state.currentFolderId ? state.treeNodes[state.currentFolderId] : null
  if (!folderNode?.fileName) {
    return '/'
  }
  return folderNode.folderPath
    ? `/${folderNode.folderPath}/${folderNode.fileName}/`
    : `/${folderNode.fileName}/`
})

const pathHasSlash = computed(() => state.path.includes('/'))

/**
 * Deliberately the same concatenation `save()` performs, so the path bar and the Save button cannot
 * disagree. `currentFolderPath` carries its own trailing slash, so an empty leaf still reads as a
 * folder.
 */
const assembledPath = computed(() => `${currentFolderPath.value}${state.path}`)

// -> The Save button's `:disabled="pathHasSlash"` only blocks a click, so Enter has to go through
//    the same guard rather than calling `save()` unconditionally
function onPathEnter() {
  if (pathHasSlash.value) {
    return
  }
  save()
}

const files = computed(() => {
  return state.fileList.map((f) => {
    switch (f.type) {
      case 'folder': {
        f.icon = fileTypes.folder.icon
        break
      }
      case 'page': {
        f.icon = fileTypes.page.icon
        break
      }
    }
    return f
  })
})

watch(
  () => state.currentFolderId,
  async (newValue) => {
    await loadTree({ parentId: newValue })
  }
)

watch(
  () => state.title,
  (newValue) => {
    if (state.pathDirty && !state.path) {
      state.pathDirty = false
    }
    if (!state.pathDirty) {
      state.path = slugify(newValue, { lower: true, strict: true })
    }
  }
)

/** Typing in the path field takes over from the tree selection that was driving it. */
function onPathFocus() {
  state.pathDirty = true
  state.currentFileId = null
}

function confirmDestination() {
  onDialogOK({
    folderId: state.currentFolderId,
    parentPath: currentFolderPath.value.slice(1, -1)
  })
}

async function save() {
  if (isMoveItem.value) {
    confirmDestination()
    return
  }
  if (!state.title?.trim()) {
    notify({
      type: 'negative',
      message: t('pageSaveDialog.titleMissing')
    })
    return
  }
  // -> A path is a URL: casing and spaces are corrected rather than refused, the way the server does
  //    it, and the field is left showing what will actually be saved
  state.path = normalizePagePath(state.path)
  // -> Mirrors the backend's `rePathName` (`models/tree.ts`), which validates ONE segment at a
  //    time: against the whole path it rejects every nested path. An empty interior segment (a stray
  //    double slash; `normalizePagePath` trims only the outer ones) is refused here too, since `+`
  //    needs at least one character.
  if (state.path.split('/').some((segment) => !/^[a-z0-9-]+$/.test(segment))) {
    notify({
      type: 'negative',
      message: t('pageSaveDialog.pathInvalid')
    })
    return
  }
  onDialogOK({
    title: state.title.trim(),
    path:
      currentFolderPath.value.length > 1
        ? `${currentFolderPath.value.substring(1)}${state.path}`
        : state.path,
    ...(props.mode === 'renamePage' ? { includeTranslations: state.includeTranslations } : {})
  })
}

/**
 * How many other locales' pages share this page's current path -- what decides whether the "Also
 * move N translation(s)" checkbox shows at all. Only `renamePage` has an already-saved page to ask
 * about.
 */
async function fetchTranslationsCount() {
  if (!props.itemId) {
    return
  }
  try {
    const siteId = props.siteId || siteStore.id
    const translations = await API_CLIENT.get(
      `sites/${siteId}/pages/${props.itemId}/translations`
    ).json()
    state.translationsCount = translations.length
  } catch (err) {
    // -> A caller who cannot list translations almost certainly cannot cascade to them either, so
    //    leaving the checkbox hidden is the safe fallback; the plain rename still works.
    log.warn('page', "could not count this page's translations", err)
  }
}

async function treeLazyLoad(nodeId, isCurrent, { done }) {
  await loadTree({ parentId: nodeId })
  done()
}

/**
 * `initLoad` asks for the folders above the one being listed as well, so opening the dialog on a
 * page buried a few levels down draws its whole branch from a single request. Those extra entries
 * come back flagged `isAncestor` and belong in the tree only, never in the file list.
 */
async function loadTree({ parentId = null, parentPath = null, initLoad = false }) {
  if (state.isFetching) {
    return
  }
  state.isFetching = true
  if (!parentId) {
    parentId = null
  }
  const isCurrentFolder = parentId === state.currentFolderId
  if (isCurrentFolder) {
    state.currentFileId = null
    state.fileList = []
  }
  try {
    const items = await fetchTreeEntries(props.siteId || siteStore.id, {
      parentId,
      parentPath,
      types: state.typesToFetch,
      locale: props.locale,
      initLoad
    })
    if (items?.length > 0) {
      const { roots: newTreeRoots } = mergeFolderEntries(state.treeNodes, items, parentId)
      for (const item of items) {
        switch (item.type) {
          case 'folder': {
            if (isCurrentFolder && !item.isAncestor) {
              state.fileList.push({
                id: item.id,
                type: 'folder',
                title: item.title,
                fileName: item.fileName
              })
            }
            break
          }
          case 'page': {
            if (isCurrentFolder) {
              state.fileList.push({
                id: item.id,
                type: 'page',
                title: item.title,
                pageType: item.editor || 'markdown',
                folderPath: item.folderPath,
                fileName: item.fileName,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt
              })
            }
            break
          }
        }
      }
      if (newTreeRoots.length > 0) {
        state.treeRoots = newTreeRoots
      }
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: t('pageSaveDialog.loadFailed'),
      caption: apiErrorMessage(err, t('common.error.unexpected'))
    })
  }
  if (parentId) {
    treeComp.value?.setLoaded(parentId)
  }
  state.isFetching = false
}

function treeContextAction(nodeId, action) {
  switch (action) {
    case 'newFolder': {
      newFolder(nodeId)
      break
    }
  }
}

/**
 * The same assignment a tree click makes, so the `currentFolderId` watcher lists the folder arrived
 * at either way. It deliberately leaves `state.path`, `state.title` and `pathDirty` alone: moving
 * where a page is saved is not the same as retyping what it is called.
 */
function goUp() {
  if (!state.currentFolderId) {
    return
  }
  state.currentFolderId = parentFolderIdOf(state.treeNodes, state.currentFolderId)
}

function selectItem(item) {
  // -> A folder is somewhere to save into, not something to overwrite
  if (item.type === 'folder') {
    state.currentFolderId = item.id
    treeComp.value?.setOpened(item.id)
    return
  }
  state.currentFileId = item.id
  state.pathDirty = true
  state.title = item.title
  state.path = item.fileName
}

function newFolder(parentId) {
  dialog({
    component: FolderCreateDialog,
    componentProps: {
      parentId
    }
  }).onOk(() => {
    loadTree({ parentId })
  })
}

function findFolderIdByPath(path) {
  if (!path) {
    return null
  }
  const entry = Object.entries(state.treeNodes).find(
    ([, node]) => (node.folderPath ? `${node.folderPath}/${node.fileName}` : node.fileName) === path
  )
  return entry?.[0] ?? null
}

onMounted(async () => {
  let fPath = props.folderPath
  let fName = props.itemFileName
  if (props.itemFileName?.includes('/')) {
    const fParts = props.itemFileName.split('/')
    fPath = fParts.slice(0, -1).join('/')
    fName = fParts.at(-1)
  }
  switch (props.mode) {
    case 'savePage':
    case 'duplicatePage': {
      state.typesToFetch = ['folder', 'page']
      break
    }
    case 'renamePage': {
      state.typesToFetch = ['folder', 'page']
      state.pathDirty = true
      fetchTranslationsCount()
      break
    }
    case 'moveItem': {
      state.typesToFetch = ['folder']
      break
    }
  }
  state.title = props.itemTitle || ''
  state.path = fName || ''
  await loadTree({
    parentPath: fPath,
    initLoad: true
  })
  // -> The initial request asked for the ancestors too, so opening the browser on the page's own
  //    subfolder, with its branch expanded, needs no further fetch
  const startFolderId = findFolderIdByPath(fPath)
  if (startFolderId) {
    const parts = fPath.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const ancestorId = findFolderIdByPath(parts.slice(0, i).join('/'))
      if (ancestorId) {
        treeComp.value?.setOpened(ancestorId)
      }
    }
    state.currentFolderId = startFolderId
  }
})
</script>

<style>
.page-save-dialog {
  /* A dialog is laid over the app rather than sitting in it, so it overrides `WCard`'s hairline
     with the stronger of the two edges. */
  border-color: var(--color-rule);
  /* Room for the corner marks: they sit 5px outside the card's edge, and `WDialog`'s panel is
     `overflow-auto`, so without this margin the box holding the card clips every one of them. */
  margin: 5px;
}
.body--dark .page-save-dialog {
  border-color: var(--color-border-dark);
}
.page-save-dialog {
  /*
    A crop mark is drawn in the ground the dialog is laid over, not in the card's own edge colour,
    so it reads as registration around the sheet rather than as a thickening of its border. The
    paper tone disappears over the backdrop's scrim, so dark mode takes the faint slate instead.
  */
}
.page-save-dialog-corner {
  position: absolute;
  width: 9px;
  height: 9px;
  border-color: var(--color-paper);
  border-style: solid;
  border-width: 0;
  pointer-events: none;
}
.body--dark .page-save-dialog-corner {
  border-color: var(--color-slate-faint);
}
.page-save-dialog {
  /*
    Named for CSS's own logical corners (`border-start-start-radius` and friends) rather than
    top-left/top-right, so the set still frames the card under RTL.
  */
}
.page-save-dialog-corner--ss {
  inset-block-start: -5px;
  inset-inline-start: -5px;
  border-block-start-width: 1px;
  border-inline-start-width: 1px;
}
.page-save-dialog-corner--se {
  inset-block-start: -5px;
  inset-inline-end: -5px;
  border-block-start-width: 1px;
  border-inline-end-width: 1px;
}
.page-save-dialog-corner--es {
  inset-block-end: -5px;
  inset-inline-start: -5px;
  border-block-end-width: 1px;
  border-inline-start-width: 1px;
}
.page-save-dialog-corner--ee {
  inset-block-end: -5px;
  inset-inline-end: -5px;
  border-block-end-width: 1px;
  border-inline-end-width: 1px;
}
.page-save-dialog {
  /*
    The header draws its separator as an OUTSET box-shadow, painted with the header's own
    background, and a later sibling's background paints over it -- so the tinted tree column hid
    that 1px line while the untinted file list left it showing. Positioning the header puts it
    above both, since a positioned element paints over its in-flow siblings.
  */
}
.page-save-dialog .card-header {
  position: relative;
  /* -> `.card-header` is the near-black raised tone, on which the accent's own text tone is too
        dark to read; `--color-accent-dark` is the tone it is lightened to for an ink ground */
}
.page-save-dialog .card-header > .w-icon {
  color: var(--color-accent-dark);
}
.page-save-dialog-browser {
  height: 300px;
  max-height: 90vh;
  /* -> Belt and braces with the scroll areas inside: whatever either column ends up holding, the
        browser cannot spill over the fields and buttons below */
  overflow: hidden;
  border-bottom: 1px solid var(--color-hairline);
}
.body--dark .page-save-dialog-browser {
  border-bottom-color: var(--color-hairline-dark);
}
.page-save-dialog {
  /*
    Tinted so the tree reads as a column of its own, and ruled off along its trailing edge -- the
    tint alone leaves the two columns sharing an edge nothing draws, which at this width reads as a
    gradient rather than as a division.
  */
}
.page-save-dialog-tree {
  background-color: var(--color-tint);
  border-inline-end: 1px solid var(--color-hairline);
}
.body--dark .page-save-dialog-tree {
  background-color: var(--color-dark-4);
  border-inline-end-color: var(--color-hairline-dark);
}
.page-save-dialog {
  /*
    The one accent FILL on the sheet: the folder being saved into. `TreeNav`'s own `.active` row is
    a faint wash of the ground, which is right everywhere else it is mounted and is not this
    dialog's to change -- so this is scoped under the tree column AND prefixed with the theme class,
    to win on specificity rather than on which stylesheet happens to be written out last.
  */
}
.body--light .page-save-dialog-tree .treeview-label.active,
.body--light .page-save-dialog-tree .treeview-label.active:hover,
.body--dark .page-save-dialog-tree .treeview-label.active,
.body--dark .page-save-dialog-tree .treeview-label.active:hover {
  background-color: var(--color-accent-fill);
  color: #fff;
}
.body--light .page-save-dialog-tree .treeview-label.active .w-icon,
.body--light .page-save-dialog-tree .treeview-label.active .treeview-label-text,
.body--light .page-save-dialog-tree .treeview-label.active:hover .w-icon,
.body--light .page-save-dialog-tree .treeview-label.active:hover .treeview-label-text,
.body--dark .page-save-dialog-tree .treeview-label.active .w-icon,
.body--dark .page-save-dialog-tree .treeview-label.active .treeview-label-text,
.body--dark .page-save-dialog-tree .treeview-label.active:hover .w-icon,
.body--dark .page-save-dialog-tree .treeview-label.active:hover .treeview-label-text {
  color: #fff;
}
.page-save-dialog-filelist {
  padding: 8px 12px;
}
.page-save-dialog-filelist > .w-item {
  padding: 4px 6px;
  /*
    NOT a fill: the tree's selected folder is the sheet's only filled surface, and a selected file
    is an offer to overwrite rather than the destination. `box-shadow` rather than a border for the
    leading edge, so the row does not change width as the selection moves down the list.
  */
}
.page-save-dialog-filelist > .w-item.active {
  background-color: var(--color-tint);
  box-shadow: inset 2px 0 0 0 var(--color-accent-fill);
  color: var(--color-accent-strong);
}
.page-save-dialog-filelist > .w-item.active .fileman-filelist-label .w-item-label--caption,
.page-save-dialog-filelist > .w-item.active .fileman-filelist-side .text-caption {
  color: var(--color-text-caption);
}
.body--dark .page-save-dialog-filelist > .w-item.active {
  background-color: var(--color-dark-4);
  color: var(--color-accent-dark);
}
.body--dark
  .page-save-dialog-filelist
  > .w-item.active
  .fileman-filelist-label
  .w-item-label--caption,
.body--dark .page-save-dialog-filelist > .w-item.active .fileman-filelist-side .text-caption {
  color: var(--color-text-caption-dark);
}
.page-save-dialog-hint {
  padding: 6px 16px 0;
  font-size: 12px;
  font-style: italic;
  color: var(--color-text-caption);
}
.body--dark .page-save-dialog-hint {
  color: var(--color-text-caption-dark);
}
.page-save-dialog {
  /*
    A fixed height because the up-one-level plate is absent at the root rather than disabled: a row
    that sized itself to its contents would jog every time the browser crossed in or out of the
    root. 38px is the 28px plate plus this row's own 5px above and below.
  */
}
.page-save-dialog-path {
  min-height: 38px;
  padding: 5px 16px;
  font-size: 12px;
  background-color: var(--color-tint-alt);
  border-bottom: 1px solid var(--color-hairline);
  color: var(--color-slate);
}
.body--dark .page-save-dialog-path {
  background-color: var(--color-dark-4);
  border-bottom-color: var(--color-hairline-dark);
  color: var(--color-slate-light);
}
.page-save-dialog {
  /* -> Block padding only: each `w-item` already carries the same 16px inline inset the path bar
        and the hint use, and adding it here too would double it and break their shared line */
}
.page-save-dialog-fields {
  padding-block: 14px;
}
.page-save-dialog {
  /*
    Aligned onto the fields' own text column rather than under their plates -- the checkbox is a
    qualifier on the move those fields describe, not a third field. The row's own 16px, plus the
    34px plate and the 14px gap beside it.
  */
}
.page-save-dialog-translations {
  padding-inline-start: 64px;
}
.page-save-dialog-display-hint {
  font-size: 11.5px;
  color: var(--color-text-caption);
}
.body--dark .page-save-dialog-display-hint {
  color: var(--color-text-caption-dark);
}
</style>
