<template>
  <w-menu
    class="translucent-menu"
    :context-menu="props.contextMenu"
    auto-close
    anchor="bottom right"
    self="top right">
    <w-list padding class="page-new-menu" :class="{ 'page-new-menu--compact': props.contextMenu }">
      <!--
        Two opposite corners, because a menu is a light object -- the full four belong to a dialog or
        a card. Drawn just INSIDE the panel rather than overhanging it: WMenu's popup is
        `overflow-auto` and clips anything past its padding edge, and opening that up would be a
        change to a shared component for the sake of a decoration.
      -->
      <i class="page-new-menu__mark page-new-menu__mark--start" aria-hidden="true" />
      <i class="page-new-menu__mark page-new-menu__mark--end" aria-hidden="true" />
      <!--
        On the pointer-anchored menu only, where the right-clicked row decides the destination and
        nothing else on screen says which it is: a FOLDER row creates inside it, a PAGE row creates
        a SIBLING in the folder that page lives in (`NavSidebarItem.vue#basePathFor`).
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
        <span class="page-new-menu__beta">{{ t('common.newPageMenu.beta') }}</span>
      </w-item>
      <w-item clickable @click="create(`markdown`)" v-if="siteStore.editors.markdown">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:markdown" />
        <w-item-section class="pe-2">{{ t('common.newPageMenu.markdown') }}</w-item-section>
      </w-item>
      <w-item clickable @click="create(`code`)" v-if="siteStore.editors.code">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:brand-html5" />
        <w-item-section class="pe-2">{{ t('common.newPageMenu.code') }}</w-item-section>
      </w-item>
      <!-- Not behind the experimental flag, matching `AdminEditors.vue`'s own row for it. -->
      <w-item clickable @click="create(`asciidoc`)" v-if="siteStore.editors.asciidoc">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:file-text" />
        <w-item-section class="pe-2">{{ t('common.newPageMenu.asciidoc') }}</w-item-section>
      </w-item>
      <w-item clickable @click="openTemplatePicker">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:template" />
        <w-item-section class="pe-2">{{ t('common.newPageMenu.fromTemplate') }}</w-item-section>
      </w-item>
      <!-- -> Not an editor the site can turn off, because it authors nothing: a redirection is a page
              with a target instead of a body -->
      <w-item clickable @click="create(`redirect`)">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:player-track-next" />
        <w-item-section class="pe-2">{{ t('common.newPageMenu.redirect') }}</w-item-section>
      </w-item>
      <!-- -> Not gated on an editor toggle or the Pandoc extension: a `format: 'markdown'` import is
              a pass-through read of the file's own bytes, not a conversion. Formats that DO need
              Pandoc are gated at conversion time, inside the dialogs themselves. -->
      <w-item clickable @click="openImport">
        <blueprint-icon :compact="props.contextMenu" icon="tabler:file-plus" />
        <w-item-section class="pe-2">{{ t('pages.import.menuLabel') }}</w-item-section>
      </w-item>
      <!-- -> Trimmed from the pointer-anchored menu, so that panel stays shorter than the tree it
              covers. Batch import is the one that goes: it saves every page itself, the least
              "create one here" of anything in this menu. -->
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
  /** Opens on right-click at the pointer instead of on left-click at the anchor. */
  contextMenu: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['newFolder', 'newPage'])

// -> Lazy rather than static top-of-file imports: `ImportBatchPageDialog.vue` pulls in
//    `@/renderers/markdown` (markdown-it + plugins, katex, highlight.js), which would otherwise sit
//    in every reader's static bundle for a menu item almost nobody clicks
const ImportPageDialog = defineAsyncComponent(() => import('@/components/ImportPageDialog.vue'))
const ImportBatchPageDialog = defineAsyncComponent(
  () => import('@/components/ImportBatchPageDialog.vue')
)
const PageTemplatePickerDialog = defineAsyncComponent(
  () => import('@/components/PageTemplatePickerDialog.vue')
)

const editorStore = useEditorStore()
const flagsStore = useFlagsStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

const { t } = useI18n()

/**
 * `basePath` is what `pageCreate` builds the new path from (`${basePath}/new-page`), so this names
 * the real destination rather than what was right-clicked. Always leading-slashed, a bare `/` at
 * the site root, so both cases read as the same kind of thing.
 */
const targetFolder = computed(() => `/${(props.basePath ?? '').replace(/^\/+/, '')}`)

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

function openTemplatePicker() {
  const locale = siteStore.useLocales ? pageStore.locale : null
  dialog({
    component: PageTemplatePickerDialog,
    componentProps: {
      basePath: props.basePath ?? '',
      locale
    }
  }).onOk(async ({ template }) => {
    loading.show()
    emit('newPage')
    await pageStore.pageCreate({
      editor: template.editor,
      basePath: props.basePath,
      ...(locale ? { locale } : {}),
      title: template.name,
      description: template.description,
      content: template.content
    })
    loading.hide()
  })
}

function openImportBatch() {
  // -> No `.onOk()`: this dialog saves every page itself, so there is no single new page to
  //    navigate into and the menu just closes as the dialog opens
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
  What the corner marks position against: the popup WMenu teleports is `position: fixed`, so without
  this they would anchor to that popup rather than to the list, which is the same box only for as
  long as the menu happens not to scroll.
*/
.page-new-menu {
  position: relative;
}

/*
  A 7px square showing two of its four sides, so a pair draws two opposite corners.

  Logical properties throughout, so the diagonal mirrors with the reading direction rather than
  pointing the wrong way under `dir="rtl"` -- and so this stays outside `logicalSpacing.test.js`'s
  physical-declaration scan rather than needing an allowlist entry.
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

/* Mono, as every path is set here, and sized as a kicker: it labels the rows below, it is not one */
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
  A plain outlined eyebrow with no corner at all, in either aesthetic, so it takes no `--radius-*`
  token -- unlike a badge or a chip.
*/
.page-new-menu__beta {
  flex: none;
  padding: 2px 5px;
  border: 1px solid var(--color-hairline);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-text-caption);
}

:global(body.body--dark .page-new-menu__beta) {
  border-color: var(--color-hairline-dark);
  color: var(--color-text-caption-dark);
}

/*
  The plate itself comes from BlueprintIcon's own `compact`; what is left here is the space around
  it. WItemSection's avatar column is sized for the full-size plate, which around a compact one
  reads as a gap wide enough to lose the pairing -- so the column shrinks to its content and the
  spacing is set explicitly. The rows tighten to match, keeping a menu at the finger shorter than
  the tree it is covering.
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
  On hover the accent is taken by the GLYPH, not by the row and not by the plate, which keeps its
  hairline: a line-drawing menu has no fill to light up, so one coloured stroke is what marks the
  row under the pointer.
*/
.page-new-menu :deep(.w-item--clickable:hover .blueprint-icon) {
  color: var(--color-accent-strong);
}

:global(body.body--dark .page-new-menu .w-item--clickable:hover .blueprint-icon) {
  color: var(--color-accent-dark);
}
</style>
