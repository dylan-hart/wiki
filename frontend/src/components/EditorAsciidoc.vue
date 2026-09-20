<template>
  <div class="editor-asciidoc">
    <div class="editor-asciidoc-main">
      <div class="editor-asciidoc-sidebar">
        <w-btn
          class="flush-hover-btn flush-hover-btn--square"
          icon="tabler:photo-plus"
          flat
          :aria-label="t('editor.markup.insertAssets')"
          @click="insertAssets">
          <w-tooltip :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertAssets')
          }}</w-tooltip>
        </w-btn>
        <w-space />
        <span class="editor-asciidoc-type">ADOC</span>
      </div>
      <div class="editor-asciidoc-editor"><div ref="monacoRef" /></div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useAesthetic } from '@/composables/aesthetic'
import { defineMonacoThemes, monacoThemeName } from '@/helpers/monacoTheme'
import { apiErrorMessage } from '@/helpers/apiError'
import { assetPath } from '@/helpers/assets'
import { directionalAnchor } from '@/helpers/directionalAnchor'
import { log } from '@/helpers/log'
import { notify } from '@/composables/notify'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { debounce } from 'es-toolkit/function'
import * as monaco from 'monaco-editor'
import { Range } from 'monaco-editor'

import { AsciidocRenderer } from '@/renderers/asciidoc'

/**
 * Raw AsciiDoc source with no preview pane. The render is still computed on every change and stored
 * in `pageStore.render`, which `pageSave` sends alongside `content`, so a saved AsciiDoc page
 * displays like any other -- only the split view is missing.
 *
 * Monaco has no AsciiDoc grammar, so the model stays in plain-text language mode rather than
 * pulling in a second syntax highlighter for one editor.
 */

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

const { t } = useI18n()

/*
  Monaco cannot read the design-token layer -- `defineTheme()` takes plain hex, not `var()` -- so the
  aesthetic is applied by registering both themes and switching between them.
*/
const aesthetic = useAesthetic()

let editor
/**
 * Kept only so `onBeforeUnmount` can `cancel()` it: a call still pending at unmount fires ~500ms
 * later, reads `editor.getValue()` off the already-`dispose()`d editor and patches
 * `pageStore.content` after the session has ended.
 */
let debouncedContentChange = null
const monacoRef = ref(null)
const renderer = new AsciidocRenderer()

/*
 * Direction-aware so the side toolbar's tooltip opens inward in RTL rather than toward the fixed
 * physical `right`. Read once at setup: a mid-edit locale switch is not a case this editor has to
 * survive gracefully.
 */
const sideToolbarTooltip = directionalAnchor(
  document.documentElement.dir,
  'center right',
  'center left'
)
const sideToolbarTooltipAnchor = sideToolbarTooltip.anchor
const sideToolbarTooltipSelf = sideToolbarTooltip.self

function insertAssets() {
  siteStore.openFileManager({ insertMode: true })
}

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

/**
 * A render that throws must not become a render that is empty: `pageSave` sends whatever is in the
 * store, and the server replaces the stored HTML with it, so patching a failed render in blanks the
 * published page where patching nothing keeps the last good one.
 */
async function processContent(newContent) {
  let html
  try {
    html = await renderer.render(newContent, { pagePath: pageStore.path })
  } catch (err) {
    log.error('editor', 'could not render the AsciiDoc preview', err)
    notify({
      type: 'negative',
      message: t('editor.renderFailed'),
      caption: apiErrorMessage(err)
    })
    return
  }
  pageStore.$patch({ render: html })
}

/**
 * Bypasses the 500ms debounce, so `pageSave()` can await `editorStore.contentFlusher` rather than
 * read `content`/`render` from inside the debounce window. Deliberately leaves
 * `contentLoaded`/`lastChangeTimestamp` alone -- those say an edit actually happened, which a save
 * on a page nobody has touched would wrongly claim, defeating `pageSave()`'s own guard.
 */
async function flushEditorContent() {
  const value = editor.getValue()
  pageStore.content = value
  await processContent(value)
}

onMounted(() => {
  editorStore.$patch({
    hideSideNav: true
  })

  // -> Redefined per editor rather than shared: only one editor is ever mounted at a time, so there
  //    is nothing to deduplicate against.
  defineMonacoThemes(monaco, {
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
    theme: monacoThemeName(aesthetic.current),
    value: pageStore.content,
    wordWrap: 'on'
  })

  debouncedContentChange = debounce(() => {
    editorStore.markDirty()
    // -> What the author has typed IS the source, whatever the load did or did not deliver.
    pageStore.contentLoaded = true
    flushEditorContent()
  }, 500)
  editor.onDidChangeModelContent(debouncedContentChange)

  editor.focus()

  EVENT_BUS.on('insertAsset', insertAssetClb)

  editorStore.contentFlusher = flushEditorContent
})

onBeforeUnmount(() => {
  EVENT_BUS.off('insertAsset', insertAssetClb)
  debouncedContentChange?.cancel()
  if (editor) {
    editor.dispose()
  }
  if (editorStore.contentFlusher === flushEditorContent) {
    editorStore.contentFlusher = null
  }
})
</script>

<style>
.editor-asciidoc {
  /*
    Percentage heights all the way down rather than a viewport calc, which needed a new hardcoded
    term every time a bar was added or resized above it. `Index.vue`'s `.page-container` already
    hands its row a definite height via `items-stretch`, so this only has to say `height: 100%`.
  */
  height: 100%;
  min-height: 0;
}
.editor-asciidoc-main {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.editor-asciidoc-editor {
  background-color: var(--color-dark-6);
  flex: 1 1 auto;
  display: block;
  height: 100%;
  position: relative;
  min-width: 0;
}
.editor-asciidoc-editor > div {
  height: 100%;
}
.editor-asciidoc-type {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  padding-bottom: 1rem;
  color: rgba(255, 255, 255, 0.4);
  font-weight: 500;
}
.editor-asciidoc-sidebar {
  background-color: var(--color-dark-4);
  border-top: 32px solid color-mix(in srgb, var(--color-primary) 80%, #000);
  color: #fff;
  width: 56px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
  /* No top padding: the button must start where the coloured band ends, so its hover is a cell of
     the rail, not a tile floating in it. The bottom padding clears the vertical type label. */
  padding: 0 0 12px;
}
/* `min-height` needs `!important`: WBtn writes it as an inline style, which beats any class. 56px
   matches the rail's width, so the square the primitive's `aspect-ratio` asks for resolves. */
.editor-asciidoc-sidebar > .w-btn {
  width: 100%;
  min-height: 56px !important;
}
</style>
