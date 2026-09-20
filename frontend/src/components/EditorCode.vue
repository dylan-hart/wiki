<template>
  <div class="editor-code">
    <div class="editor-code-main">
      <div class="editor-code-sidebar">
        <w-btn
          icon="tabler:photo-plus"
          padding="sm sm"
          flat
          :aria-label="t('editor.markup.insertAssets')"
          @click="insertAssets">
          <w-tooltip :anchor="sideToolbarTooltipAnchor" :self="sideToolbarTooltipSelf">{{
            t('editor.markup.insertAssets')
          }}</w-tooltip>
        </w-btn>
        <w-space />
        <span class="editor-code-type">HTML</span>
      </div>
      <div class="editor-code-editor"><div ref="monacoRef" /></div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useAesthetic } from '@/composables/aesthetic'
import { defineMonacoThemes, monacoThemeName } from '@/helpers/monacoTheme'
import { assetPath } from '@/helpers/assets'
import { directionalAnchor } from '@/helpers/directionalAnchor'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { debounce } from 'es-toolkit/function'
import * as monaco from 'monaco-editor'
import { Range } from 'monaco-editor'

/**
 * Raw HTML source with nothing between it and what gets stored: what the author types IS the render,
 * so both `pageStore.content` and `pageStore.render` are set to the same string and `pageSave` sends
 * both up unchanged. The server's own `sanitizeHtml` pass (`models/rendering.ts`'s `postProcess`) is
 * what stands between this and a stored page, so nothing here sanitizes or transforms what is typed.
 *
 * No preview pane: a preview could only ever show the author what they are already looking at.
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

/**
 * Registered as `editorStore.contentFlusher` so `pageSave()` can close the debounce window: without
 * it, typing then immediately saving within those 500ms stores the page without the last edits.
 */
function flushEditorContent() {
  const value = editor.getValue()
  pageStore.$patch({
    content: value,
    render: value,
    contentLoaded: true
  })
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
    formatOnType: true,
    language: 'html',
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
  // -> Only if it is still this instance's: a second mount's registration must survive the first's
  //    unmount, in whatever order the two settle.
  if (editorStore.contentFlusher === flushEditorContent) {
    editorStore.contentFlusher = null
  }
  debouncedContentChange?.cancel()
  if (editor) {
    editor.dispose()
  }
})
</script>

<style>
.editor-code {
  /*
    Percentage heights all the way down rather than a viewport calc, which needed a new hardcoded
    term every time a bar was added or resized above it. `Index.vue`'s `.page-container` already
    hands its row a definite height via `items-stretch`, so this only has to say `height: 100%`.
  */
  height: 100%;
  min-height: 0;
}
.editor-code-main {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.editor-code-editor {
  background-color: var(--color-dark-6);
  flex: 1 1 auto;
  display: block;
  height: 100%;
  position: relative;
  min-width: 0;
}
.editor-code-editor > div {
  height: 100%;
}
.editor-code-type {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  padding-bottom: 1rem;
  color: rgba(255, 255, 255, 0.4);
  font-weight: 500;
}
.editor-code-sidebar {
  background-color: var(--color-dark-4);
  border-top: 32px solid color-mix(in srgb, var(--color-primary) 80%, #000);
  color: #fff;
  width: 56px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
  padding: 12px 0;
}
</style>
