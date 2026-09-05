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
        <span class="editor-asciidoc-type">ADOC</span>
      </div>
      <!-- ------------------------------------------------------- -->
      <!-- MONACO EDITOR -->
      <!-- ------------------------------------------------------- -->
      <!--
        No preview PANE -- the rendered HTML is computed on every change (see the component doc
        comment below) but only stored, never shown split-view alongside the source. That visual
        affordance is the part still deferred, matching `EditorCode.vue`'s no-frills bar.
      -->
      <div class="editor-asciidoc-editor"><div ref="monacoRef" /></div>
    </div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { apiErrorMessage } from '@/helpers/apiError'
import { assetPath } from '@/helpers/assets'
import { directionalAnchor } from '@/helpers/directionalAnchor'
import { notify } from '@/composables/notify'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { debounce } from 'es-toolkit/function'
import * as monaco from 'monaco-editor'
import { Range } from 'monaco-editor'

import { AsciidocRenderer } from '@/renderers/asciidoc'

/**
 * The `asciidoc` editor: a minimal, real editor for raw AsciiDoc source -- deliberately scoped down
 * from 2.5.x's `editor-asciidoc.vue` (CodeMirror + `codemirror-asciidoc` mode, a live preview PANE
 * rendered client-side through Asciidoctor.js, DOMPurify-sanitized, debounced at 600ms).
 *
 * That split-view preview PANE is a UI affordance this component still does not have -- see the
 * template comment above the Monaco pane -- but the rendering it would have shown is real: on every
 * change, `AsciidocRenderer.render` (`renderers/asciidoc.js`) converts the source to HTML and that is
 * what lands in `pageStore.render`, the same field `EditorMarkdown.vue`'s own `md.render` feeds.
 * `pageSave` (`stores/page.js`) sends `content` and `render` up together; the server sanitizes
 * whichever HTML it receives the same way regardless of which editor produced it
 * (`models/rendering.ts`'s `postProcess`), so a saved AsciiDoc page displays like any other.
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
/**
 * The `debounce()`-wrapped content-change handler, kept only so `onBeforeUnmount` can `cancel()` it.
 * Without this, a debounced call still pending when the component unmounts fires ~500ms later,
 * reading `editor.getValue()` off the already-`dispose()`d editor and potentially patching
 * `pageStore.content` after the session has ended (the #808 bug class; see `EditorMarkdown.vue`'s
 * matching comment) (OpenProject #943).
 */
let debouncedContentChange = null
const monacoRef = ref(null)
const renderer = new AsciidocRenderer()

/*
 * OpenProject #834 (discussion #1738's editor-toolbar-mirroring gap, not caught by task 721/727's
 * pass since it only audited `EditorMarkdown.vue`): the side toolbar's single tooltip popped OUTWARD
 * toward the fixed physical `right`, same bug `EditorMarkdown.vue`'s own `sideToolbarTooltip` fixes --
 * see that component's comment for the full explanation. Read once at setup for the same reason: a
 * mid-edit locale switch is not a case this editor has to survive gracefully.
 */
const sideToolbarTooltip = directionalAnchor(
  document.documentElement.dir,
  'center right',
  'center left'
)
const sideToolbarTooltipAnchor = sideToolbarTooltip.anchor
const sideToolbarTooltipSelf = sideToolbarTooltip.self

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

/**
 * Convert the source and store the result -- see `EditorMarkdown.vue`'s matching `processContent`.
 *
 * A render that throws must not become a render that is empty: `pageSave` sends whatever is in the
 * store, and the server replaces the stored HTML with it, so patching a failed render in blanks the
 * published page where patching nothing keeps the last good one.
 */
async function processContent(newContent) {
  let html
  try {
    html = await renderer.render(newContent, { pagePath: pageStore.path })
  } catch (err) {
    console.error(err)
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
 * Copy the editor's current text into the store right now, rather than on the usual 500ms debounce.
 *
 * Shared by the change handler below, on every debounced edit, and by `editorStore.contentFlusher`,
 * which `pageSave()` awaits before it reads `content`/`render` -- see the call site in `stores/page.js`
 * for why a save can otherwise land inside that debounce window. Async, unlike `EditorMarkdown.vue`'s
 * own `flushEditorContent`: Asciidoctor's `convert` is asynchronous (`renderers/asciidoc.js`), so there
 * is no synchronous render to flush here. Deliberately leaves `contentLoaded`/`lastChangeTimestamp`
 * alone -- those describe an actual edit having happened, which a save that runs this on a page nobody
 * has touched since it loaded would wrongly claim; `pageSave()`'s own guard is what that would defeat.
 */
async function flushEditorContent() {
  const value = editor.getValue()
  pageStore.content = value
  await processContent(value)
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

  // -> Handle content change
  debouncedContentChange = debounce(() => {
    editorStore.markDirty()
    // -> What the author has typed IS the source, whatever the load did or did not deliver; see
    //    the guard in `pageSave`
    pageStore.contentLoaded = true
    flushEditorContent()
  }, 500)
  editor.onDidChangeModelContent(debouncedContentChange)

  editor.focus()

  EVENT_BUS.on('insertAsset', insertAssetClb)

  // -> See `flushEditorContent` and `pageSave()` in `stores/page.js` for why this exists
  editorStore.contentFlusher = flushEditorContent
})

onBeforeUnmount(() => {
  EVENT_BUS.off('insertAsset', insertAssetClb)
  // -> A pending debounced call left uncancelled fires ~500ms after unmount, against an editor that
  //    `dispose()` (below) has already torn down (OpenProject #943, the #808 bug class).
  debouncedContentChange?.cancel()
  if (editor) {
    editor.dispose()
  }
  if (editorStore.contentFlusher === flushEditorContent) {
    editorStore.contentFlusher = null
  }
})
</script>

<style lang="scss">
@use 'sass:color';

.editor-asciidoc {
  /*
    Percentage heights all the way down rather than a viewport calc, which had to grow a new
    hardcoded term every time a bar was added or resized above it -- most recently the breadcrumb bar
    staying mounted through editing (OpenProject #813). `Index.vue`'s `.page-container` already hands
    its row a definite height via `items-stretch`, which is what lets the reading column's own scroll
    area just say `height: 100%` -- this is the editor doing the same thing instead of restating it.
    See `EditorMarkdown.vue`'s matching comment for the fuller version.
  */
  height: 100%;
  min-height: 0;

  &-main {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
  }
  &-editor {
    background-color: $dark-6;
    flex: 1 1 auto;
    display: block;
    height: 100%;
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
