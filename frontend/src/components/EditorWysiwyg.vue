<template>
  <div class="wysiwyg-container">
    <div class="wysiwyg-toolbar" v-if="editor">
      <template v-for="menuItem of menuBar">
        <w-separator class="mx-1" v-if="menuItem.type === `divider`" vertical />
        <w-btn
          v-else-if="menuItem.type === `dropdown`"
          :key="`ddn-` + menuItem.key"
          flat
          class="flush-hover-btn flush-hover-btn--square"
          :icon="menuItem.icon"
          :class="{ 'is-active': menuItem.isActive && menuItem.isActive() }"
          :color="menuItem.isActive && menuItem.isActive() ? `primary` : inactiveIconColor"
          :aria-label="menuItem.title"
          :disabled="menuItem.disabled && menuItem.disabled()">
          <w-menu>
            <w-list dense padding>
              <template v-for="child of menuItem.children">
                <w-separator class="my-2" v-if="child.type === `divider`" />
                <w-item
                  v-else
                  :key="child.key"
                  clickable
                  @click="child.action"
                  :active="child.isActive && child.isActive()"
                  active-class="text-primary"
                  :disabled="child.disabled && child.disabled()">
                  <w-item-section side>
                    <w-icon :name="child.icon" :color="child.color" />
                  </w-item-section>
                  <w-item-section
                    ><w-item-label>{{ child.title }}</w-item-label></w-item-section
                  >
                </w-item>
              </template>
            </w-list>
          </w-menu>
        </w-btn>
        <w-btn-group v-else-if="menuItem.type === `btngroup`" :key="`btngrp-` + menuItem.key">
          <w-btn
            v-for="child of menuItem.children"
            :key="child.key"
            flat
            class="flush-hover-btn flush-hover-btn--square"
            :icon="child.icon"
            :class="{ 'is-active': child.isActive && child.isActive() }"
            :color="child.isActive && child.isActive() ? `primary` : inactiveIconColor"
            @click="child.action"
            :aria-label="child.title"
            :disabled="menuItem.disabled && menuItem.disabled()" />
        </w-btn-group>
        <w-btn
          v-else
          :key="`btn-` + menuItem.key"
          flat
          class="flush-hover-btn flush-hover-btn--square"
          :icon="menuItem.icon"
          :class="{ 'is-active': menuItem.isActive && menuItem.isActive() }"
          :color="menuItem.isActive && menuItem.isActive() ? `primary` : inactiveIconColor"
          @click="menuItem.action"
          :aria-label="menuItem.title"
          :disabled="menuItem.disabled && menuItem.disabled()" />
      </template>
    </div>
    <editor-content :editor="editor" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  bindCollabEditor,
  claimWysiwygSeed,
  collabStatusEffects,
  collabUserColor,
  startCollabSession,
  stopCollabSession
} from '@/composables/collab'
import { dialog } from '@/composables/dialog'
import { useDark } from '@/composables/dark'
import { notify } from '@/composables/notify'

import { assetPath } from '@/helpers/assets'
import {
  hasFiles,
  pastedFiles,
  shouldAcceptDrag,
  shouldClaimPaste
} from '@/helpers/editorFileTransfer'
import { createPageMentionSuggestion } from '@/helpers/editorMentions'
import { buildMenuBar } from '@/helpers/wysiwygMenuBar'
import {
  withStyleSpanMarkdown,
  withStyleSpanRenderMarkdown,
  withTextAlignMarkdown
} from '@/helpers/wysiwygStyleAttrs'

import { createBlockLoader, WhiteboardInsert, WikiBlock } from '@/editor/wysiwyg'

import LinkPickerDialog from '@/components/LinkPickerDialog.vue'

import { useCollabStore } from '@/stores/collab'
import { useCommonStore } from '@/stores/common'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { useEditor, EditorContent, Editor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Color } from '@tiptap/extension-color'
import FontFamily from '@tiptap/extension-font-family'
import { Heading } from '@tiptap/extension-heading'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { Markdown } from '@tiptap/markdown'
import Mention from '@tiptap/extension-mention'
import { Paragraph } from '@tiptap/extension-paragraph'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import Typography from '@tiptap/extension-typography'
import { common, createLowlight } from 'lowlight'

import {
  GithubAlert,
  FootnoteReference,
  FootnoteDefinition,
  TexMath,
  IconShortcode,
  GlossaryTermHighlight,
  WHITEBOARD_LANGUAGE
} from '@/editor/wysiwyg'

const lowlight = createLowlight(common)
lowlight.registerAlias({ plaintext: [WHITEBOARD_LANGUAGE] })

const collabStore = useCollabStore()
const commonStore = useCommonStore()
const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()
const dark = useDark()

const { t } = useI18n()

const props = defineProps({
  content: {
    type: String,
    default: null
  },
  uploadFile: {
    type: Function,
    default: null
  },
  autofocus: {
    type: Boolean,
    default: false
  },
  /** Note mode only: refuses typing while the parent is busy with the note, e.g. promoting it. */
  readonly: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:content'])

const noteMode = props.content !== null

let lastEmittedContent = props.content

/**
 * Neither tone is a theme-aware token, so the pair has to be picked per theme by hand: `grey-10`
 * (near-black) is all but invisible against the dark toolbar background below.
 */
const inactiveIconColor = computed(() => (dark.isActive ? 'grey-6' : 'grey-10'))

/** Kept identical to `EditorMarkdown.vue`'s own `collabEnabled`. */
const collabEnabled = computed(
  () =>
    !noteMode &&
    siteStore.features.collaborativeEditing &&
    userStore.authenticated &&
    editorStore.mode === 'edit' &&
    Boolean(pageStore.id)
)

let editor = null
/**
 * Both watchers start inside a callback, which Vue does not bind to this component's effect scope
 * the way it does a top-level `watch()`, so they have to be stopped by hand: left running past
 * unmount they fire against a disposed editor and duplicate "saved by X" on a later mount.
 */
let stopCollabStatusWatch = null
let stopCollabLastSaveWatch = null

/**
 * Any CSS color works -- `setColor()`'s argument lands on the `textStyle` mark verbatim. These are
 * picked for legibility on white, deliberately not `composables/collab.js`'s `USER_COLORS`, which
 * are chosen to stay distinguishable from each other as cursors.
 */
const TEXT_COLORS = {
  blue: '#1976D2',
  brown: '#795548',
  green: '#388E3C',
  orange: '#F57C00',
  pink: '#C2185B',
  purple: '#7B1FA2',
  red: '#D32F2F',
  teal: '#00796B',
  yellow: '#F9A825'
}

/**
 * Lighter tints than `TEXT_COLORS` on purpose: these are painted as a mark's *background*, and have
 * to sit behind text without swallowing it.
 */
const HIGHLIGHT_COLORS = {
  blue: '#90CAF9',
  green: '#A5D6A7',
  orange: '#FFCC80',
  pink: '#F48FB1',
  yellow: '#FFF59D'
}

/*
  The editor goes in as a getter because it is still null here -- `init()` assigns it on mount. And
  this is a `computed()` rather than a one-time `const` so a live locale switch (navigating across a
  locale-routed site without remounting) rebuilds every menu item's translated `title`.
*/
const menuBar = computed(() =>
  buildMenuBar(() => editor, {
    TEXT_COLORS,
    HIGHLIGHT_COLORS,
    insertLink: () => insertLink(),
    openFileManager: (opts) => (noteMode ? pickNoteFiles() : siteStore.openFileManager(opts)),
    insertBlock: () => insertBlock(),
    insertWhiteboard: () => insertWhiteboard(),
    t
  })
)

/**
 * Shared so the interim editor `init()` builds and the collaborative one `swapToCollabEditor()`
 * builds differ in nothing but the `undoRedo`/`Collaboration`/`CollaborationCaret` entries.
 */
function buildExtensions(collab) {
  return [
    StarterKit.configure({
      codeBlock: false,
      // -> The next four are each registered explicitly below instead, as a configured or wrapped
      //    variant. Leaving them on here too registers the node twice and emits a
      //    `[tiptap warn]: Duplicate extension names found` on every mount.
      link: false,
      // -> `GithubAlert` extends the stock `blockquote` node in place, adding an optional
      //    `kind`/`title` pair rather than declaring a second node under the same name.
      blockquote: false,
      // -> `withTextAlignMarkdown()`-wrapped: `textAlign` is a node attribute of these two, not a
      //    mark, so it needs its own markdown round-trip on the node types themselves.
      paragraph: false,
      heading: false,
      // -> `Collaboration`'s own Yjs-backed undo/redo replaces this once a session is bound --
      //    keeping both registered warns, and only one of the two `undo`/`redo` definitions wins.
      undoRedo: collab ? false : { depth: 500 }
    }),
    CodeBlockLowlight.configure({
      lowlight
    }),
    withTextAlignMarkdown(Paragraph),
    withTextAlignMarkdown(Heading),
    Color,
    FootnoteReference,
    FootnoteDefinition,
    GithubAlert,
    GlossaryTermHighlight.configure({
      terms: editorStore.editors.markdown?.glossaryTerms ?? []
    }),
    IconShortcode,
    TexMath,
    FontFamily,
    withStyleSpanRenderMarkdown(Highlight).configure({
      multicolor: true
    }),
    Image,
    Link.configure({
      // -> Otherwise clicking linked text navigates the browser away instead of placing the cursor.
      openOnClick: false,
      // -> `insertFilesAsAssets` links a pending asset's `blob:` URL until its upload lands, and
      //    Link's default `isAllowedUri` allowlist would silently refuse that `setLink()`.
      protocols: ['blob']
    }),
    Mention.configure({
      suggestion: createPageMentionSuggestion(siteStore)
    }),
    Placeholder.configure({
      placeholder: 'Enter some content here...'
    }),
    Table.configure({
      resizable: true
    }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem,
    // -> `types` defaults to `[]`, which makes every `setTextAlign()` a silent no-op.
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    withStyleSpanMarkdown(TextStyle),
    Typography,
    WikiBlock.configure({ loadBlock: createBlockLoader(commonStore, siteStore) }),
    WhiteboardInsert.configure({ onRefuse: refuseWhiteboard }),
    Markdown,
    ...(collab
      ? [
          Collaboration.configure({ fragment: collab.fragment }),
          CollaborationCaret.configure({
            provider: { awareness: collab.awareness },
            user: collab.user
          })
        ]
      : [])
  ]
}

function handleEditorUpdate({ editor }) {
  if (noteMode) {
    lastEmittedContent = editor.getMarkdown()
    emit('update:content', lastEmittedContent)
    return
  }
  editorStore.markDirty()
  pageStore.$patch({
    content: editor.getMarkdown(),
    // -> What the author has typed IS the source, whatever the load did or did not deliver; see
    //    the guard in `pageSave`
    contentLoaded: true,
    render: editor.getHTML()
  })
}

/**
 * A legacy row holds serialized Tiptap JSON under `content` rather than markdown. The heuristic is
 * duplicated in `backend/helpers/wysiwygHeadlessMarkdown.ts#isLegacyWysiwygJson` and kept in sync by
 * hand -- the two workspaces install separately and share no code.
 */
function isLegacyWysiwygJson(content) {
  return typeof content === 'string' && content.trimStart().startsWith('{')
}

function init() {
  if (noteMode) {
    editor = useEditor({
      content: props.content,
      contentType: 'markdown',
      editable: !props.readonly,
      autofocus: props.autofocus ? 'end' : false,
      extensions: buildExtensions(null),
      editorProps: buildEditorProps(),
      onUpdate: handleEditorUpdate
    })
    return
  }

  editorStore.$patch({
    hideSideNav: false
  })

  /*
    A legacy row loads as `contentType: 'json'`; handing it to the markdown parser instead would
    show the raw `{"type":"doc",…}` source as the page's content. Malformed JSON falls through to
    the markdown path -- it was never going to render either way, and this keeps `useEditor()` from
    throwing on a page that at least used to open.

    Either path, saving writes real markdown into `content`, and `backend/models/pages.ts`'s
    `isLegacyWysiwygConversionSave` check flips `contentType` to `markdown` on that save.
  */
  let content = pageStore.content
  let contentType = 'markdown'
  if (isLegacyWysiwygJson(pageStore.content)) {
    try {
      content = JSON.parse(pageStore.content)
      contentType = 'json'
    } catch {
      // -> Not JSON after all; `content`/`contentType` already hold the markdown path.
    }
  }

  // -> Read-only when a collab session is about to start: `swapToCollabEditor()` replaces this
  //    instance outright once that session has synced.
  editor = useEditor({
    content,
    contentType,
    editable: !collabEnabled.value,
    extensions: buildExtensions(null),
    editorProps: buildEditorProps(),
    onUpdate: handleEditorUpdate
  })
}

/**
 * The whole editor is replaced rather than bound, because TipTap's `Collaboration` extension can
 * only be attached at construction -- `Editor#registerPlugin` takes a raw ProseMirror plugin after
 * the fact, but not a packaged Extension. It cannot simply be attached to the editor `init()` builds
 * either: `y-tiptap`'s sync plugin overwrites the editor's content with whatever the shared document
 * holds the instant it mounts, so constructing before sync would blank the page's just-loaded
 * content. Hence the interim editor stays the only one until this runs, once, post-sync.
 *
 * `ytext` is the session's flat-text field, sized for Monaco's markdown source and unusable here --
 * TipTap's collaboration is a tree CRDT. This editor takes its own root type off the *same* shared
 * `Y.Doc` (`ytext.doc`): same room, same participants, independent content type.
 *
 * The caller deliberately does not return this promise: `bindCollabEditor` would mistake it for the
 * teardown object it expects back from its factory.
 */
async function swapToCollabEditor(ytext, awareness) {
  const fragment = ytext.doc.getXmlFragment('wysiwygBody')
  /*
    Nobody has written to this field yet -- first opener, or the room emptied out since -- so what
    this editor is showing becomes the room's starting state, mirroring `core/collab.ts`'s
    `buildSeed()` server-side.
  */
  const seedContent = fragment.length === 0 ? editor.value.getJSON() : null
  const previousEditor = editor.value

  editor.value = new Editor({
    editable: true,
    extensions: buildExtensions({
      fragment,
      awareness,
      user: {
        id: userStore.id,
        name: userStore.name,
        hasAvatar: userStore.hasAvatar,
        avatarProviderUrl: userStore.avatarProviderUrl,
        color: collabUserColor(userStore.id)
      }
    }),
    editorProps: buildEditorProps(),
    onUpdate: handleEditorUpdate
  })
  previousEditor.destroy()

  if (!seedContent) {
    return
  }

  /*
    `fragment.length === 0` above only proves nobody had written to THIS client's copy yet, so two
    people opening a brand new room at the same instant would both seed and duplicate the content
    once the replicas merged. `claimWysiwygSeed` grants at most one caller cluster-wide (only a
    boolean crosses that call). `fragment.length` is re-checked after the round trip in case a
    peer's seed or a draft restore landed while this was in flight.
  */
  const granted = await claimWysiwygSeed({ siteId: siteStore.id, pageId: pageStore.id })
  if (granted && fragment.length === 0) {
    // -> `emitUpdate: false`: `pageStore` already has this from the interim editor, and `y-tiptap`'s
    //    sync plugin observes the dispatched transaction regardless of the event this flag gates.
    editor.value.commands.setContent(seedContent, { emitUpdate: false })
  }
}

function insertLink() {
  const { from, to, empty } = editor.value.state.selection
  dialog({ component: LinkPickerDialog }).onOk(({ href, openInNewTab, title }) => {
    const target = openInNewTab ? '_blank' : null
    if (empty) {
      const label = title || href
      editor.value
        .chain()
        .focus()
        .insertContentAt(from, label)
        .setTextSelection({ from, to: from + label.length })
        .extendMarkRange('link')
        .setLink({ href, target })
        .run()
    } else {
      editor.value
        .chain()
        .focus()
        .setTextSelection({ from, to })
        .extendMarkRange('link')
        .setLink({ href, target })
        .run()
    }
  })
}

function insertBlock() {
  siteStore.$patch({
    overlay: 'BlockPicker'
  })
}

const WHITEBOARD_REFUSAL_KEYS = {
  blockBytes: 'editor.whiteboard.blockTooLarge',
  strokes: 'editor.whiteboard.blockTooLarge',
  points: 'editor.whiteboard.blockTooLarge',
  invalid: 'editor.whiteboard.invalidBody',
  pageBytes: 'editor.whiteboard.pageTooLarge',
  pageBytesInsert: 'editor.whiteboard.pageFull'
}

function refuseWhiteboard(reason) {
  notify({
    type: 'warning',
    message: t(WHITEBOARD_REFUSAL_KEYS[reason] ?? WHITEBOARD_REFUSAL_KEYS.blockBytes)
  })
}

function insertWhiteboard() {
  editor.value.chain().focus().insertWhiteboard().run()
}

/**
 * Unlike `EditorMarkdown.vue`'s counterpart, no blank-line padding around the insertion point is
 * needed: ProseMirror's schema places a block-level node at a valid position on its own, splitting
 * the surrounding paragraph if the cursor was inside one.
 */
function insertBlockClb(markdown) {
  editor.value.chain().focus().insertContent(markdown, { contentType: 'markdown' }).run()
}

function insertAssetClb(opts) {
  const isImage = opts.type === 'asset' && opts.mimeType?.startsWith('image/')
  if (isImage) {
    editor.value
      .chain()
      .focus()
      .setImage({ src: assetPath(opts.folderPath, opts.fileName), alt: opts.title })
      .run()
    return
  }
  const href =
    opts.type === 'page'
      ? `/${opts.folderPath ? `${opts.folderPath}/${opts.fileName}` : opts.fileName}`
      : assetPath(opts.folderPath, opts.fileName)
  const { from, to, empty } = editor.value.state.selection
  if (empty) {
    editor.value
      .chain()
      .focus()
      .insertContentAt(from, opts.title)
      .setTextSelection({ from, to: from + opts.title.length })
      .extendMarkRange('link')
      .setLink({ href })
      .run()
  } else {
    editor.value
      .chain()
      .focus()
      .setTextSelection({ from, to })
      .extendMarkRange('link')
      .setLink({ href })
      .run()
  }
}

/**
 * On a page, nothing is uploaded here: each file becomes a pending asset held against a `blob:`
 * URL, and `UploadPendingAssetsDialog` sends it on save and reports back where it landed --
 * `reloadEditorContent` below is this editor's half of applying that. A note (the `content` prop)
 * has no save step to defer to, so `insertFilesAsNoteUploads` uploads each file at once and
 * inserts only the URL it gets back; a `blob:` URL would otherwise be autosaved into the note.
 *
 * `generateUniqueName` is for the paste path only; see `addPendingAsset` for why a drop's own
 * filename is kept and a clipboard paste's is not.
 */
function refuseFilesWhenSuggesting() {
  if (noteMode || editorStore.mode !== 'suggest') {
    return false
  }
  notify({
    type: 'warning',
    message: t('editor.pendingAssetsSuggestRefused')
  })
  return true
}

function insertFilesAsAssets(files, { generateUniqueName = false, position = null } = {}) {
  if (noteMode) {
    insertFilesAsNoteUploads(files, { position })
    return
  }
  if (position != null) {
    editor.value.chain().focus().setTextSelection(position).run()
  }
  for (const file of files) {
    const blobUrl = editorStore.addPendingAsset(file, { generateUniqueName })
    if (file.type.startsWith('image/')) {
      editor.value.chain().focus().setImage({ src: blobUrl, alt: file.name }).run()
      continue
    }
    const { from } = editor.value.state.selection
    editor.value
      .chain()
      .focus()
      .insertContentAt(from, file.name)
      .setTextSelection({ from, to: from + file.name.length })
      .extendMarkRange('link')
      .setLink({ href: blobUrl })
      .run()
  }
}

async function insertFilesAsNoteUploads(files, { position = null } = {}) {
  if (position != null) {
    editor.value.chain().focus().setTextSelection(position).run()
  }
  for (const file of files) {
    const uploaded = await Promise.resolve(props.uploadFile?.(file)).catch(() => null)
    if (!uploaded?.url || !editor.value || editor.value.isDestroyed) {
      continue
    }
    const name = uploaded.name || file.name
    if (file.type.startsWith('image/')) {
      editor.value.chain().focus().setImage({ src: uploaded.url, alt: name }).run()
      continue
    }
    const { from } = editor.value.state.selection
    editor.value
      .chain()
      .focus()
      .insertContentAt(from, name)
      .setTextSelection({ from, to: from + name.length })
      .extendMarkRange('link')
      .setLink({ href: uploaded.url })
      .run()
  }
}

function pickNoteFiles() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? [])
    if (files.length > 0) {
      insertFilesAsNoteUploads(files)
    }
  })
  input.click()
}

/*
  Returning `false` is a genuine decline: ProseMirror falls through to its own paste handling (and
  TipTap's HTML-to-document parsing) for anything not claimed. `shouldClaimPaste` is what keeps text
  winning when an image rides alongside it on the clipboard.
*/
function handlePaste(view, event) {
  if (!shouldClaimPaste(event.clipboardData)) {
    return false
  }
  event.preventDefault()
  if (refuseFilesWhenSuggesting()) {
    return true
  }
  insertFilesAsAssets(pastedFiles(event.clipboardData), { generateUniqueName: true })
  return true
}

/*
  A drop has to be claimed twice: `dragover` is what tells the browser this is a valid target --
  without it there is no drop at all, just the browser navigating away to the file -- and `drop` is
  where it arrives.
*/
function handleDragOver(view, event) {
  if (!shouldAcceptDrag(event.dataTransfer)) {
    return false
  }
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
  return true
}

function handleDrop(view, event) {
  if (!hasFiles(event.dataTransfer)) {
    return false
  }
  event.preventDefault()
  if (refuseFilesWhenSuggesting()) {
    return true
  }
  // -> `posAtCoords` returns `null` when the point is off the document (or, as under test, when
  //    nothing has laid out); `insertFilesAsAssets` falls back to the current selection.
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
  insertFilesAsAssets(pastedFiles(event.dataTransfer), { position: coords?.pos ?? null })
  return true
}

/**
 * A fresh object per call: TipTap does not expect one `editorProps` instance handed to two live
 * editors, and both `init()` and `swapToCollabEditor()` construct one.
 */
function buildEditorProps() {
  return {
    handlePaste,
    handleDrop,
    handleDOMEvents: {
      dragover: handleDragOver
    }
  }
}

/**
 * `pageStore.content` is a one-way write from this editor, never read back in, so the dialog's own
 * `.replaceAll` over it does not reach the live ProseMirror document -- that needs its own rewrite,
 * node by node, once the pending assets' real paths are known.
 *
 * One transaction of attribute-only edits, none of which change a node's size, so every position
 * collected while walking the original `state.doc` stays valid with no incremental remapping.
 */
function reloadEditorContent({ replacements = [] } = {}) {
  if (!editor.value || replacements.length === 0) {
    return
  }
  const { state } = editor.value
  const tr = state.tr
  let changed = false
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'image') {
      const match = replacements.find((r) => r.from === node.attrs.src)
      if (match) {
        tr.setNodeMarkup(pos, null, { ...node.attrs, src: match.to })
        changed = true
      }
    }
    for (const mark of node.marks) {
      if (mark.type.name !== 'link') {
        continue
      }
      const match = replacements.find((r) => r.from === mark.attrs.href)
      if (match) {
        tr.removeMark(pos, pos + node.nodeSize, mark.type)
        tr.addMark(pos, pos + node.nodeSize, mark.type.create({ ...mark.attrs, href: match.to }))
        changed = true
      }
    }
  })
  if (changed) {
    editor.value.view.dispatch(tr)
  }
}

onMounted(() => {
  EVENT_BUS.on('insertAsset', insertAssetClb)
  EVENT_BUS.on('reloadEditorContent', reloadEditorContent)
  EVENT_BUS.on('insertBlock', insertBlockClb)
})

init()

watch(
  () => props.content,
  (content) => {
    if (!noteMode || content === lastEmittedContent || !editor.value) {
      return
    }
    lastEmittedContent = content
    editor.value.commands.setContent(content ?? '', { contentType: 'markdown', emitUpdate: false })
  }
)

watch(
  () => props.readonly,
  (readonly) => {
    if (!noteMode || !editor.value) {
      return
    }
    // -> No update event: the content did not change, and one would schedule a needless save.
    editor.value.setEditable(!readonly, false)
  }
)

// -> Registered after `init()` on purpose: `useEditor()` defers construction to its own mount hook,
//    and Vue runs mount hooks in registration order, so only a later-registered hook sees
//    `editor.value`.
onMounted(() => {
  if (!collabEnabled.value) {
    return
  }

  // -> `activeEditors` came with the page itself, so "someone else has this open" can be said
  //    before the collab session below has even asked to connect.
  if (pageStore.activeEditors.count > 0) {
    notify({
      type: 'info',
      message: t('editor.collab.activeEditors', pageStore.activeEditors.count, {
        count: pageStore.activeEditors.count
      })
    })
  }

  editor.value.setEditable(false)
  startCollabSession({ siteId: siteStore.id, pageId: pageStore.id })

  stopCollabStatusWatch = watch(
    () => collabStore.status,
    (status) => {
      const effects = collabStatusEffects(status, collabStore.hasSynced)
      if (effects.shouldBindEditor) {
        // -> Block body, not a concise arrow: `swapToCollabEditor` is async, and `bindCollabEditor`
        //    treats its factory's return value as a teardown object to `.destroy()` later. This
        //    form deliberately returns nothing.
        bindCollabEditor((ytext, awareness) => {
          swapToCollabEditor(ytext, awareness)
        })
      }
      editor.value.setEditable(!effects.readOnly)
      if (effects.notifyDenied) {
        notify({
          type: 'warning',
          message: t('editor.collab.notAllowed')
        })
      }
    }
  )

  // -> The session has already cleared the pending state; this only tells the author why their Save
  //    button went quiet.
  stopCollabLastSaveWatch = watch(
    () => collabStore.lastSave,
    (lastSave) => {
      if (lastSave && lastSave.authorId !== userStore.id) {
        notify({
          type: 'positive',
          message: t('editor.collab.savedBy', { name: lastSave.authorName })
        })
      }
    }
  )
})

onBeforeUnmount(() => {
  EVENT_BUS.off('insertAsset', insertAssetClb)
  EVENT_BUS.off('reloadEditorContent', reloadEditorContent)
  EVENT_BUS.off('insertBlock', insertBlockClb)
  // -> Before `stopCollabSession()` patches `collabStore.status` to `off`, or they fire past
  //    unmount against a disposed editor.
  stopCollabStatusWatch?.()
  stopCollabLastSaveWatch?.()
  // -> Before the editor goes: leaving the room is what takes this author's avatar out of everyone
  //    else's header.
  if (!noteMode) {
    stopCollabSession()
  }
  editor.value.destroy()
})

// -> Tests only: happy-dom runs no layout, so a suite drives the editor and the menu entries'
//    `action`/`isActive` directly rather than simulating keystrokes and nested menu clicks.
defineExpose({ editor, menuBar })
</script>

<style>
/* Selectors are written flat rather than with native nesting: a `&-suffix` concatenation is a Sass
   idiom the browser silently drops, never matching. */
.wysiwyg-container {
  height: calc(100% - 41px);
}
.wysiwyg-container .wysiwyg-toolbar {
  border: none;
  display: flex;
  align-items: center;
  /*
    No padding, so the first and last button's hover reaches the band's own edge. The height is
    therefore fixed rather than falling out of the buttons plus padding: 41px is what the
    container's `calc(100% - 41px)` above assumes (40px of buttons + the 1px hairline).
  */
  padding: 0;
  height: 41px;
}
.wysiwyg-container .wysiwyg-toolbar .w-btn {
  /* -> `!important` because `WBtn` writes `min-height` as an inline style, which outranks any
     selector here. */
  min-height: 40px !important;
}
.body--light .wysiwyg-container .wysiwyg-toolbar {
  background: linear-gradient(to top, var(--color-grey-1) 0%, #fff 100%);
  border-bottom: 1px solid var(--color-grey-4);
}
.body--dark .wysiwyg-container .wysiwyg-toolbar {
  background: linear-gradient(to top, var(--color-dark-3) 0%, var(--color-dark-2) 100%);
  border-bottom: 1px solid var(--color-dark-1);
}
.wysiwyg-container .ProseMirror {
  padding: 16px;
  min-height: 75vh;
}
.body--dark .wysiwyg-container .ProseMirror {
  color: rgba(255, 255, 255, 0.87);
}
.wysiwyg-container .ProseMirror-focused {
  border: none;
  outline: none;
}
.wysiwyg-container .ProseMirror > * + * {
  margin-top: 0.75em;
}
.wysiwyg-container .ProseMirror ul,
.wysiwyg-container .ProseMirror ol {
  padding: 0 1rem;
}
.wysiwyg-container .ProseMirror h1,
.wysiwyg-container .ProseMirror h2,
.wysiwyg-container .ProseMirror h3,
.wysiwyg-container .ProseMirror h4,
.wysiwyg-container .ProseMirror h5,
.wysiwyg-container .ProseMirror h6 {
  line-height: 1.1;
}
.wysiwyg-container .ProseMirror code {
  background-color: rgba(97, 97, 97, 0.1);
  color: #616161;
}
.body--dark .wysiwyg-container .ProseMirror code {
  background-color: rgba(255, 255, 255, 0.08);
  color: var(--color-grey-4);
}
.wysiwyg-container .ProseMirror pre {
  background: #0d0d0d;
  color: #fff;
  font-family: 'JetBrainsMono', monospace;
  padding: 0.75rem 1rem;
  border-radius: 0.5rem;
}
.wysiwyg-container .ProseMirror pre code {
  color: inherit;
  padding: 0;
  background: none;
  font-size: 0.8rem;
}
.wysiwyg-container .ProseMirror img {
  max-width: 100%;
  height: auto;
}
.wysiwyg-container .ProseMirror blockquote {
  padding-inline-start: 1rem;
  border-inline-start: 2px solid rgba(13, 13, 13, 0.1);
}
.body--dark .wysiwyg-container .ProseMirror blockquote {
  border-inline-start-color: rgba(255, 255, 255, 0.2);
}
.wysiwyg-container .ProseMirror hr {
  border: none;
  border-top: 2px solid rgba(13, 13, 13, 0.1);
  margin: 2rem 0;
}
.body--dark .wysiwyg-container .ProseMirror hr {
  border-top-color: rgba(255, 255, 255, 0.2);
}
.wysiwyg-container .ProseMirror table {
  border-collapse: collapse;
  table-layout: fixed;
  width: 100%;
  margin: 0;
  overflow: hidden;
}
.wysiwyg-container .ProseMirror table td,
.wysiwyg-container .ProseMirror table th {
  min-width: 1em;
  border: 2px solid #ced4da;
  padding: 3px 5px;
  vertical-align: top;
  box-sizing: border-box;
  position: relative;
}
.body--dark .wysiwyg-container .ProseMirror table td,
.body--dark .wysiwyg-container .ProseMirror table th {
  border-color: var(--color-dark-1);
}
.wysiwyg-container .ProseMirror table td > *,
.wysiwyg-container .ProseMirror table th > * {
  margin-bottom: 0;
}
.wysiwyg-container .ProseMirror table th {
  font-weight: bold;
  text-align: start;
  background-color: #f1f3f5;
}
.body--dark .wysiwyg-container .ProseMirror table th {
  background-color: var(--color-dark-2);
}
.wysiwyg-container .ProseMirror table .selectedCell:after {
  z-index: 2;
  position: absolute;
  content: '';
  inset-inline-start: 0;
  inset-inline-end: 0;
  top: 0;
  bottom: 0;
  background: rgba(200, 200, 255, 0.4);
  pointer-events: none;
}
.wysiwyg-container .ProseMirror table .column-resize-handle {
  position: absolute;
  inset-inline-end: -2px;
  top: 0;
  bottom: -2px;
  width: 4px;
  background-color: #adf;
  pointer-events: none;
}
.wysiwyg-container .ProseMirror .tableWrapper {
  overflow-x: auto;
}
.wysiwyg-container .ProseMirror .resize-cursor {
  cursor: ew-resize;
  cursor: col-resize;
}
.wysiwyg-container .ProseMirror ul[data-type='taskList'] {
  list-style: none;
  padding: 0;
}
.wysiwyg-container .ProseMirror ul[data-type='taskList'] li {
  display: flex;
  align-items: center;
}
.wysiwyg-container .ProseMirror ul[data-type='taskList'] li > label {
  flex: 0 0 auto;
  margin-inline-end: 0.5rem;
}
.wysiwyg-container .ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  float: left;
  color: #ced4da;
  pointer-events: none;
  height: 0;
}
.body--dark .wysiwyg-container .ProseMirror p.is-editor-empty:first-child::before {
  color: rgba(255, 255, 255, 0.35);
}
.wysiwyg-container .ProseMirror {
  /*
    Remote collaborators' cursors: `CollaborationCaret` inlines only a per-user color on these two
    classes and leaves all of their layout to CSS.
  */
}
.wysiwyg-container .ProseMirror .collaboration-carets__caret {
  position: relative;
  margin-inline-start: -1px;
  margin-inline-end: -1px;
  border-inline-start: 1px solid;
  border-inline-end: 1px solid;
  word-break: normal;
  pointer-events: none;
}
.wysiwyg-container .ProseMirror {
  /*
    -> The caret label's `left` stays physical: it is a flag anchored to the caret's own left edge,
       and moving it to a logical offset without also moving the caret line it points at would
       separate the two under RTL. Allowlisted in `frontend/src/logicalSpacing.test.js`.
  */
}
.wysiwyg-container .ProseMirror .collaboration-carets__label {
  position: absolute;
  top: -1.4em;
  left: -1px;
  padding: 0.1rem 0.3rem;
  font-size: 0.7rem;
  font-weight: 600;
  line-height: normal;
  color: #fff;
  white-space: nowrap;
  user-select: none;
}
/*
  Alerts, footnotes, TeX and glossary terms get their own palette rather than the published page's
  `--content-*` admonition tokens: those are declared inside `.page-contents`'s scope, which this
  editor surface is not, and editing chrome only has to be legible, not pixel-identical.
*/
.wysiwyg-container .ProseMirror blockquote[data-alert-kind] {
  border-inline-start-width: 4px;
  border-inline-start-style: solid;
  padding-inline-start: 0.75rem;
  background-color: rgba(0, 0, 0, 0.03);
}
.body--dark .wysiwyg-container .ProseMirror blockquote[data-alert-kind] {
  background-color: rgba(255, 255, 255, 0.04);
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind]::before {
  content: attr(data-alert-kind);
  display: block;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='note'] {
  border-inline-start-color: #1976d2;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='note']::before {
  color: #1976d2;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='tip'] {
  border-inline-start-color: #388e3c;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='tip']::before {
  color: #388e3c;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='important'] {
  border-inline-start-color: #7b1fa2;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='important']::before {
  color: #7b1fa2;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='warning'] {
  border-inline-start-color: #f57c00;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='warning']::before {
  color: #f57c00;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='caution'] {
  border-inline-start-color: #d32f2f;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='caution']::before {
  color: #d32f2f;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='question'] {
  border-inline-start-color: #00796b;
}
.wysiwyg-container .ProseMirror blockquote[data-alert-kind='question']::before {
  color: #00796b;
}
.wysiwyg-container .ProseMirror sup.footnote-ref {
  color: #1976d2;
  cursor: default;
}
.wysiwyg-container .ProseMirror .footnote-definition {
  display: flex;
  gap: 0.4em;
  font-size: 0.9em;
  color: rgba(0, 0, 0, 0.65);
}
.body--dark .wysiwyg-container .ProseMirror .footnote-definition {
  color: rgba(255, 255, 255, 0.65);
}
.wysiwyg-container .ProseMirror .footnote-definition-label {
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}
.wysiwyg-container .ProseMirror .tex-math-error {
  display: inline-block;
  color: #d32f2f;
  background-color: rgba(211, 47, 47, 0.08);
  border: 1px dashed #d32f2f;
  padding: 0.1em 0.4em;
  border-radius: 3px;
  font-size: 0.85em;
}
.wysiwyg-container .ProseMirror .wysiwyg-glossary-term {
  text-decoration: underline dotted;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  cursor: help;
}
</style>
