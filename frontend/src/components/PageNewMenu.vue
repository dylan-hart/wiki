<template>
  <w-menu class="translucent-menu" auto-close anchor="bottom right" self="top right">
    <w-list padding>
      <w-item
        clickable
        @click="create(`wysiwyg`)"
        v-if="siteStore.editors.wysiwyg && flagsStore.experimental">
        <blueprint-icon icon="google-presentation" />
        <w-item-section class="pr-2">New Page</w-item-section>
      </w-item>
      <w-item clickable @click="create(`markdown`)" v-if="siteStore.editors.markdown">
        <blueprint-icon icon="markdown" />
        <w-item-section class="pr-2">New Markdown Page</w-item-section>
      </w-item>
      <w-item clickable @click="create(`code`)" v-if="siteStore.editors.code">
        <blueprint-icon icon="html" />
        <w-item-section class="pr-2">New Code Page</w-item-section>
      </w-item>
      <!--
        Not behind the experimental flag, matching `AdminEditors.vue`'s own row for this editor
        (task 491: a real `EditorAsciidoc.vue` exists now, so this is no longer speculative).
      -->
      <w-item clickable @click="create(`asciidoc`)" v-if="siteStore.editors.asciidoc">
        <blueprint-icon icon="asciidoc" />
        <w-item-section class="pr-2">New AsciiDoc Page</w-item-section>
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
        <w-item-section class="pr-2">New Redirection</w-item-section>
      </w-item>
      <template v-if="props.hideAssetBtn === false">
        <w-separator class="my-2" inset />
        <w-item clickable @click="openFileManager">
          <blueprint-icon icon="add-image" />
          <w-item-section class="pr-2">Upload Media Asset</w-item-section>
        </w-item>
      </template>
      <template v-if="props.showNewFolder">
        <w-separator class="my-2" inset />
        <w-item clickable @click="newFolder">
          <blueprint-icon icon="add-folder" />
          <w-item-section class="pr-2">New Folder</w-item-section>
        </w-item>
      </template>
    </w-list>
  </w-menu>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

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
  }
})

// EMITS

const emit = defineEmits(['newFolder', 'newPage'])

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
</script>
