<template>
  <div class="editor-code">
    <div class="editor-code-main">
      <div class="editor-code-sidebar">
        <!-- ------------------------------------------------------- -->
        <!-- SIDE TOOLBAR -->
        <!-- ------------------------------------------------------- -->
        <!-- -> Straight to the File Manager, the same affordance `EditorMarkdown.vue` exposes: see the
                note on its own `insertAssets` for why there is no separate URL/clipboard source. -->
        <w-btn
          icon="mdi:image-plus-outline"
          padding="sm sm"
          flat
          :aria-label="t('editor.markup.insertAssets')"
          @click="insertAssets">
          <w-tooltip anchor="center right" self="center left">{{
            t('editor.markup.insertAssets')
          }}</w-tooltip>
        </w-btn>
        <w-space />
        <span class="editor-code-type">HTML</span>
      </div>
      <!-- ------------------------------------------------------- -->
      <!-- MONACO EDITOR -->
      <!-- ------------------------------------------------------- -->
      <!--
        No preview pane: unlike markdown or AsciiDoc, this editor's raw source IS what gets rendered
        (see the component doc comment below) -- a preview here would only ever show the reader
        exactly what the author is already looking at, one keystroke behind.
      -->
      <div class="editor-code-editor"><div ref="monacoRef" /></div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { assetPath } from '@/helpers/assets'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { debounce } from 'es-toolkit/function'
import * as monaco from 'monaco-editor'
import { Range } from 'monaco-editor'

/**
 * The `code` editor: a raw HTML source with nothing between it and what gets stored.
 *
 * Matches 2.5.x's `editor-code.vue` — no markdown, no rendering pipeline, no preview pane, because
 * there is nothing for a preview to show that the source does not already say directly. What the
 * author types IS the render: on every change both `pageStore.content` and `pageStore.render` are set
 * to the same string, and `pageSave` sends both up unchanged (`stores/page.js`). The server's own
 * `sanitizeHtml` pass in `models/rendering.ts`'s `postProcess` is what stands between this and a
 * stored page — the same pass the WYSIWYG editor's HTML output already goes through — so nothing here
 * needs to sanitize or otherwise transform what is typed.
 *
 * Reuses the Monaco boot/setup pattern `EditorMarkdown.vue` established (the `wikijs` theme, the same
 * editor options) rather than a second code-editing library, just with the language mode swapped to
 * `html` and every markdown-only feature (the formatting toolbar, the table/block code lenses, the
 * scroll-synced preview, collaborative editing) left out — none of them has anything to attach to in
 * a single pane of plain HTML.
 */

// STORES

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// STATE

let editor
const monacoRef = ref(null)

// METHODS

function insertAssets() {
  siteStore.openFileManager({ insertMode: true })
}

/**
 * What the file manager handed back, as raw HTML at the cursor.
 *
 * `EditorMarkdown.vue`'s `insertAssetClb` writes markdown syntax for the same event; this editor's
 * source is HTML directly, so what goes in has to be markup a browser already understands on its own
 * — an `<img>` for a picture, an `<a>` for anything else, including a page, exactly the same
 * image-vs-link distinction that component's own comment draws.
 */
function insertAssetClb(opts) {
  let content = ''
  switch (opts.type) {
    case 'asset': {
      const isImage = opts.mimeType?.startsWith('image/')
      const path = assetPath(opts.folderPath, opts.fileName)
      content = isImage
        ? `<img src="${path}" alt="${opts.title}">`
        : `<a href="${path}">${opts.title}</a>`
      break
    }
    case 'page': {
      const pagePath = opts.folderPath ? `${opts.folderPath}/${opts.fileName}` : opts.fileName
      content = `<a href="/${pagePath}">${opts.title}</a>`
      break
    }
  }
  if (content) {
    insertAtCursor(content)
  }
}

function insertAtCursor(content) {
  const cursor = editor.getPosition()
  editor.executeEdits('', [
    {
      range: new Range(cursor.lineNumber, cursor.column, cursor.lineNumber, cursor.column),
      text: content,
      forceMoveMarkers: true
    }
  ])
  editor.focus()
}

// MOUNTED

onMounted(() => {
  editorStore.$patch({
    hideSideNav: true
  })

  // -> Same theme `EditorMarkdown.vue` defines, redefined here rather than shared: only one editor
  //    component is ever mounted at a time, so there is nothing to deduplicate against.
  monaco.editor.defineTheme('wikijs', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#070a0d',
      'editor.lineHighlightBackground': '#0d1117',
      'editorLineNumber.foreground': '#546e7a',
      'editorGutter.background': '#0d1117'
    }
  })

  editor = monaco.editor.create(monacoRef.value, {
    automaticLayout: true,
    cursorBlinking: 'blink',
    fontSize: 16,
    formatOnType: true,
    language: 'html',
    lineNumbersMinChars: 4,
    padding: { top: 10, bottom: 10 },
    scrollBeyondLastLine: false,
    tabSize: 2,
    theme: 'wikijs',
    value: pageStore.content,
    wordWrap: 'on'
  })

  // -> Handle content change: the raw source goes to both `content` and `render` -- see the component
  //    doc comment for why there is no rendering step in between.
  editor.onDidChangeModelContent(
    debounce(() => {
      editorStore.$patch({
        lastChangeTimestamp: Temporal.Now.instant()
      })
      const value = editor.getValue()
      pageStore.$patch({
        content: value,
        render: value,
        // -> What the author has typed IS the source, whatever the load did or did not deliver; see
        //    the guard in `pageSave`
        contentLoaded: true
      })
    }, 500)
  )

  editor.focus()

  EVENT_BUS.on('insertAsset', insertAssetClb)
})

onBeforeUnmount(() => {
  EVENT_BUS.off('insertAsset', insertAssetClb)
  if (editor) {
    editor.dispose()
  }
})
</script>

<style lang="scss">
@use 'sass:color';

$editor-height: calc(100vh - 64px - 96px);

.editor-code {
  &-main {
    display: flex;
    width: 100%;
  }
  &-editor {
    background-color: $dark-6;
    flex: 1 1 auto;
    display: block;
    height: $editor-height;
    position: relative;
    min-width: 0;

    > div {
      height: 100%;
    }
  }
  &-type {
    writing-mode: vertical-rl;
    text-orientation: mixed;
    padding-bottom: 1rem;
    color: rgba(255, 255, 255, 0.4);
    font-weight: 500;
  }
  &-sidebar {
    background-color: $dark-4;
    border-top: 32px solid color.adjust($primary, $lightness: -10%);
    color: #fff;
    width: 56px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    padding: 12px 0;
  }
}
</style>
