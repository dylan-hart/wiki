<template>
  <!--
    Page Properties keeps the rail's full square; every other button is 48px, so the primary action
    reads as the largest target and the rest sit quieter beneath it.
  -->
  <div
    class="page-actions flex flex-col items-stretch order-last"
    :class="editorStore.isActive ? `is-editor` : ``">
    <template v-if="userStore.can(`write:pages`)">
      <!--
        Disabled rather than hidden on a redirection: it is the rail's primary action, and the square
        it occupies is what the rest of the buttons are arranged under.
      -->
      <w-btn
        class="aspect-square"
        flat
        icon="tabler:tag"
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
        <w-icon name="tabler:photo-cog" />
        <w-badge
          class="page-actions-pending-badge"
          v-if="hasPendingAssets"
          color="white"
          text-color="accent"
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
      All three are about a page's TEXT, which a redirection has none of — its content is a target,
      and there is no render for any of these to be about.
    -->
    <template v-if="!isRedirect">
      <!-- -> Follows `read:history` rather than page read access, the same question the API asks -->
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
            <!-- -> No button that would just 503: gated on the site's own availability signal -->
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
      <!--
        -> `read:source` is what the export endpoint's own `format=markdown` branch checks: no button
           that would just 403.
      -->
      <w-btn
        class="h-12"
        v-if="userStore.can(`read:source`)"
        flat
        icon="tabler:copy"
        :color="editorStore.isActive ? `white` : `slate-soft`"
        :aria-label="t('pageActions.copyPageContent')"
        @click="copyPageContent">
        <w-tooltip anchor="center left" self="center right">{{
          t('pageActions.copyPageContent')
        }}</w-tooltip>
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
          Literal colour classes, not WIcon's `color` prop: that builds `text-<name>` at runtime, and
          Tailwind only emits a utility it can see spelled out in source.
        -->
        <w-menu class="translucent-menu" anchor="top left" self="top right" auto-close>
          <w-list padding style="min-width: 225px">
            <w-item clickable v-if="canRerenderPage" @click="rerenderPage">
              <w-item-section class="items-center" avatar>
                <w-icon class="text-slate-soft" name="tabler:wand" size="sm" />
              </w-item-section>
              <w-item-section
                ><w-item-label>{{ t('common.page.rerender') }}</w-item-label></w-item-section
              >
            </w-item>
            <w-item clickable v-if="canConvertEditor" @click="convertEditor">
              <w-item-section class="items-center" avatar>
                <w-icon class="text-slate-soft" name="tabler:replace" size="sm" />
              </w-item-section>
              <w-item-section
                ><w-item-label>{{ t('common.page.convertEditor') }}</w-item-label></w-item-section
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
              rail: icon-only buttons whose labels exist only in a tooltip do not scale in a column
              56px wide, and these three act on the page as a FILE rather than on its contents, which
              is what a more menu is for.
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
import { copyToClipboard } from '@/helpers/clipboard'
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

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()

const router = useRouter()
const route = useRoute()

const { t } = useI18n()

const menuPendingAssets = ref(null)

const iptRenamePendingAsset = ref(null)

/**
 * A PDF export is a browser launch plus a full page render, several real seconds even on a fast
 * page, so the button says so and disables itself rather than letting a second click stack a second
 * render.
 */
const exportingPdf = ref(false)

/**
 * Only one row is ever in edit mode, so this and the two refs below carry the whole list's rename
 * state rather than anything tracked per item.
 */
const editingAssetId = ref(null)

const renameDraft = ref('')

const renameExt = ref('')

/**
 * No `;charset=` parameter on these MIME types: the save picker uses one as an `accept` key and
 * rejects a type carrying a parameter, and a Blob built from a JS string is UTF-8 regardless.
 */
const EXPORT_TEXT_TYPES = {
  markdown: { ext: 'md', mime: 'text/markdown' },
  html: { ext: 'html', mime: 'text/html' }
}

/**
 * Past `ky`'s own 10s default, which is well under what a browser launch plus navigation plus
 * settling plus `page.pdf()` can take. The server's own timeouts sum to roughly 75s worst case; this
 * rounds up past that rather than matching it precisely.
 */
const EXPORT_PDF_TIMEOUT = 90 * 1000

const hasPendingAssets = computed(() => editorStore.pendingAssets?.length > 0)

/** Null rather than a bare dot, for the rare pending asset with no extension at all. */
const renameSuffix = computed(() => (renameExt.value ? `.${renameExt.value}` : null))

/**
 * True for a redirection being read, edited or created alike -- `pageCreate` puts the editor on the
 * page store as well.
 */
const isRedirect = computed(() => pageStore.editor === 'redirect')

/**
 * `write:pages` is necessary but not sufficient: the route 503s without the Puppeteer extension
 * (`siteStore.pdfExportAvailable` is the same signal the PDF export item uses) and rejects any page
 * whose editor is not `markdown`. No button that just fails.
 */
const canRerenderPage = computed(
  () =>
    userStore.can('write:pages') && siteStore.pdfExportAvailable && pageStore.editor === 'markdown'
)

/**
 * Off while a suggestion is being written or a page is being created: neither is an act ON an
 * existing page, and a submitter who happens to hold those rights elsewhere should not find them
 * offered here. The three permissions below are checked individually on top of this, since a reader
 * may hold any one of them without the others.
 */
const showsFileActions = computed(
  () => !(editorStore.isActive && ['create', 'suggest'].includes(editorStore.mode))
)

/**
 * `markdown` and `wysiwyg` are the only pair `PageConvertDialog.vue` converts between, and both have
 * to be active on the site or there is nothing to convert TO. The flip is an edit like any other,
 * hence `write:pages` on top of the "acts on an existing page" gate.
 */
const canConvertEditor = computed(
  () =>
    showsFileActions.value &&
    userStore.can('write:pages') &&
    (pageStore.editor === 'markdown' || pageStore.editor === 'wysiwyg') &&
    Boolean(siteStore.editors?.markdown) &&
    Boolean(siteStore.editors?.wysiwyg)
)

const canDuplicate = computed(() => userStore.can('write:pages'))
const canRenameMove = computed(() => userStore.can('manage:pages'))
const canDelete = computed(() => userStore.can('delete:pages'))

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
  // -> An unsaved page has no `id` and so nothing for the overlay to fetch; heading it off here
  //    beats opening it to an empty state
  if (!pageStore.id) {
    notify.info(t('history.none'))
    return
  }
  siteStore.$patch({ overlay: 'PageHistory', overlayOpts: {} })
}

/** The home page's path is empty, hence the fallback. */
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
 * The export endpoint hands back each editor's native raw `content` regardless of the `format` name:
 * Markdown for `markdown` and `wysiwyg` alike, HTML source for `code`, AsciiDoc for `asciidoc` --
 * which is why the label reads generically rather than "Copy as Markdown".
 */
async function copyPageContent() {
  try {
    const text = await API_CLIENT.get(`sites/${siteStore.id}/pages/${pageStore.id}/export`, {
      searchParams: { format: 'markdown' }
    }).text()
    await copyToClipboard(text)
    notify({ type: 'positive', message: t('pages.copyContent.success') })
  } catch (err) {
    notify({
      type: 'negative',
      message: t('pages.copyContent.failed'),
      caption: apiErrorMessage(err)
    })
  }
}

/**
 * `.blob()` rather than `.json()` for a binary response; `ky` still parses a non-2xx body as JSON
 * into `err.data` first, which is what lets the catch below tell a missing extension apart from
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
    // -> Told apart from a generic failure so the reader learns whether retrying will help or an
    //    administrator has to install something
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

/**
 * The dialog runs its own render-equality guard and calls `pageStore.convertEditor()` itself; this
 * only reloads once it reports success, so the rail and the mounted editor pick up the flip.
 */
function convertEditor() {
  dialog({
    component: defineAsyncComponent(() => import('../components/PageConvertDialog.vue'))
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
      message: apiErrorMessage(err)
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
 * The same sanitize/validate pair `commitRenamePendingAsset` uses, so what the field flags while
 * typing is exactly what would be rejected on commit.
 */
function renameBaseNameRule(value) {
  return validateBaseName(sanitizeBaseName(value)) ?? true
}

function startRenamePendingAsset(item) {
  const { base, ext } = splitBaseName(item.fileName)
  editingAssetId.value = item.id
  renameDraft.value = base
  renameExt.value = ext
  // -> The field only renders once `editingAssetId` flips, so the ref is empty until this update
  //    reaches the DOM. It sits inside the pending-assets `v-for`, so Vue collects the ref as an
  //    array -- `[0]`, not `.value` directly.
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
 * Local state only: `UploadPendingAssetsDialog.vue` reads `item.fileName` when the page is actually
 * saved, so nothing reaches the server until then. Bound to the field's own blur as well as the
 * confirm button's click -- hence `@mousedown.prevent` on both buttons, without which a click on
 * Cancel would commit the very edit it means to discard before its own handler ran. An invalid draft
 * is left as-is, still editing.
 *
 * The menu's `@hide="cancelRenamePendingAsset"` covers the closes that dispatch no keydown at all --
 * an outside click, the catcher/resize close -- clearing `editingAssetId` ahead of the focus-restore
 * blur, so the guard below discards the half-typed edit instead of silently committing it.
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

<style>
/*
  1199.98px is just under the width at which the nav sidebar stops taking a column of its own -- the
  number `MainLayout` hands its drawer as `overlayBelow`. Below it the window-corner button lands in
  this rail; see the padding rule.
*/
.page-actions {
  flex: 0 0 56px;
  /*
    Room at the foot of the rail for the window-corner button (scroll-to-top, or the contents panel's
    opener below 750px), which is flush in the bottom-right corner once the nav sidebar overlays --
    exactly where this rail ends, on top of its last action. Padding on the rail rather than a margin
    on the last button: which button is last depends on the reader's permissions and on whether the
    editor is open. The rail scrolls its own overflow, so this cannot be scrolled behind.
  */
}
@media (max-width: 1199.98px) {
  .page-actions {
    padding-bottom: 3rem;
  }
}
.page-actions {
  /*
    Gone on a phone while a page is being read: the labels only ever appear in a tooltip, which a
    touch screen has no way to show, so the rail reads as unexplained glyphs down the edge of an
    already narrow article. Not while the editor is open, where the rail holds the properties panel
    and the pending asset queue and there is no other way to reach either.
  */
}
@media (max-width: 599.98px) {
  .page-actions:not(.is-editor) {
    display: none;
  }
}
.page-actions {
  /* The rail's ground is the same tint the sidebar takes, ruled off from the article column beside
     it, rather than a grey block of its own. */
}
.body--light .page-actions {
  background-color: var(--color-tint);
  border-inline-start: 1px solid var(--color-hairline);
}
.body--dark .page-actions {
  background-color: var(--color-dark-4);
  border-inline-start: 1px solid var(--color-hairline-dark);
}
.page-actions {
  /*
    Cobalt draws the READING rail as a short floating card rather than Ledger's full-height flush
    strip; `align-self: flex-start` is what stops `.page-container`'s `align-items: stretch` from
    stretching it to the row's full height. Scoped to `:not(.is-editor)` on purpose: the EDITOR's own
    rail stays a full-height accent strip in both aesthetics.
  */
}
body.body--cobalt .page-actions:not(.is-editor) {
  flex: 0 0 40px;
  align-self: flex-start;
  margin: 28px 24px 28px 0;
  border-inline-start: 0;
  border-radius: var(--radius-card);
  background-color: var(--color-white);
  /*
    An INSET ring, not `--shadow-card`'s plain outer one: `.page-actions` carries an unconditional
    `overflow-y: auto` a few rules down, which per spec forces `overflow-x` to compute to `auto` too,
    so a child that tried to overhang this box to paint over an outer ring would just be clipped
    there. Inset, the ring lives in the same paint layer as the background, and the page-properties
    plate below -- flush with this box's edges -- covers it in ordinary z-order. Local to this
    selector rather than flipping the shared token, which every other floating Cobalt card still
    draws as an outer ring. `--color-hairline` (not `-dark`) is already redefined under
    `body.body--cobalt.body--dark`, so no second dark-scoped copy of this rule is needed.
  */
  box-shadow: inset 0 0 0 1px var(--color-hairline);
  /*
    The rail's primary action, lifted into a rounded accent-fill plate rather than Ledger's square
    first cell. Its TOP corners take the CARD's `--radius-card`, not the plate's usual
    `--radius-control`, and `margin-top` is 0: this cell is flush with the card's left, right and top
    edges and caps them, rather than sitting inset with the card's hairline showing around it. The
    bottom corners stay `--radius-control` -- the plate reaches no card corner there.

    A plain cell, not a `WBtn`, so it cannot pick up `--shadow-primary` through that component's
    `color="accent"` wiring; it is a hand-wired consumer of the accent family on purpose.
  */
}
body.body--cobalt .page-actions:not(.is-editor) > .aspect-square:first-child {
  width: 40px;
  height: 40px;
  margin: 0 auto 4px;
  border-radius: var(--radius-card) var(--radius-card) var(--radius-control) var(--radius-control);
  border-block-end: 0;
  /*
    `--color-accent`, not `--color-accent-fill`: this plate carries a white glyph, and a white-texted
    accent surface resolves to `#c8303c` (5.3:1) rather than the untexted `#ff4d5a` (3.1:1).
  */
  background-color: var(--color-accent);
  box-shadow: var(--shadow-primary);
  /*
    The glyph colour is set on the icon, a DESCENDANT, and not on the cell itself: the template
    passes `color="accent-fill"` (which is what Ledger's plain white cell wants), and an inline style
    always beats an external rule on the very same element regardless of specificity. A rule that
    specifies `color` for `.w-icon` is a specified value for THAT element, which wins over whatever
    it would otherwise inherit from its ancestor. Same mechanism as the rule below.
  */
}
body.body--cobalt .page-actions:not(.is-editor) > .aspect-square:first-child .w-icon {
  color: var(--color-white);
}
body.body--cobalt .page-actions:not(.is-editor) {
  /*
    The rest of the rail's glyphs, which Cobalt draws as saturated strokes on the card rather than
    the chrome slate Ledger sets them in.

    `.h-12`, not `.aspect-square:not(:first-child)`: Page Properties is the rail's only
    `.aspect-square` cell -- it alone keeps the full square -- so no sibling of it can ever match
    that selector. Targeted at `.w-icon` for the same inline-beats-external reason as above.
  */
}
body.body--cobalt .page-actions:not(.is-editor) > .h-12 .w-icon {
  color: var(--color-accent-strong);
}
body.body--cobalt.body--dark .page-actions:not(.is-editor) {
  background-color: var(--color-dark-3);
}
.page-actions {
  /*
    Editing fills the rail: the whole column in the accent, white glyphs on it, dividers and the mode
    overline in white at reduced alpha, and the primary cell marked by a wash rather than a colour of
    its own. This rail is where the two things only an author can do live.
  */
}
.page-actions.is-editor {
  /*
    Both theme scopes are spelled out because the rail's resting ground just above is itself
    theme-scoped: an unscoped `.is-editor` rule would be one class short of it and lose the cascade,
    leaving the fill off entirely.
  */
  /*
    `--color-accent`, not `--color-primary`: identical in Ledger, but they part company under Cobalt,
    where `primary` is that aesthetic's blue and the accent is what an accent SURFACE takes. The
    accent also resolves darker than the `#e4676b`/`#ff4d5a` the design files paint, which is what
    clears 4.5:1 under the white glyphs and white overline this rail carries (they are 3.26:1 and
    3.1:1).
  */
}
.body--light .page-actions.is-editor,
.body--dark .page-actions.is-editor {
  background-color: var(--color-accent);
  border-inline-start: 1px solid var(--color-accent);
  color: #fff;
}
.page-actions.is-editor {
  /*
    Through `--w-hairline-color`, not `background-color`: `.w-hairline` is transparent itself and
    paints its line on an `::after` that reads that property (`css/tailwind.css`), so a colour set on
    the element paints nothing at all.
  */
}
.page-actions.is-editor .w-separator {
  --w-hairline-color: rgb(255 255 255 / 0.3);
}
.page-actions {
  /*
    The rail's first cell reads as its head rather than as the first of a row of equals: lifted onto
    the article column's own white, or -- once the rail is filled and there is no white to lift it
    onto -- marked with a wash of its own foreground.
  */
}
.body--light .page-actions > .aspect-square:first-child {
  background-color: var(--color-surface);
  border-block-end: 1px solid var(--color-hairline);
}
.body--dark .page-actions > .aspect-square:first-child {
  background-color: var(--color-dark-3);
  border-block-end: 1px solid var(--color-hairline-dark);
}
.page-actions {
  /*
    `.body--light`/`.body--dark` spelled out rather than relying on source order: the two rules just
    above are themselves theme-scoped, so an unscoped override would tie on specificity and win only
    by position -- which the next edit to this file could quietly undo.
  */
}
.body--light .page-actions.is-editor > .aspect-square:first-child {
  background-color: rgba(255, 255, 255, 0.14);
  border-block-end: 0;
}
.body--dark .page-actions.is-editor > .aspect-square:first-child {
  background-color: rgba(255, 255, 255, 0.14);
  border-block-end: 0;
}
.page-actions {
  overflow-y: auto;
  scrollbar-width: none;
  /*
    The mode overline is white at full opacity, not the design's 85%: it only ever renders while the
    editor is open, so it sits on the filled rail, where full opacity clears 4.5:1 and the softened
    version does not.
  */
}
.page-actions-mode {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  padding: 1.75rem 1rem 1.75rem 0;
  color: #fff;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.page-actions-pending-badge {
  animation: pageActionsBadgePulsate 2s ease infinite;
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
