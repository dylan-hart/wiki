<template>
  <w-menu
    class="translucent-menu"
    :context-menu="props.contextMenu"
    auto-close
    anchor="bottom right"
    self="top right">
    <w-list padding>
      <w-item
        clickable
        @click="create(`wysiwyg`)"
        v-if="siteStore.editors.wysiwyg && flagsStore.experimental">
        <blueprint-icon icon="google-presentation" />
        <w-item-section class="pr-2">{{ t('common.actions.newPage') }}</w-item-section>
      </w-item>
      <w-item clickable @click="create(`markdown`)" v-if="siteStore.editors.markdown">
        <blueprint-icon icon="markdown" />
        <w-item-section class="pr-2">{{ t('common.newPageMenu.markdown') }}</w-item-section>
      </w-item>
      <w-item clickable @click="create(`code`)" v-if="siteStore.editors.code">
        <blueprint-icon icon="html" />
        <w-item-section class="pr-2">{{ t('common.newPageMenu.code') }}</w-item-section>
      </w-item>
      <!--
        Not behind the experimental flag, matching `AdminEditors.vue`'s own row for this editor
        (task 491: a real `EditorAsciidoc.vue` exists now, so this is no longer speculative).
      -->
      <w-item clickable @click="create(`asciidoc`)" v-if="siteStore.editors.asciidoc">
        <blueprint-icon icon="asciidoc" />
        <w-item-section class="pr-2">{{ t('common.newPageMenu.asciidoc') }}</w-item-section>
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
        <blueprint-icon icon="advance" />
        <w-item-section class="pr-2">{{ t('common.newPageMenu.redirect') }}</w-item-section>
      </w-item>
      <!-- -> Always offered, not gated on an editor toggle or the Pandoc extension
              (OpenProject #1092): a `format: 'markdown'` import needs neither -- it is a
              pass-through read of the file's own bytes, not a conversion into some editor's own
              format. Formats that DO still need Pandoc stay gated at conversion time instead,
              inside the dialogs themselves, the same 503 they always answered without it. -->
      <w-item clickable @click="openImport">
        <blueprint-icon icon="new-document" />
        <w-item-section class="pr-2">{{ t('pages.import.menuLabel') }}</w-item-section>
      </w-item>
      <w-item clickable @click="openImportBatch">
        <blueprint-icon icon="merge-files" />
        <w-item-section class="pr-2">{{ t('pages.importBatch.menuLabel') }}</w-item-section>
      </w-item>
      <template v-if="props.hideAssetBtn === false">
        <w-separator class="my-2" inset />
        <w-item clickable @click="openFileManager">
          <blueprint-icon icon="add-image" />
          <w-item-section class="pr-2">{{ t('common.newPageMenu.uploadAsset') }}</w-item-section>
        </w-item>
      </template>
      <template v-if="props.showNewFolder">
        <w-separator class="my-2" inset />
        <w-item clickable @click="newFolder">
          <blueprint-icon icon="add-folder" />
          <w-item-section class="pr-2">{{ t('common.actions.newFolder') }}</w-item-section>
        </w-item>
      </template>
    </w-list>
  </w-menu>
</template>

<script setup>
import { defineAsyncComponent } from 'vue'
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
