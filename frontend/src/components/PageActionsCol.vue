<template>
  <!--
    `flex flex-col` in place of the `column` this carried: that was Quasar's flex helper and nothing
    defines it any more, so the rail was a plain block. Which is why `items-stretch` never stretched
    the buttons to its width, and why `<w-space />` -- a `flex-grow: 1` spacer -- could not push the
    last group to the bottom.
  -->
  <!--
    Page Properties keeps the rail's full square; every other button is 48px. The primary action for
    the page reads as the largest target, and the rest sit quieter beneath it.
  -->
  <div
    class="page-actions flex flex-col items-stretch order-last"
    :class="editorStore.isActive ? `is-editor` : ``">
    <template v-if="userStore.can(`write:pages`)">
      <!--
        Off for a redirection: the panel is contents, tags, ratings, comments and scripts, all of them
        about a page somebody reads. Disabled rather than hidden, because it is the rail's primary
        action and the square it occupies is what the rest of the buttons are arranged under.
      -->
      <w-btn
        class="aspect-square"
        flat
        icon="tabler:ballpen"
        :color="editorStore.isActive ? `white` : `accent-fill`"
        :disabled="isRedirect"
        :aria-label="t('pageActions.pageProperties')"
        @click="togglePageProperties">
        <w-tooltip anchor="center left" self="center right">{{
          t('common.page.properties')
        }}</w-tooltip>
      </w-btn>
      <!-- -> Nothing can be pasted or dropped onto a redirection: it is a form, not a document -->
      <w-btn
        class="h-12"
        v-if="editorStore.isActive && !isRedirect"
        flat
        color="white"
        :text-color="hasPendingAssets ? `white` : `accent-wash`"
        :aria-label="t('pageActions.pendingAssetUploads')">
        <!-- Outside the icon for the same reason as the review badge above -->
        <w-icon name="tabler:photo-cog" />
        <w-badge
          class="page-actions-pending-badge"
          v-if="hasPendingAssets"
          color="white"
          text-color="orange-9"
          rounded
          floating>
          <strong>{{ editorStore.pendingAssets.length * 1 }}</strong>
        </w-badge>
        <w-tooltip anchor="center left" self="center right">{{
          t('common.pendingAssets.title')
        }}</w-tooltip>
        <w-menu
          ref="menuPendingAssets"
          anchor="top left"
          self="top right"
          :offset="[10, 0]"
          @hide="cancelRenamePendingAsset">
          <w-card style="width: 450px">
            <w-card-section class="card-header">
              <w-icon name="img:/_assets/icons/color-data-pending.svg" left size="sm" />
              <span>{{ t('common.pendingAssets.title') }}</span>
            </w-card-section>
            <w-card-section v-if="!hasPendingAssets">{{
              t('common.pendingAssets.empty')
            }}</w-card-section>
            <w-list v-else separator>
              <w-item v-for="item of editorStore.pendingAssets" :key="item.id">
                <w-item-section side><w-icon name="tabler:file-type-jpg" /></w-item-section>
                <w-item-section v-if="editingAssetId === item.id">
                  <w-input
                    ref="iptRenamePendingAsset"
                    v-model="renameDraft"
                    dense
                    :label="t('pageActions.newFileName')"
                    :suffix="renameSuffix"
                    :rules="[renameBaseNameRule]"
                    @keyup:enter="commitRenamePendingAsset(item)"
                    @keydown.esc="cancelRenamePendingAsset"
                    @blur="commitRenamePendingAsset(item)" />
                </w-item-section>
                <w-item-section v-else>{{ item.fileName }}</w-item-section>
                <w-item-section side>
                  <div class="flex gap-1">
                    <template v-if="editingAssetId === item.id">
                      <w-btn
                        class="acrylic-btn"
                        color="positive"
                        round
                        icon="tabler:check"
                        size="xs"
                        flat
                        :aria-label="t('pageActions.confirmRename')"
                        @mousedown.prevent
                        @click="commitRenamePendingAsset(item)" />
                      <w-btn
                        class="acrylic-btn"
                        color="grey"
                        round
                        icon="tabler:x"
                        size="xs"
                        flat
                        :aria-label="t('pageActions.cancelRename')"
                        @mousedown.prevent
                        @click="cancelRenamePendingAsset" />
                    </template>
                    <template v-else>
                      <w-btn
                        class="acrylic-btn"
                        color="grey"
                        round
                        icon="tabler:edit"
                        size="xs"
                        flat
                        :aria-label="t('pageActions.renamePendingAsset')"
                        @click="startRenamePendingAsset(item)" />
                      <w-btn
                        class="acrylic-btn"
                        color="negative"
                        round
                        icon="tabler:x"
                        size="xs"
                        flat
                        :aria-label="t('pageActions.removePendingAsset')"
                        @click="removePendingAsset(item)" />
                    </template>
                  </div>
                </w-item-section>
              </w-item>
            </w-list>
            <w-card-section class="card-actions">
              <em class="text-caption">{{ t('common.pendingAssets.helpText') }}</em>
            </w-card-section>
          </w-card>
        </w-menu>
      </w-btn>
      <!-- -> Nothing follows it on a redirection, and a rule with nothing under it is just a line -->
      <w-separator class="my-2" v-if="!isRedirect" inset />
    </template>
    <!--
      The three below are all about a page's TEXT: what it used to say, what it says in source, and
      the things that can be done to that text. A redirection has none — its content is a target, the
      form above is the whole of it, and there is no render for any of these to be about.
    -->
    <template v-if="!isRedirect">
      <!--
        `read:history` is the permission that exists to say who may see what a page used to contain, so
        the button follows it rather than page read access. The API asks the same question.
      -->
      <w-btn
        class="h-12"
        v-if="userStore.can(`read:history`)"
        flat
        icon="tabler:history"
        :color="editorStore.isActive ? `white` : `slate-soft`"
        :aria-label="t('pageActions.pageHistory')"
        @click="viewPageHistory">
        <w-tooltip anchor="center left" self="center right">{{
          t('common.page.history')
        }}</w-tooltip>
      </w-btn>
      <!--
        Markdown/HTML download instantly (fetch-then-`fileSave`, same as the old Page Source overlay
        used); PDF drives a headless Chromium render that genuinely takes a few real seconds, so the
        button itself carries `loading` while it's in flight -- `w-btn`'s own spinner-over-icon, which
        also disables the button so a second click can't stack a second render underneath the first.
      -->
      <w-btn
        class="h-12"
        flat
        icon="tabler:file-export"
        :loading="exportingPdf"
        :color="editorStore.isActive ? `white` : `slate-soft`"
        :aria-label="t('pageActions.exportPage')">
        <w-tooltip anchor="center left" self="center right">{{
          t('pages.export.title')
        }}</w-tooltip>
        <w-menu anchor="top left" self="top right" auto-close :offset="[10, 0]">
          <w-list padding style="min-width: 180px">
            <w-item clickable @click="exportPage(`markdown`)">
              <w-item-section class="items-center" avatar>
                <w-icon class="text-deep-orange-9" name="tabler:markdown" size="sm" />
              </w-item-section>
              <w-item-section
                ><w-item-label>{{ t('pages.export.markdown') }}</w-item-label></w-item-section
              >
            </w-item>
            <w-item clickable @click="exportPage(`html`)">
              <w-item-section class="items-center" avatar>
                <w-icon class="text-deep-orange-9" name="tabler:brand-html5" size="sm" />
              </w-item-section>
              <w-item-section
                ><w-item-label>{{ t('pages.export.html') }}</w-item-label></w-item-section
              >
            </w-item>
            <!-- -> Gated on the availability signal task 500 added: no button that just 503s -->
            <w-item clickable v-if="siteStore.pdfExportAvailable" @click="exportPage(`pdf`)">
              <w-item-section class="items-center" avatar>
                <w-icon class="text-deep-orange-9" name="tabler:file-type-pdf" size="sm" />
              </w-item-section>
              <w-item-section
                ><w-item-label>{{ t('pages.export.pdf') }}</w-item-label></w-item-section
              >
            </w-item>
          </w-list>
        </w-menu>
      </w-btn>
    </template>
    <template v-if="!isRedirect && !(editorStore.isActive && editorStore.mode === `create`)">
      <w-separator class="my-2" inset />
      <w-btn
        class="h-12"
        flat
        icon="tabler:dots"
        :color="editorStore.isActive ? `white` : `slate-soft`"
        :aria-label="t('common.header.pageActions')">
        <w-tooltip anchor="center left" self="center right">{{
          t('common.header.pageActions')
        }}</w-tooltip>
        <!--
          Literal colour classes, not WIcon's `color` prop: that builds `text-<name>` at runtime and
          Tailwind only emits a utility it can see spelled out, so these icons had been drawing in the
          inherited text colour rather than the rail's own.
        -->
        <w-menu class="translucent-menu" anchor="top left" self="top right" auto-close>
          <w-list padding style="min-width: 225px">
            <!-- -> Gated on `canRerenderPage`: needs Puppeteer, and the backend's `ensureCanRender`
                    rejects any editor but markdown -->
            <w-item clickable v-if="canRerenderPage" @click="rerenderPage">
              <w-item-section class="items-center" avatar>
                <w-icon class="text-slate-soft" name="tabler:wand" size="sm" />
              </w-item-section>
              <w-item-section
                ><w-item-label>{{ t('common.page.rerender') }}</w-item-label></w-item-section
              >
            </w-item>
            <w-item clickable @click="toggleBacklinks">
              <w-item-section class="items-center" avatar>
                <w-icon class="text-slate-soft" name="tabler:sun" size="sm" />
              </w-item-section>
              <w-item-section
                ><w-item-label>{{ t('common.page.viewBacklinks') }}</w-item-label></w-item-section
              >
            </w-item>
            <!--
              Duplicate, rename/move and delete live HERE rather than as three more buttons down the
              rail (Cardinal, `ui-redesign/CLAUDE.md`). Six icon-only buttons whose labels exist only
              in a tooltip is five too many for a column 56px wide, and the three that were cut are
              the three a reader never wants: they act on the page as a FILE, not on its contents,
              which is what a more menu is for.

              Hidden outright while a suggestion is being written or a page is being created:
              duplicating, moving or deleting is not part of suggesting a change, and a submitter who
              happens to hold those rights elsewhere would otherwise find them here. Same condition
              the three buttons carried, moved with them.
            -->
            <template v-if="showsFileActions">
              <w-separator v-if="canDuplicate || canRenameMove || canDelete" class="my-1" />
              <w-item clickable v-if="canDuplicate" @click="duplicatePage">
                <w-item-section class="items-center" avatar>
                  <w-icon class="text-slate-soft" name="tabler:copy" size="sm" />
                </w-item-section>
                <w-item-section
                  ><w-item-label>{{ t('common.page.duplicate') }}</w-item-label></w-item-section
                >
              </w-item>
              <w-item clickable v-if="canRenameMove" @click="renamePage">
                <w-item-section class="items-center" avatar>
                  <w-icon class="text-slate-soft" name="tabler:share" size="sm" />
                </w-item-section>
                <w-item-section
                  ><w-item-label>{{ t('common.page.renameMove') }}</w-item-label></w-item-section
                >
              </w-item>
              <w-item clickable v-if="canDelete" @click="deletePage">
                <w-item-section class="items-center" avatar>
                  <w-icon class="text-accent" name="tabler:trash" size="sm" />
                </w-item-section>
                <w-item-section
                  ><w-item-label class="text-accent">{{
                    t('common.page.delete')
                  }}</w-item-label></w-item-section
                >
              </w-item>
            </template>
          </w-list>
        </w-menu>
      </w-btn>
    </template>
    <w-space />
    <!-- Which of the two write modes the editor is in, set down the rail's own length. -->
    <span v-if="!showsFileActions && editorStore.isActive" class="page-actions-mode">{{
      editorStore.mode === `suggest`
        ? t('common.actions.suggestedEdit')
        : t('common.actions.newPage')
    }}</span>
  </div>
</template>

<script setup>
import { computed, defineAsyncComponent, nextTick, ref } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { fileSave } from 'browser-fs-access'

import { confirm, dialog } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import {
  renameFileName,
  sanitizeBaseName,
  splitBaseName,
  validateBaseName
} from '@/helpers/pendingAssetRename'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

// STORES

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

// ROUTER

const router = useRouter()
const route = useRoute()

// I18N

const { t } = useI18n()

// REFS

const menuPendingAssets = ref(null)

/** The rename field for whichever pending asset is currently being renamed -- not a dialog, so
 *  there is no `useDialogComponent` to focus it; see `startRenamePendingAsset`. */
const iptRenamePendingAsset = ref(null)

// DATA

/**
 * Whether an export request is in flight -- a browser launch plus a full page render, several
 * seconds even on a fast page, so the button needs to say so rather than sit inert.
 */
const exportingPdf = ref(false)

/**
 * The pending asset currently being renamed (OpenProject #878), by `id` -- null when none is. Only
 * one row can be in edit mode at a time, so this and the two refs below are enough state for the
 * whole list rather than something tracked per item.
 */
const editingAssetId = ref(null)

/** The base name (no extension) as currently typed, for the item `editingAssetId` points at. */
const renameDraft = ref('')

/** That item's fixed extension, carried alongside the draft purely to build the `w-input` suffix. */
const renameExt = ref('')

/**
 * File extension + MIME for the two formats fetched as text. Kept bare of a `;charset=` parameter:
 * the save picker uses this as an `accept` key and rejects a type carrying one, and a Blob built from
 * a JS string is UTF-8 regardless -- the same fetch-then-`fileSave` pattern the now-retired
 * `PageSourceOverlay.vue` (the old "Page Source" rail button's viewer) had already proven.
 */
const EXPORT_TEXT_TYPES = {
  markdown: { ext: 'md', mime: 'text/markdown' },
  html: { ext: 'html', mime: 'text/html' }
}

/**
 * How long the client gives the PDF export request, in milliseconds -- past `ky`'s own 10s default,
 * which is well under what a browser launch plus navigation plus settling plus `page.pdf()` can take.
 * Not exact: `models/pdfExport.ts`'s own timeouts (navigation 30s + block-settle 15s + PDF 30s) sum to
 * 75s worst case, so this rounds up past that rather than matching it precisely.
 */
const EXPORT_PDF_TIMEOUT = 90 * 1000

// COMPUTED

const hasPendingAssets = computed(() => editorStore.pendingAssets?.length > 0)

/** `w-input`'s trailing suffix for the rename field -- null (nothing rendered) for the rare pending
 *  asset with no extension at all, rather than a bare dot. */
const renameSuffix = computed(() => (renameExt.value ? `.${renameExt.value}` : null))

/**
 * Whether the page this rail is for is a redirection — one being read, edited or created alike, since
 * `pageCreate` puts the editor on the page store as well.
 *
 * A redirection has no text, so most of this rail is about something that is not there: see the
 * individual buttons for what each one loses.
 */
const isRedirect = computed(() => pageStore.editor === 'redirect')

/**
 * Whether Rerender Page may be offered at all: `write:pages` is necessary but not sufficient -- the
 * route also 503s without the Puppeteer extension (mirrored here via `siteStore.pdfExportAvailable`,
 * same signal the PDF export item above already uses) and throws `renderUnsupportedEditor` for any
 * page whose editor isn't `markdown` (backend/models/rendering.ts's `ensureCanRender`). No button that
 * just fails, per OpenProject #858.
 */
const canRerenderPage = computed(
  () =>
    userStore.can('write:pages') && siteStore.pdfExportAvailable && pageStore.editor === 'markdown'
)

/**
 * Whether the more menu offers the three actions that treat the page as a FILE -- duplicate,
 * rename/move, delete (Cardinal folded them in from the rail; see the menu's own comment).
 *
 * Off while a suggestion is being written or a page is being created: neither is an act ON an
 * existing page, and a submitter who happens to hold those rights elsewhere should not find them
 * offered here. The three permissions below are checked individually on top of this, since a reader
 * may hold any one of them without the others.
 */
const showsFileActions = computed(
  () => !(editorStore.isActive && ['create', 'suggest'].includes(editorStore.mode))
)

const canDuplicate = computed(() => userStore.can('write:pages'))
const canRenameMove = computed(() => userStore.can('manage:pages'))
const canDelete = computed(() => userStore.can('delete:pages'))

// METHODS

function togglePageProperties() {
  siteStore.$patch({
    sideDialogComponent: 'PagePropertiesDialog',
    sideDialogShown: true
  })
}

function toggleBacklinks() {
  siteStore.$patch({
    sideDialogComponent: 'PageBacklinksDialog',
    sideDialogShown: true
  })
}

function viewPageHistory() {
  // -> An unsaved page has no `id` yet, and therefore no history to show -- the overlay has nothing
  //    to fetch, so head it off here rather than opening it to an empty state.
  if (!pageStore.id) {
    notify.info(t('history.none'))
    return
  }
  siteStore.$patch({ overlay: 'PageHistory', overlayOpts: {} })
}

/** The page's own name, off its path -- the home page's path is empty, so that falls back to `home`. */
function exportFileStem() {
  return pageStore.path.split('/').filter(Boolean).pop() || 'home'
}

function exportPage(format) {
  return format === 'pdf' ? exportPagePdf() : exportPageText(format)
}

async function exportPageText(format) {
  const type = EXPORT_TEXT_TYPES[format]
  try {
    const text = await API_CLIENT.get(`sites/${siteStore.id}/pages/${pageStore.id}/export`, {
      searchParams: { format }
    }).text()
    await fileSave(new Blob([text], { type: type.mime }), {
      fileName: `${exportFileStem()}.${type.ext}`,
      extensions: [`.${type.ext}`]
    })
  } catch (err) {
    // -> Dismissing the file picker is not a failure
    if (err.name !== 'AbortError') {
      notify({
        type: 'negative',
        message: t('pages.export.textFailed'),
        caption: apiErrorMessage(err)
      })
    }
  }
}

/**
 * Ask the server to render this page's live view to PDF and save the result -- a binary response, so
 * `.blob()` rather than `.json()`; `ky` still parses a non-2xx body as JSON into `err.data` first (see
 * `helpers/apiError.js`), which is what lets the catch below tell a missing extension apart from
 * anything else going wrong.
 */
async function exportPagePdf() {
  exportingPdf.value = true
  try {
    const blob = await API_CLIENT.get(`sites/${siteStore.id}/pages/${pageStore.id}/export/pdf`, {
      timeout: EXPORT_PDF_TIMEOUT
    }).blob()
    await fileSave(blob, {
      fileName: `${exportFileStem()}.pdf`,
      extensions: ['.pdf']
    })
  } catch (err) {
    // -> Dismissing the save picker is not a failure
    if (err.name === 'AbortError') {
      return
    }
    // -> Same error name `models/pdfExport.ts`'s `ensureCanExport` throws (mirroring
    //    `renderPuppeteerMissing` on the render queue) -- told apart from a generic failure so the
    //    reader knows whether reloading will help or an administrator needs to install something
    if (err?.data?.error === 'exportPuppeteerMissing') {
      notify({
        type: 'negative',
        message: t('pages.export.puppeteerMissing')
      })
    } else {
      notify({
        type: 'negative',
        message: t('pages.export.failed'),
        caption: apiErrorMessage(err)
      })
    }
  } finally {
    exportingPdf.value = false
  }
}

function rerenderPage() {
  dialog({
    component: defineAsyncComponent(() => import('../components/RerenderPageDialog.vue')),
    componentProps: {
      id: pageStore.id
    }
  }).onOk(() => {
    pageStore.pageLoad({ id: pageStore.id })
  })
}

function duplicatePage() {
  dialog({
    component: defineAsyncComponent(() => import('../components/TreeBrowserDialog.vue')),
    componentProps: {
      mode: 'duplicatePage',
      folderPath: '',
      itemId: pageStore.id,
      itemTitle: pageStore.title,
      itemFileName: pageStore.path,
      locale: pageStore.locale
    }
  }).onOk(async (newPageOpts) => {
    // -> `pageDuplicate` rejects on either its own source-page fetch failing or the `pageCreate` it
    //    now awaits (OpenProject #1787) rejecting -- previously dropped on the floor here, an
    //    unhandled rejection with no notify shown, matching `FileManager.vue`'s own duplicate handler
    try {
      await pageStore.pageDuplicate({
        sourcePageId: pageStore.id,
        path: newPageOpts.path,
        title: newPageOpts.title
      })
    } catch (err) {
      notify({
        type: 'negative',
        message: t('fileman.duplicateFailed'),
        caption: apiErrorMessage(err, t('common.error.unexpected'))
      })
    }
  })
}

function renamePage() {
  dialog({
    component: defineAsyncComponent(() => import('../components/TreeBrowserDialog.vue')),
    componentProps: {
      mode: 'renamePage',
      folderPath: '',
      itemId: pageStore.id,
      itemTitle: pageStore.title,
      itemFileName: pageStore.path,
      locale: pageStore.locale
    }
  }).onOk((renamedPageOpts) => {
    const isMove = renamedPageOpts.path !== pageStore.path
    // -> A title-only rename never moves the page off `home`, so only an actual move needs the guard
    if (isMove && pageStore.isHome) {
      confirm({
        title: t('pages.homepageGuard.moveTitle'),
        message: t('pages.homepageGuard.moveMessage', { name: pageStore.title }),
        cancel: true,
        color: 'negative',
        okLabel: t('pages.homepageGuard.proceed')
      }).onOk(() => applyRenameOrMove(renamedPageOpts, isMove))
    } else {
      applyRenameOrMove(renamedPageOpts, isMove)
    }
  })
}

async function applyRenameOrMove(renamedPageOpts, isMove) {
  try {
    if (!isMove) {
      await pageStore.pageRename({ id: pageStore.id, title: renamedPageOpts.title })
      notify({
        type: 'positive',
        message: t('pages.renameSuccess')
      })
    } else {
      await pageStore.pageMove({
        id: pageStore.id,
        path: renamedPageOpts.path,
        title: renamedPageOpts.title,
        includeTranslations: renamedPageOpts.includeTranslations
      })
      notify({
        type: 'positive',
        message: t('pages.moveSuccess')
      })
    }
  } catch (err) {
    notify({
      type: 'negative',
      message: err.message
    })
  }
}

function deletePage() {
  const openDeleteDialog = () => {
    dialog({
      component: defineAsyncComponent(() => import('../components/PageDeleteDialog.vue')),
      componentProps: {
        pageId: pageStore.id,
        pageName: pageStore.title
      }
    }).onOk(() => {
      router.replace('/')
    })
  }
  if (pageStore.isHome) {
    confirm({
      title: t('pages.homepageGuard.deleteTitle'),
      message: t('pages.homepageGuard.deleteMessage', { name: pageStore.title }),
      cancel: true,
      color: 'negative',
      okLabel: t('pages.homepageGuard.proceed')
    }).onOk(openDeleteDialog)
  } else {
    openDeleteDialog()
  }
}

function removePendingAsset(item) {
  URL.revokeObjectURL(item.blobUrl)
  editorStore.pendingAssets = editorStore.pendingAssets.filter((a) => a.id !== item.id)
  if (editorStore.pendingAssets.length < 1) {
    menuPendingAssets.value.hide()
  }
}

/**
 * `w-input`'s `rules` callback for the rename field -- run against the same sanitize/validate pair
 * `commitRenamePendingAsset` uses, so what the field flags as invalid while typing is exactly what
 * would be rejected on commit.
 */
function renameBaseNameRule(value) {
  return validateBaseName(sanitizeBaseName(value)) ?? true
}

function startRenamePendingAsset(item) {
  const { base, ext } = splitBaseName(item.fileName)
  editingAssetId.value = item.id
  renameDraft.value = base
  renameExt.value = ext
  // -> The field is only rendered once `editingAssetId` flips, so the ref is empty until after this
  //    update has been applied to the DOM. It sits inside the pending-assets `v-for`, which makes Vue
  //    collect the ref as an array (one entry, since only one item is ever being edited at a time)
  //    rather than a single instance -- `[0]`, not `.value` directly.
  nextTick(() => {
    iptRenamePendingAsset.value?.[0]?.focus()
  })
}

function cancelRenamePendingAsset() {
  editingAssetId.value = null
  renameDraft.value = ''
  renameExt.value = ''
}

/**
 * Commits the rename to `editorStore.pendingAssets` directly on the matching item -- there is no
 * server round-trip: `UploadPendingAssetsDialog.vue` reads `item.fileName` only when the page is
 * actually saved, so this is purely local state until then.
 *
 * Bound to the field's own blur as well as the confirm button's click, matching the app's existing
 * convention for a field committed on blur (see `onEditableBlur` on the page title). The confirm and
 * cancel buttons carry `@mousedown.prevent` so clicking either leaves the field focused rather than
 * blurring it first -- without that, a click on Cancel would commit the very edit it meant to
 * discard before its own handler ever ran. An invalid draft (sanitizes down to empty) is left as-is,
 * still editing, with `renameBaseNameRule` already showing why on the field itself.
 *
 * The menu's own `@hide="cancelRenamePendingAsset"` (see the template) still matters even though
 * `WMenu`'s own Escape handling now defers to this field's `@keydown.esc` first (OpenProject #2364)
 * -- `hide` also fires from paths that never dispatch a keydown at all: an outside click, the
 * catcher/resize close, or a second row's own action. Cancelling on `hide` (which `WMenu.vue#hide()`
 * fires before it restores focus) clears `editingAssetId` ahead of the focus-restore blur for all of
 * those paths, so the guard below catches it and the closing menu discards the in-progress edit
 * instead of silently committing whatever was half-typed.
 */
function commitRenamePendingAsset(item) {
  if (editingAssetId.value !== item.id) {
    return
  }
  const result = renameFileName(item.fileName, renameDraft.value)
  if (!result.ok) {
    return
  }
  item.fileName = result.fileName
  cancelRenamePendingAsset()
}
</script>

<style lang="scss">
/*
  Just under the width at which the site's nav sidebar stops taking a column of its own -- the number
  `MainLayout` hands its drawer as `overlayBelow`, and the same one `NavSidebar` states for its own use.
  Below it the corner button lands in this rail; see the padding rule.
*/
$sidebar-overlay-max: 1199.98px;

/** One row of this rail, which is what the bottom group has to clear. Matches the buttons' `h-12`. */
$action-btn-height: 3rem;

.page-actions {
  flex: 0 0 56px;

  /*
    Room at the foot of the rail for the button in the corner of the window -- scroll-to-top, or the
    contents panel's opener below 750px (`MainLayout` and `pages/Index.vue` respectively). While the nav
    sidebar has a column of its own that button is a disc straddling the sidebar's inner edge, nowhere
    near this rail; once the sidebar overlays instead, the button is flush in the bottom-right corner,
    which is exactly where this rail ends -- and it was landing on top of Delete Page. A tap at the middle
    of that button's box reached the corner button instead, so the last action in the rail was the one
    action a reader could not take.

    Padding on the rail rather than a margin on the last button: what is last here depends on the reader's
    permissions and on whether the editor is open, and the space is owed to whichever of them it turns out
    to be. The rail scrolls its own overflow, so this is inside what scrolls and cannot be scrolled behind.
  */
  @media (max-width: $sidebar-overlay-max) {
    padding-bottom: $action-btn-height;
  }

  /*
    Gone on a phone while a page is being read: the rail is a column of icon buttons whose labels only
    ever appear in a tooltip, which a touch screen has no way to show -- so it reads as six unexplained
    glyphs down the edge of an already narrow article.

    Not while the editor is open (`is-editor`), where the rail holds the properties panel and the pending
    asset queue, and taking it away would leave an author with no way to reach either.
  */
  @media (max-width: $breakpoint-xs-max) {
    &:not(.is-editor) {
      display: none;
    }
  }

  /*
    The rail's own ground: the tint, ruled off from the article column beside it. Cardinal's chrome is
    continuous light slate, so the rail is a strip of the same paper the sidebar is, not a grey block.
  */
  @at-root .body--light & {
    background-color: $tint;
    border-inline-start: 1px solid $hairline;
  }
  @at-root .body--dark & {
    background-color: $dark-4;
    border-inline-start: 1px solid $hairline-dark;
  }

  /*
    Editing turns the rail's own edge accent rather than filling the whole column: a 56px block of
    saturated red down the side of an article is the loudest thing on the screen, and what it has to
    say ("you are editing") is already said by the header, the toolbar and the save button. The strip
    marks the same state without competing with the work.
  */
  &.is-editor {
    border-inline-start: 2px solid $accent-fill;
  }

  /*
    The rail's first cell -- page properties, its primary action -- lifted onto the article column's
    own white so it reads as the head of the rail rather than as the first of a row of equals.
  */
  > .aspect-square:first-child {
    @at-root .body--light & {
      background-color: $surface;
      border-block-end: 1px solid $hairline;
    }
    @at-root .body--dark & {
      background-color: $dark-3;
      border-block-end: 1px solid $hairline-dark;
    }
  }

  /* -> Taller than the shell only on a very short window, and then it scrolls rather than clipping */
  overflow-y: auto;
  scrollbar-width: none;

  /* -> Set down the rail in Cardinal's chrome overline: tracked uppercase Roboto Mono */
  &-mode {
    writing-mode: vertical-rl;
    text-orientation: mixed;
    padding: 1.75rem 1rem 1.75rem 0;
    color: $accent-text;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }

  &-pending-badge {
    animation: pageActionsBadgePulsate 2s ease infinite;
  }
}

@keyframes pageActionsBadgePulsate {
  0% {
    transform: translate(0, 0);
  }
  50% {
    transform: translate(3px, -3px);
  }
  100% {
    transform: translate(0, 0);
  }
}
</style>
