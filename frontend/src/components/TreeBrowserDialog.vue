<template>
  <w-dialog v-model="dialogVisible" :aria-label="dialogTitle" @hide="onDialogHide">
    <w-card class="page-save-dialog" style="width: 860px; max-width: 90vw">
      <w-card-section v-if="props.mode === `savePage`" class="card-header">
        <w-icon name="img:/_assets/icons/fluent-save-as.svg" size="sm" class="mr-2" />
        <span>{{ t('pageSaveDialog.title') }}</span>
      </w-card-section>
      <w-card-section v-else-if="props.mode === `duplicatePage`" class="card-header">
        <w-icon name="img:/_assets/icons/color-documents.svg" size="sm" class="mr-2" />
        <span>{{ t('pageDuplicateDialog.title') }}</span>
      </w-card-section>
      <w-card-section v-else-if="props.mode === `renamePage`" class="card-header">
        <w-icon name="img:/_assets/icons/fluent-rename.svg" size="sm" class="mr-2" />
        <span>{{ t('pageRenameDialog.title') }}</span>
      </w-card-section>
      <div class="page-save-dialog-browser flex flex-nowrap">
        <div class="page-save-dialog-tree w-1/3">
          <w-scroll-area style="height: 300px">
            <!-- -> No side padding: the rows carry their own 12px and span the column, as in the
                    File Manager. Padding here would inset the highlight band as well. -->
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
        <div class="w-2/3">
          <!--
            Scrolls on its own, as the tree beside it does: this row is a fixed 300px, and a folder
            with more entries than that holds simply drew straight over the path bar, the two fields
            and the buttons underneath.
          -->
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
      <div class="page-save-dialog-path font-robotomono">{{ currentFolderPath }}</div>
      <w-list class="py-2">
        <w-item>
          <blueprint-icon icon="new-document" />
          <w-item-section>
            <w-input
              ref="iptTitle"
              v-model="state.title"
              :label="t(`pageSaveDialog.pageTitle`)"
              dense
              outlined
              @focus="state.currentFileId = null"
              @keyup:enter="save" />
          </w-item-section>
        </w-item>
        <w-item>
          <blueprint-icon icon="file-submodule" />
          <w-item-section>
            <w-input
              v-model="state.path"
              :label="t(`pageSaveDialog.pathName`)"
              :rules="pathRules"
              dense
              outlined
              @focus="onPathFocus"
              @keyup:enter="onPathEnter" />
          </w-item-section>
        </w-item>
        <!--
          Only when there is something to offer: a locale-only rename (path staying put) has nothing
          to cascade, since translations are found by path -- see the model-side comment in
          `movePage`.
        -->
        <w-item v-if="props.mode === `renamePage` && state.translationsCount > 0">
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
        <w-btn class="acrylic-btn" icon="la:ellipsis-h" color="blue-grey" padding="xs sm" flat>
          <w-tooltip labels anchor="center right" self="center left">{{
            t(`pageSaveDialog.displayOptions`)
          }}</w-tooltip>
          <w-menu auto-close anchor="top left" self="bottom left">
            <w-card class="p-2">
              <w-list dense>
                <w-item clickable @click="state.displayMode = `path`">
                  <w-item-section side>
                    <w-icon
                      :name="state.displayMode === `path` ? `la:check-circle` : `la:circle`"
                      :color="state.displayMode === `path` ? `positive` : `grey`"
                      size="xs" />
                  </w-item-section>
                  <w-item-section class="pr-2">{{
                    t('pageSaveDialog.displayModePath')
                  }}</w-item-section>
                </w-item>
                <w-item clickable @click="state.displayMode = `title`">
                  <w-item-section side>
                    <w-icon
                      :name="state.displayMode === `title` ? `la:check-circle` : `la:circle`"
                      :color="state.displayMode === `title` ? `positive` : `grey`"
                      size="xs" />
                  </w-item-section>
                  <w-item-section class="pr-2">{{
                    t('pageSaveDialog.displayModeTitle')
                  }}</w-item-section>
                </w-item>
              </w-list>
            </w-card>
          </w-menu>
        </w-btn>
        <w-space />
        <w-btn
          class="acrylic-btn"
          icon="la:times"
          :label="t(`common.actions.cancel`)"
          color="grey-7"
          padding="xs md"
          flat
          @click="onDialogCancel" />
        <w-btn
          icon="la:check"
          :label="t(`common.actions.save`)"
          unelevated
          color="primary"
          padding="xs md"
          :disabled="pathHasSlash"
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

import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'
import { fetchTreeEntries, mergeFolderEntries } from '@/helpers/treeNodes'
import { normalizePagePath } from '@/helpers/pagePaths'

// PROPS

const props = defineProps({
  mode: {
    type: String,
    required: false,
    default: 'savePage'
  },
  /**
   * The site to browse, when it isn't the one currently on screen -- the admin area's Recently
   * Deleted view opens this dialog for whichever site its own picker has selected, which is not
   * necessarily the site `siteStore` is showing.
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
  /**
   * The content locale to browse. Absent (null) for a caller with no page context of its own -- an
   * absent value is sent to the server as no `locale` param at all, so the tree defaults to the
   * site's primary locale, same as before this prop existed.
   */
  locale: {
    type: String,
    required: false,
    default: null
  }
})

// EMITS

defineEmits([...dialogComponentEmits])

// DIALOG

const { dialogVisible, onDialogHide, onDialogOK, onDialogCancel } = useDialogComponent({
  autofocus: () => iptTitle.value
})

// STORES

const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// DATA

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
  /** How many other locales' pages share this page's current path -- see `fetchTranslationsCount`. */
  translationsCount: 0,
  includeTranslations: true
})

// REFS

const treeComp = ref(null)
const iptTitle = ref(null)

// -> Path Name is the leaf slug only -- the folder itself comes from the tree browser (#1013), not
//    from typing `/`-separated segments here. Live validation (`w-input`'s `rules` convention) is
//    what blocks that pre-submit, rather than the old pattern of only catching it inside save() with
//    a post-submit notification.
const pathRules = [(value) => !value?.includes('/') || t('pageSaveDialog.pathNoSlashes')]

// COMPUTED

/** Mirrors the header's own per-mode title (below), as the dialog's accessible name. */
const dialogTitle = computed(() => {
  switch (props.mode) {
    case 'duplicatePage':
      return t('pageDuplicateDialog.title')
    case 'renamePage':
      return t('pageRenameDialog.title')
    default:
      return t('pageSaveDialog.title')
  }
})

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

// -> The Save button's `:disabled="pathHasSlash"` only blocks a click -- the Path Name field's own
//    `@keyup:enter` used to call `save()` directly regardless, so pressing Enter with a slash still
//    present silently bypassed the block this same commit added (OpenProject #1025). Route Enter
//    through the same guard rather than letting it call `save()` unconditionally.
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

// WATCHERS

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

// METHODS

/** Typing in the path field takes over from the tree selection that was driving it. */
function onPathFocus() {
  state.pathDirty = true
  state.currentFileId = null
}

async function save() {
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
  // -> This mirrors the backend's `rePathName` (`models/tree.ts`), which validates one path segment
  //    at a time -- checking the WHOLE path against it rejected every nested path outright. A segment
  //    can also be empty (a stray double slash; `normalizePagePath` only trims the leading/trailing
  //    ones), which the pattern itself would otherwise accept as "zero letters".
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
 * How many other locales' pages share this page's current path -- what decides whether the
 * "Also move N translation(s)" checkbox shows at all. Fetched only in `renamePage` mode, where
 * `props.itemId` names a real, already-saved page; `savePage`/`duplicatePage` have no page here to
 * ask about yet.
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
    // -> Missing entirely rather than defaulting to "may not move translations": a caller who
    //    cannot even list them almost certainly cannot cascade to them either, and the checkbox
    //    staying hidden is a safe, silent fallback -- the plain move/rename this dialog already
    //    offers is unaffected either way.
    console.warn(err)
  }
}

async function treeLazyLoad(nodeId, isCurrent, { done }) {
  await loadTree({ parentId: nodeId })
  done()
}

/**
 * Loads one folder into the tree, and — when that folder is the selected one — into the file list.
 *
 * `initLoad` asks for the folders above the one being listed as well, so that opening the dialog on a
 * page buried a few levels down draws its whole branch from a single request. Those extra entries come
 * back flagged `isAncestor` and belong in the tree only, never in the file list.
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
      // -> The folder half of the response is the tree, merged the same way the File Manager and the
      //    link picker merge it; the file list below is this dialog's own projection
      const { roots: newTreeRoots } = mergeFolderEntries(state.treeNodes, items, parentId)
      for (const item of items) {
        switch (item.type) {
          case 'folder': {
            // -> File List
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

/** The id of an already-loaded folder, addressed the way a path addresses it. */
function findFolderIdByPath(path) {
  if (!path) {
    return null
  }
  const entry = Object.entries(state.treeNodes).find(
    ([, node]) => (node.folderPath ? `${node.folderPath}/${node.fileName}` : node.fileName) === path
  )
  return entry?.[0] ?? null
}

// MOUNTED

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
  }
  state.title = props.itemTitle || ''
  state.path = fName || ''
  await loadTree({
    parentPath: fPath,
    initLoad: true
  })
  // -> A page that lives in a subfolder opens the browser on that subfolder rather than on the root.
  //    The initial request asked for the ancestors too, so the whole branch is already here.
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

<style lang="scss">
@use 'sass:color';

.page-save-dialog {
  /*
    The header draws its separator as an OUTSET box-shadow, which is painted with the header's own
    background -- and a later sibling's background is painted after it. So the tinted tree column
    covered that 1px line while the untinted file list left it showing, and the two columns looked as
    though they started at different heights.

    Positioning the header puts it above both: a positioned element paints over its in-flow siblings,
    so the line survives across the full width.
  */
  .card-header {
    position: relative;
  }

  &-browser {
    height: 300px;
    max-height: 90vh;
    /* -> Belt and braces with the scroll areas inside: whatever either column ends up holding, the
          browser cannot spill over the fields and buttons below it */
    overflow: hidden;
    border-bottom: 1px solid #fff;

    @at-root .body--light & {
      border-bottom-color: $blue-grey-1;
    }
    @at-root .body--dark & {
      border-bottom-color: $dark-3;
    }
  }

  /*
    Tinted so the tree reads as a column of its own rather than running into the file list beside it.

    This was a `> .col-4` rule, which the layout migration left pointing at a class that no longer
    exists -- the columns are Tailwind fractions now -- so the pane had been plain white since.
  */
  &-tree {
    @at-root .body--light & {
      background-color: $blue-grey-1;
    }
    @at-root .body--dark & {
      background-color: $dark-4;
    }
  }

  &-filelist {
    padding: 8px 12px;

    > .w-item {
      padding: 4px 6px;
      border-radius: 4px;

      &.active {
        background-color: var(--color-primary);
        color: #fff;

        .fileman-filelist-label .w-item-label--caption {
          color: rgba(255, 255, 255, 0.7);
        }

        .fileman-filelist-side .text-caption {
          color: rgba(255, 255, 255, 0.7);
        }
      }
    }
  }

  &-hint {
    padding: 6px 16px 0;
    font-size: 12px;
    font-style: italic;

    @at-root .body--light & {
      color: $blue-grey-5;
    }
    @at-root .body--dark & {
      color: $blue-grey-4;
    }
  }

  &-path {
    padding: 5px 16px;
    font-size: 12px;
    border-bottom: 1px solid #fff;

    @at-root .body--light & {
      background-color: color.adjust($blue-grey-1, $lightness: 4%);
      border-bottom-color: $blue-grey-1;
      color: $blue-grey-9;
    }
    @at-root .body--dark & {
      background-color: color.adjust($dark-4, $lightness: -1%);
      border-bottom-color: $dark-1;
      color: $blue-grey-3;
    }
  }
}
</style>
