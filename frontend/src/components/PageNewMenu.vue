<template>
  <w-menu
    class="translucent-menu"
    :context-menu="props.contextMenu"
    auto-close
    anchor="bottom right"
    self="top right">
    <w-list padding class="page-new-menu" :class="{ 'page-new-menu--compact': props.contextMenu }">
      <!--
        Corner marks: two opposite corners, because a menu is a light object -- the full four belong
        to a dialog or a card. Decorative, so they are `aria-hidden` boxes rather than anything the
        reader can reach, and logical properties throughout, so the diagonal mirrors under
        `dir="rtl"` instead of pointing the wrong way.

        Drawn just INSIDE the panel rather than overhanging it as the design sheet does: WMenu's
        popup is `overflow-auto`, which clips anything past its padding edge, and opening that up is
        a change to a shared component with some thirty call sites -- not something a decoration
        should be asking for.
      -->
      <i class="page-new-menu__mark page-new-menu__mark--start" aria-hidden="true" />
      <i class="page-new-menu__mark page-new-menu__mark--end" aria-hidden="true" />
      <!--
        Where the new page will land, named -- on the pointer-anchored menu only, which is the one
        opened from a row whose own position is what decides the answer.

        Right-clicking a FOLDER row creates inside it; right-clicking a PAGE row creates a SIBLING,
        in the folder that page lives in (`NavSidebarItem.vue#basePathFor`, and `pageCreate`'s own
        `${basePath}/new-page`). Nothing on screen said which of the two was about to happen, which
        is the whole reason this line exists.
      -->
      <div v-if="props.contextMenu" class="page-new-menu__target">
        {{ t('common.newPageMenu.targetFolder', { path: targetFolder }) }}
      </div>
      <w-item
        clickable
        @click="create(`wysiwyg`)"
        v-if="siteStore.editors.wysiwyg && flagsStore.experimental">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:presentation" />
        <w-item-section class="pe-2">{{ t('common.actions.newPage') }}</w-item-section>
      </w-item>
      <w-item clickable @click="create(`markdown`)" v-if="siteStore.editors.markdown">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:markdown" />
        <w-item-section class="pe-2">{{ t('common.newPageMenu.markdown') }}</w-item-section>
      </w-item>
      <w-item clickable @click="create(`code`)" v-if="siteStore.editors.code">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:brand-html5" />
        <w-item-section class="pe-2">{{ t('common.newPageMenu.code') }}</w-item-section>
      </w-item>
      <!--
        Not behind the experimental flag, matching `AdminEditors.vue`'s own row for this editor
        (task 491: a real `EditorAsciidoc.vue` exists now, so this is no longer speculative).
      -->
      <w-item clickable @click="create(`asciidoc`)" v-if="siteStore.editors.asciidoc">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:file-text" />
        <w-item-section class="pe-2">{{ t('common.newPageMenu.asciidoc') }}</w-item-section>
      </w-item>
      <!--
        `channel`/`blog`/`api` used to be offered here too, unconditionally, once behind the
        experimental flag. Task 492 removed all three from `AdminEditors.vue` -- none had a backing
        `EDITOR_CONTENT_TYPES` entry, schema property, or reachable `editorComponents` registration,
        so picking any of them here opened onto a blank, broken editor. Removed for the same reason,
        rather than left to rot behind the flag.
      -->
      <!-- -> Not an editor the site can turn off, because it authors nothing: a redirection is a page
              with a target instead of a body -->
      <w-item clickable @click="create(`redirect`)">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:player-track-next" />
        <w-item-section class="pe-2">{{ t('common.newPageMenu.redirect') }}</w-item-section>
      </w-item>
      <!-- -> Always offered, not gated on an editor toggle or the Pandoc extension
              (OpenProject #1092): a `format: 'markdown'` import needs neither -- it is a
              pass-through read of the file's own bytes, not a conversion into some editor's own
              format. Formats that DO still need Pandoc stay gated at conversion time instead,
              inside the dialogs themselves, the same 503 they always answered without it. -->
      <w-item clickable @click="openImport">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:file-plus" />
        <w-item-section class="pe-2">{{ t('pages.import.menuLabel') }}</w-item-section>
      </w-item>
      <!-- -> Trimmed from the pointer-anchored menu: the imports thin out to one row there, so the
              panel stays shorter than the tree it is covering. Batch import is the one that goes --
              it opens a dialog that saves every page itself, which is the least "create one here"
              of anything in this menu. -->
      <w-item v-if="!props.contextMenu" clickable @click="openImportBatch">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:arrow-merge" />
        <w-item-section class="pe-2">{{ t('pages.importBatch.menuLabel') }}</w-item-section>
      </w-item>
      <template v-if="props.hideAssetBtn === false">
        <w-separator class="my-2" inset />
        <w-item clickable @click="openFileManager">
          <blueprint-icon :compact="props.contextMenu" icon="tabler:photo-plus" />
          <w-item-section class="pe-2">{{ t('common.newPageMenu.uploadAsset') }}</w-item-section>
        </w-item>
      </template>
      <template v-if="props.showNewFolder">
        <w-separator class="my-2" inset />
        <w-item clickable @click="newFolder">
          <blueprint-icon :compact="props.contextMenu" icon="tabler:folder-plus" />
          <w-item-section class="pe-2">{{ t('common.actions.newFolder') }}</w-item-section>
        </w-item>
      </template>
    </w-list>
  </w-menu>
</template>

<script setup>
import { computed, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialog } from '@/composables/dialog'
import { loading } from '@/composables/loading'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useFlagsStore } from '@/stores/flags'

// PROPS

const props = defineProps({
  hideAssetBtn: {
    type: Boolean,
    default: false
  },
  showNewFolder: {
    type: Boolean,
    default: false
  },
  basePath: {
    type: String,
    default: null
  },
  /** Opens on right-click at the pointer instead of on left-click at the anchor -- see WMenu.vue's
   *  own `contextMenu` prop. Off by default so every existing click-triggered call site (the
   *  header toolbar button, the phone overflow menu, File Manager) is unaffected. */
  contextMenu: {
    type: Boolean,
    default: false
  }
})

// EMITS

const emit = defineEmits(['newFolder', 'newPage'])

// ASYNC COMPONENTS

// -> Loaded lazily rather than as static top-of-file imports: `ImportBatchPageDialog.vue` pulls in
//    `@/renderers/markdown` (markdown-it + plugins, katex, highlight.js), which otherwise sits in
//    every reader's static bundle for a menu item almost nobody clicks. Matches the
//    `defineAsyncComponent(() => import(...))` passed straight into `dialog()` at PageActionsCol.vue's
//    own `RerenderPageDialog`/`TreeBrowserDialog`/`PageDeleteDialog` call sites.
const ImportPageDialog = defineAsyncComponent(() => import('@/components/ImportPageDialog.vue'))
const ImportBatchPageDialog = defineAsyncComponent(
  () => import('@/components/ImportBatchPageDialog.vue')
)

// STORES

const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// COMPUTED

/**
 * The folder the new page will land in, as the mono line above the rows spells it.
 *
 * `basePath` is the value `pageCreate` actually builds the new path from (`${basePath}/new-page`),
 * so this names the real destination rather than a restatement of what was right-clicked. Rendered
 * with a leading slash, and as a bare `/` at the site root, so the two cases read as the same kind
 * of thing.
 */
const targetFolder = computed(() => `/${(props.basePath ?? '').replace(/^\/+/, '')}`)

// METHODS

async function create(editor) {
  loading.show()
  emit('newPage')
  await pageStore.pageCreate({ editor, basePath: props.basePath })
  loading.hide()
}

function openFileManager() {
  siteStore.openFileManager()
}

function newFolder() {
  emit('newFolder')
}

function openImport() {
  dialog({
    component: ImportPageDialog,
    componentProps: {
      basePath: props.basePath
    }
  }).onOk(async ({ content, title, description, tags }) => {
    loading.show()
    emit('newPage')
    await pageStore.pageCreate({
      editor: 'markdown',
      basePath: props.basePath,
      title,
      description,
      tags,
      content
    })
    loading.hide()
  })
}

function openImportBatch() {
  // -> Unlike `openImport` above, this dialog saves every page itself rather than handing content
  //    back through `.onOk()` -- there is no single new page to navigate into, so the menu just
  //    closes as soon as the dialog opens, the same way it does for every other item here.
  emit('newPage')
  dialog({
    component: ImportBatchPageDialog,
    componentProps: {
      basePath: props.basePath
    }
  })
}
</script>

<style scoped>
/*
  The panel itself. `position: relative` is what the corner marks position against -- the popup
  WMenu teleports is `position: fixed`, so without it they would anchor to that popup rather than to
  the list, which is the same box only for as long as the menu happens not to scroll.
*/
.page-new-menu {
  position: relative;
}

/*
  One corner mark: a 7px square showing two of its four sides, so a pair of them draws the two
  opposite corners the design asks a menu for.

  Logical properties throughout (`inset-block-*`/`inset-inline-*`, `border-block-*`/`border-inline-*`)
  so the diagonal mirrors with the reading direction rather than pointing the wrong way under
  `dir="rtl"` -- and so this stays outside `logicalSpacing.test.js`'s physical-declaration scan
  rather than needing an allowlist entry.
*/
.page-new-menu__mark {
  position: absolute;
  width: 7px;
  height: 7px;
  pointer-events: none;
}

.page-new-menu__mark--start {
  inset-block-start: 3px;
  inset-inline-start: 3px;
  border-block-start: 1px solid var(--color-slate-faint);
  border-inline-start: 1px solid var(--color-slate-faint);
}

.page-new-menu__mark--end {
  inset-block-end: 3px;
  inset-inline-end: 3px;
  border-block-end: 1px solid var(--color-slate-faint);
  border-inline-end: 1px solid var(--color-slate-faint);
}

/*
  The target-folder line. Mono, because that is what Cardinal sets every path in, and sized as a
  kicker rather than as a row: it labels the rows below it, it is not one of them.
*/
.page-new-menu__target {
  padding: 2px 12px 6px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--color-text-caption);
  /* -> A path can be long and this panel is narrow; the rows below truncate, so this does too */
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

:global(body.body--dark .page-new-menu__target) {
  color: var(--color-text-caption-dark);
}

/*
  The compact variant, at the pointer.

  The 28px plate itself comes from BlueprintIcon's own `compact`; what is left here is the space
  around it. WItemSection's avatar column is sized for the 34px plate (56px wide, 16px of trailing
  padding), which around a 28px plate reads as a gap wide enough to lose the pairing -- so the column
  shrinks to its content and the design's own 10px is set explicitly. The rows tighten to match,
  which is what keeps a menu at the finger shorter than the tree it is covering.
*/
.page-new-menu--compact :deep(.w-item) {
  min-height: 0;
  padding-block: 4px;
  padding-inline: 12px;
}

.page-new-menu--compact :deep(.w-item-section--avatar) {
  min-width: 0;
  padding-inline-end: 10px;
}

.page-new-menu--compact :deep(.w-item-section--main) {
  font-size: 13px;
}

/*
  Hover: the accent is taken by the GLYPH, not by the row and not by the plate, which keeps its
  hairline. A line-drawing menu has no fill to light up, so one coloured stroke is what says "this is
  the row under the pointer" -- see the design sheet's own note on the Markdown row.
*/
.page-new-menu :deep(.w-item--clickable:hover .blueprint-icon) {
  color: var(--color-accent-strong);
}

:global(body.body--dark .page-new-menu .w-item--clickable:hover .blueprint-icon) {
  color: var(--color-accent-dark);
}
</style>
