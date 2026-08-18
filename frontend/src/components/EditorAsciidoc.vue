<template>
  <div class="editor-asciidoc">
    <div class="editor-asciidoc-main">
      <div class="editor-asciidoc-sidebar">
        <!-- ------------------------------------------------------- -->
        <!-- SIDE TOOLBAR -->
        <!-- ------------------------------------------------------- -->
        <!-- -> Straight to the File Manager, the same affordance `EditorCode.vue`/`EditorMarkdown.vue`
                expose: see the note on `EditorMarkdown.vue`'s own `insertAssets` for why there is no
                separate URL/clipboard source. -->
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
        <span class="editor-asciidoc-type">ADOC</span>
      </div>
      <!-- ------------------------------------------------------- -->
      <!-- MONACO EDITOR -->
      <!-- ------------------------------------------------------- -->
      <!--
        No preview pane: rendering AsciiDoc to HTML (2.5.x did it client-side via Asciidoctor.js) is a
        materially larger lift deliberately deferred to a later Feature -- see the component doc
        comment below. Until then this editor only edits and stores the raw source.
      -->
      <div class="editor-asciidoc-editor"><div ref="monacoRef" /></div>
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
 * The `asciidoc` editor: a minimal, real editor for raw AsciiDoc source -- deliberately scoped down
 * from 2.5.x's `editor-asciidoc.vue` (CodeMirror + `codemirror-asciidoc` mode, a live preview pane
 * rendered client-side through Asciidoctor.js, DOMPurify-sanitized, debounced at 600ms).
 *
 * That preview pipeline is a materially larger lift than the other editors in this Feature and is
 * deliberately deferred to a later one (server-side rendering, or a follow-up client library
 * integration) -- see task 491. Until then this component matches `EditorCode.vue`'s "no-frills bar":
 * no preview, no formatting toolbar, just a single Monaco pane. On every change both
 * `pageStore.content` and `pageStore.render` are set to the same raw AsciiDoc string, and `pageSave`
 * sends both up unchanged (`stores/page.js`) -- so a page opened before real AsciiDoc rendering ships
 * will show its literal source, not a blank pane or an error. That is the accepted, honestly-labelled
 * cost of shipping the editor ahead of the renderer; `AdminEditors.vue`'s asciidoc row description
 * says so explicitly.
 *
 * Monaco has no built-in AsciiDoc grammar (unlike `html` for `EditorCode.vue` or the markdown mode
 * `EditorMarkdown.vue` uses), so this reuses the same Monaco boot/setup pattern in plain-text
 * language mode rather than shipping a third syntax highlighter alongside CodeMirror's
 * `codemirror-asciidoc` this fork does not otherwise depend on.
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
 * What the file manager handed back, as AsciiDoc block macro syntax at the cursor.
 *
 * `EditorMarkdown.vue`'s `insertAssetClb` writes markdown syntax for the same event, `EditorCode.vue`'s
 * writes raw HTML tags; this editor's source is AsciiDoc, so what goes in is AsciiDoc's own image/link
 * syntax.
 */
function insertAssetClb(opts) {
  let content = ''
  switch (opts.type) {
    case 'asset': {
      const isImage = opts.mimeType?.startsWith('image/')
      const path = assetPath(opts.folderPath, opts.fileName)
      content = isImage ? `image::${path}[${opts.title}]` : `link:${path}[${opts.title}]`
      break
    }
    case 'page': {
      const pagePath = opts.folderPath ? `${opts.folderPath}/${opts.fileName}` : opts.fileName
      content = `link:/${pagePath}[${opts.title}]`
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

  // -> Same theme `EditorMarkdown.vue`/`EditorCode.vue` define, redefined here rather than shared: only
  //    one editor component is ever mounted at a time, so there is nothing to deduplicate against.
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
    formatOnType: false,
    language: 'plaintext',
    lineNumbersMinChars: 4,
    padding: { top: 10, bottom: 10 },
    scrollBeyondLastLine: false,
    tabSize: 2,
    theme: 'wikijs',
    value: pageStore.content,
    wordWrap: 'on'
  })

  // -> Handle content change: the raw source goes to both `content` and `render` -- see the component
  //    doc comment for why there is no rendering step in between yet.
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

.editor-asciidoc {
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
