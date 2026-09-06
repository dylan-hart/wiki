<template>
  <w-dialog v-model="dialogVisible" :aria-label="dialogTitle" @hide="onDialogHide">
    <w-card class="page-save-dialog" style="width: 860px; max-width: 90vw">
      <!--
        Corner marks. The handoff's rule is two opposite corners on a menu -- a light object -- and
        all four on a dialog, which this is. Four separate elements rather than two pseudo-elements
        on the card, because a box has only `::before` and `::after` to give and the marks have to
        be four independent boxes sitting OUTSIDE the card's own edge.

        Marked `aria-hidden`: they are the frame, not content.
      -->
      <span aria-hidden="true" class="page-save-dialog-corner page-save-dialog-corner--ss" />
      <span aria-hidden="true" class="page-save-dialog-corner page-save-dialog-corner--se" />
      <span aria-hidden="true" class="page-save-dialog-corner page-save-dialog-corner--es" />
      <span aria-hidden="true" class="page-save-dialog-corner page-save-dialog-corner--ee" />
      <w-card-section v-if="props.mode === `savePage`" class="card-header">
        <w-icon name="tabler:file-plus" size="sm" class="me-2" />
        <span>{{ t('pageSaveDialog.title') }}</span>
      </w-card-section>
      <!--
        `tabler:copy`, not the `img:/_assets/icons/color-documents.svg` this replaces: Cardinal's
        chrome is monochrome line work, and a full-colour raster-style asset in a dialog's own title
        band was the last of the 2.x artwork on this sheet. It is also a literal Iconify reference,
        so `scripts/generate-icons.mjs` inlines it rather than leaving it to resolve through
        `/_icons` at runtime.
      -->
      <w-card-section v-else-if="props.mode === `duplicatePage`" class="card-header">
        <w-icon name="tabler:copy" size="sm" class="me-2" />
        <span>{{ t('pageDuplicateDialog.title') }}</span>
      </w-card-section>
      <w-card-section v-else-if="props.mode === `renamePage`" class="card-header">
        <w-icon name="tabler:cursor-text" size="sm" class="me-2" />
        <span>{{ t('pageRenameDialog.title') }}</span>
      </w-card-section>
      <!--
        The fixed 300px is stated here as an inline style as well as in the stylesheet below. Both
        columns scroll INSIDE it, so the dialog does not grow with a deep tree or a crowded folder --
        which is a geometry claim, and `TreeBrowserDialog.test.js` measures it in a real headless
        Chromium page off this markup. That measurement reads the compiled `tailwind.css` plus
        whatever the test document's own <style> elements carry; stating the height on the element
        keeps the claim answerable regardless of how the SFC's styles reach the page.
      -->
      <div
        class="page-save-dialog-browser flex flex-nowrap"
        style="height: 300px; overflow: hidden">
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
      <!--
        The folder you are saving into, and the one control that changes it without a tree click: the
        shared up-one-level plate (`UpOneLevelBtn.vue`), the same one the Browse panel and the File
        Manager carry. It goes on this row rather than above the browser because this row is already
        the answer to "where am I" -- which is what the plate acts on, and what the design means by
        the name beside it moving with it.

        The name beside it is what the tree selection and the leaf field add up to -- the path that
        will actually be written, not the folder alone. It is the same string `save()` assembles, so
        the bar cannot disagree with the button beside it.
      -->
      <div class="page-save-dialog-path flex flex-nowrap items-center">
        <up-one-level-btn :show="Boolean(state.currentFolderId)" @click="goUp" />
        <span class="font-robotomono truncate">{{ assembledPath }}</span>
      </div>
      <w-list class="page-save-dialog-fields">
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
              `label` stays exactly as it is: `e2e/helpers/admin.js#savePage` resolves this field by
              `getByLabel('Path Name')` and depends on the focus its `fill()` fires reaching
              `onPathFocus`, which is what sets `pathDirty` and stops the title watcher overwriting
              what was typed. `hint` adds an `aria-describedby`, never an accessible name, so the
              locator is unaffected -- asserted in this component's own suite so a future edit fails
              as itself rather than as three e2e specs.
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
        <!--
          Only when there is something to offer: a locale-only rename (path staying put) has nothing
          to cascade, since translations are found by path -- see the model-side comment in
          `movePage`.
        -->
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
        <w-btn class="acrylic-btn" icon="tabler:dots" color="blue-grey" padding="xs sm" flat>
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
        <!--
          The plate says nothing on its own, and a tooltip is not readable without a pointer. The
          design puts the sentence beside it instead; the tooltip stays as the button's accessible
          name.
        -->
        <span class="page-save-dialog-display-hint">{{
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
          :label="t(`common.actions.save`)"
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
import UpOneLevelBtn from '@/components/UpOneLevelBtn.vue'

import { useSiteStore } from '@/stores/site'
import { apiErrorMessage } from '@/helpers/apiError'
import { log } from '@/helpers/log'
import { fetchTreeEntries, mergeFolderEntries, parentFolderIdOf } from '@/helpers/treeNodes'
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

/**
 * What the path bar shows: the folder the tree has selected plus the leaf the field holds.
 *
 * The design's own note is that the bar "always shows what the two add up to" -- the path that will
 * be written, rather than only the half the tree contributes. Deliberately the same concatenation
 * `save()` performs, so the bar and the button cannot disagree; `currentFolderPath` already carries
 * its trailing slash, so an empty leaf leaves the folder reading as a folder.
 */
const assembledPath = computed(() => `${currentFolderPath.value}${state.path}`)

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
    log.warn('page', "could not count this page's translations", err)
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

/**
 * Up one level: save into the folder above the one currently selected, or into the root when that
 * folder is directly under it.
 *
 * The same one-line assignment a tree click makes, so the watcher on `currentFolderId` lists the
 * folder arrived at either way. It deliberately leaves `state.path`, `state.title` and `pathDirty`
 * alone -- moving WHERE a page is saved is not the same as retyping WHAT it is called, and the path
 * field's auto-slug behaviour is what `e2e/helpers/admin.js#savePage` drives.
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
.page-save-dialog {
  /*
    The stronger of the two Cardinal edges. A dialog is laid over the app rather than sitting in it,
    so it takes `$rule` where a card in the page takes `$hairline` -- `WCard`'s own hairline border
    is what this overrides.
  */
  border-color: $rule;
  /*
    Room for the corner marks. They sit 5px outside the card's edge, and `WDialog`'s panel scrolls
    its own overflow (`.w-dialog-panel` is `overflow-auto`), so without the margin every one of them
    would be clipped away by the box that holds the card.
  */
  margin: 5px;

  @at-root .body--dark & {
    border-color: $border-dark;
  }

  /*
    A crop mark: two 1px edges meeting at a 9px corner, drawn in the ground the dialog is laid over
    rather than in the card's own edge colour, so it reads as registration around the sheet instead
    of as a thickening of its border. Over the backdrop's scrim in dark mode the paper tone
    disappears, so it takes the faint slate there instead.
  */
  &-corner {
    position: absolute;
    width: 9px;
    height: 9px;
    border-color: $paper;
    border-style: solid;
    border-width: 0;
    pointer-events: none;

    @at-root .body--dark & {
      border-color: $slate-faint;
    }
  }

  /*
    Named for CSS's own logical corners (`border-start-start-radius` and friends): block-start /
    inline-start, block-start / inline-end, and so on. Logical rather than top-left/top-right so the
    set still frames the card under RTL -- all four are present and the shape is symmetric, so each
    one simply becomes the corner it is drawing.
  */
  &-corner--ss {
    inset-block-start: -5px;
    inset-inline-start: -5px;
    border-block-start-width: 1px;
    border-inline-start-width: 1px;
  }

  &-corner--se {
    inset-block-start: -5px;
    inset-inline-end: -5px;
    border-block-start-width: 1px;
    border-inline-end-width: 1px;
  }

  &-corner--es {
    inset-block-end: -5px;
    inset-inline-start: -5px;
    border-block-end-width: 1px;
    border-inline-start-width: 1px;
  }

  &-corner--ee {
    inset-block-end: -5px;
    inset-inline-end: -5px;
    border-block-end-width: 1px;
    border-inline-end-width: 1px;
  }

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

    /*
      The one accent on the title band. `.card-header` is the near-black raised tone, on which the
      accent's own text tone is too dark to read -- `$accent-dark` is the tone Cardinal lightens it
      to for an ink ground.
    */
    > .w-icon {
      color: $accent-dark;
    }
  }

  &-browser {
    height: 300px;
    max-height: 90vh;
    /* -> Belt and braces with the scroll areas inside: whatever either column ends up holding, the
          browser cannot spill over the fields and buttons below it */
    overflow: hidden;
    border-bottom: 1px solid $hairline;

    @at-root .body--dark & {
      border-bottom-color: $hairline-dark;
    }
  }

  /*
    Tinted so the tree reads as a column of its own rather than running into the file list beside it,
    and ruled off along its trailing edge -- the tint alone leaves the two columns sharing an edge
    that nothing draws, which at this width reads as a gradient rather than as a division.

    This was a `> .col-4` rule, which the layout migration left pointing at a class that no longer
    exists -- the columns are Tailwind fractions now -- so the pane had been plain white since.
  */
  &-tree {
    background-color: $tint;
    border-inline-end: 1px solid $hairline;

    @at-root .body--dark & {
      background-color: $dark-4;
      border-inline-end-color: $hairline-dark;
    }
  }

  /*
    The one accent FILL on the sheet: the folder being saved into, and nothing else.

    `TreeNav` draws its own `.active` row as a faint wash of the ground, which is right everywhere
    else it is mounted (the File Manager, the link picker) and is not this dialog's to change. Scoped
    under the tree column and prefixed with the theme class so it out-specifies that rule on
    specificity rather than on which stylesheet happens to be written out last.
  */
  @at-root .body--light &-tree .treeview-label.active,
    .body--light &-tree .treeview-label.active:hover,
    .body--dark &-tree .treeview-label.active,
    .body--dark &-tree .treeview-label.active:hover {
    background-color: $accent-fill;
    color: #fff;

    .w-icon,
    .treeview-label-text {
      color: #fff;
    }
  }

  &-filelist {
    padding: 8px 12px;

    > .w-item {
      padding: 4px 6px;

      /*
        NOT a fill. The tree's selected folder is the sheet's only filled surface, so the selected
        file -- which is an offer to overwrite, not the destination -- is drawn as a tinted row with
        an accent edge at its leading side instead. `box-shadow` rather than a border, so the row
        does not change width as the selection moves down the list.
      */
      &.active {
        background-color: $tint;
        box-shadow: inset 2px 0 0 0 $accent-fill;
        color: $accent-strong;

        .fileman-filelist-label .w-item-label--caption,
        .fileman-filelist-side .text-caption {
          color: $text-caption;
        }

        @at-root .body--dark & {
          background-color: $dark-4;
          color: $accent-dark;

          .fileman-filelist-label .w-item-label--caption,
          .fileman-filelist-side .text-caption {
            color: $text-caption-dark;
          }
        }
      }
    }
  }

  &-hint {
    padding: 6px 16px 0;
    font-size: 12px;
    font-style: italic;
    color: $text-caption;

    @at-root .body--dark & {
      color: $text-caption-dark;
    }
  }

  /*
    The path bar. The cooler of the two tints, ruled off underneath, in mono -- it is a path, and
    every path in Cardinal is mono.

    A fixed height, for the same reason the Browse panel's header has one: the up-one-level plate is
    absent at the root rather than disabled, and a row that sized itself to its contents would jog by
    16px every time the browser crossed in or out of the root. 38px is the 28px plate plus the 5px
    this row already had above and below it.
  */
  &-path {
    min-height: 38px;
    padding: 5px 16px;
    font-size: 12px;
    background-color: $tint-alt;
    border-bottom: 1px solid $hairline;
    color: $slate;

    @at-root .body--dark & {
      background-color: $dark-4;
      border-bottom-color: $hairline-dark;
      color: $slate-light;
    }
  }

  /*
    Block padding only. Each `w-item` already carries the 16px inline inset the path bar and the hint
    above it use, so adding it here as well would inset the plates by 32px and break the one vertical
    line those three share.
  */
  &-fields {
    padding-block: 14px;
  }

  /*
    Aligned onto the fields' own text column rather than under their plates: the checkbox is a
    qualifier on the move the two fields describe, not a third field. The row's own 16px, plus the
    34px plate and the 14px gap beside it.
  */
  &-translations {
    padding-inline-start: 64px;
  }

  &-display-hint {
    font-size: 11.5px;
    color: $text-caption;

    @at-root .body--dark & {
      color: $text-caption-dark;
    }
  }
}
</style>
