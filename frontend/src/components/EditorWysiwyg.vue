<template>
  <div class="wysiwyg-container">
    <div class="wysiwyg-toolbar" v-if="editor">
      <template v-for="menuItem of menuBar">
        <w-separator class="mx-1" v-if="menuItem.type === `divider`" vertical />
        <w-btn
          v-else-if="menuItem.type === `dropdown`"
          :key="`ddn-` + menuItem.key"
          flat
          :icon="menuItem.icon"
          padding="xs"
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
            :icon="child.icon"
            padding="xs"
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
          :icon="menuItem.icon"
          padding="xs"
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

import LinkPickerDialog from '@/components/LinkPickerDialog.vue'

import { useCollabStore } from '@/stores/collab'
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
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Mention from '@tiptap/extension-mention'
import Placeholder from '@tiptap/extension-placeholder'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import Typography from '@tiptap/extension-typography'
import { common, createLowlight } from 'lowlight'

const lowlight = createLowlight(common)

// STORES

const collabStore = useCollabStore()
const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()
const userStore = useUserStore()
const dark = useDark()

// I18N

const { t } = useI18n()

/**
 * Inactive toolbar-button icon color, per theme (OpenProject #2498). The template hardcoded
 * `grey-10` (near-black, `#212121`) for every non-active menu entry, which is not itself a
 * theme-aware CSS custom property -- so once the toolbar's own background below picks up a dark
 * variant, an unchanged `grey-10` icon would go all but invisible against it. `grey-6` matches the
 * tone `EditorMarkdown.vue`'s own dark preview toolbar already uses on the same `$dark-2` panel.
 */
const inactiveIconColor = computed(() => (dark.isActive ? 'grey-6' : 'grey-10'))

// COMPUTED

/**
 * Whether this edit is shared with whoever else has the page open. Mirrors `EditorMarkdown.vue`'s
 * own `collabEnabled` exactly -- see its doc comment for why each condition is there.
 */
const collabEnabled = computed(
  () =>
    siteStore.features.collaborativeEditing &&
    userStore.authenticated &&
    editorStore.mode === 'edit' &&
    Boolean(pageStore.id)
)

// STATE

let editor = null
/**
 * Stop handles for the two collab watchers started in `onMounted`, kept for the same reason
 * `EditorMarkdown.vue`'s own pair are (see its matching comment, OpenProject #942): both are
 * registered inside a callback Vue does not auto-bind to this component's effect scope the way it
 * does an unconditional top-level `watch()`, so left running past unmount they fire against a
 * disposed editor and duplicate "saved by X" notifications on a later mount of the same page.
 */
let stopCollabStatusWatch = null
let stopCollabLastSaveWatch = null

/**
 * The hex values behind the "Text Color" dropdown's named entries (OpenProject #944). `Color`
 * (`@tiptap/extension-color`) writes whatever string `setColor()` is given straight onto the
 * `textStyle` mark's `color` attribute as inline CSS, so any valid CSS color would work here --
 * these are picked as a small, legible-on-white set rather than reusing `collabStore`'s cursor
 * palette (`composables/collab.js`'s `USER_COLORS`), which exists for a different purpose (staying
 * distinguishable against each other as cursors) and was never chosen for text legibility.
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
 * The hex values behind the "Highlight" dropdown's named entries (OpenProject #944). Lighter tints
 * than `TEXT_COLORS` on purpose: `Highlight` (`@tiptap/extension-highlight`) paints these as a mark's
 * *background*, and a highlighter is meant to sit behind text without swallowing it the way a
 * full-saturation background would.
 */
const HIGHLIGHT_COLORS = {
  blue: '#90CAF9',
  green: '#A5D6A7',
  orange: '#FFCC80',
  pink: '#F48FB1',
  yellow: '#FFF59D'
}

/*
  The toolbar itself is ~500 lines of static definition and lives in `helpers/wysiwygMenuBar.js`.
  Everything it closes over is handed to it: the editor (as a getter -- `editor` is still null here,
  and is assigned in `init()` on mount), the two palettes above, and the two actions that are not
  editor commands.
*/
const menuBar = buildMenuBar(() => editor, {
  TEXT_COLORS,
  HIGHLIGHT_COLORS,
  insertLink: () => insertLink(),
  openFileManager: (opts) => siteStore.openFileManager(opts)
})

// METHODS

/**
 * The TipTap extension list, parameterized by whether a live collaboration session is bound.
 *
 * Split out so the interim (non-collaborative) editor `init()` builds immediately and the
 * collaborative one `swapToCollabEditor()` builds once synced share every other option -- only the
 * `undoRedo`/`Collaboration`/`CollaborationCaret` entries differ (OpenProject #1124, wiring live
 * collaboration into this editor -- see that WP for why the deferral this comment used to explain no
 * longer applies).
 */
function buildExtensions(collab) {
  return [
    StarterKit.configure({
      codeBlock: false,
      // -> Configured explicitly below instead, so its options (`openOnClick`) can be set for this
      //    editing surface -- leaving it on here as well would register the `link` node twice and
      //    emit a `[tiptap warn]: Duplicate extension names found` on every mount.
      link: false,
      // -> `Collaboration`'s own undo/redo, backed by Yjs's `UndoManager`, replaces this once a
      //    session is bound -- keeping both registered logs `Collaboration.onCreate()`'s "not
      //    compatible with @tiptap/extension-undo-redo" warning, and only one of the two `undo`/
      //    `redo` command definitions actually wins. (`history` was StarterKit's tiptap v2 key for
      //    this; v3 renamed it to `undoRedo`, so the `{ depth: 500 }` written here before OpenProject
      //    #1124 was a silent no-op that never actually capped the undo stack.)
      undoRedo: collab ? false : { depth: 500 }
    }),
    CodeBlockLowlight.configure({
      lowlight
    }),
    Color,
    FontFamily,
    Highlight.configure({
      multicolor: true
    }),
    Image,
    Link.configure({
      // -> A click in the editor places the cursor, as in any other mark; without this, clicking
      //    linked text navigates the browser away instead of letting it be edited.
      openOnClick: false,
      // -> `insertFilesAsAssets` links a pasted/dropped non-image file's name to its pending asset's
      //    `blob:` URL until the upload lands -- Link's own default `isAllowedUri` allowlist (http,
      //    https, ftp, ftps, mailto, tel, callto, sms, cid, xmpp) does not include it, and would
      //    otherwise silently refuse `setLink()` (OpenProject #2449).
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
    // -> Unconfigured, `types` defaults to `[]` and `setTextAlign()` maps over an empty node-type
    //    list, so every alignment button was a silent no-op (OpenProject #944).
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TextStyle,
    Typography,
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

/**
 * Writes the editor's current state into the page store on every change, local or remote alike -- the
 * same "the editor buffer feeds the store, the store feeds Save" flow this component has always had.
 * A CRDT changes who is allowed to originate a change, not who is responsible for keeping
 * `pageStore.content` in step with what the editor is showing right now: a change that arrived from
 * another collaborator is exactly as real as one typed locally, and `pageSave` still reads the current
 * buffer either way (OpenProject #1124). Shared between the interim and collaborative editors so both
 * behave identically here.
 */
function handleEditorUpdate({ editor }) {
  editorStore.markDirty()
  pageStore.$patch({
    content: JSON.stringify(editor.getJSON()),
    // -> What the author has typed IS the source, whatever the load did or did not deliver; see
    //    the guard in `pageSave`
    contentLoaded: true,
    render: editor.getHTML()
  })
}

function init() {
  // -> Setup Editor View
  editorStore.$patch({
    hideSideNav: false
  })

  // -> Initialize TipTap. Starts read-only when a collab session is about to be started -- see the
  //    collaboration block in `onMounted` below for why, and `swapToCollabEditor()` for what replaces
  //    this instance once that session has synced.
  editor = useEditor({
    content:
      pageStore.content && pageStore.content.startsWith('{')
        ? JSON.parse(pageStore.content)
        : `<p>${pageStore.content}</p>`,
    editable: !collabEnabled.value,
    extensions: buildExtensions(null),
    editorProps: buildEditorProps(),
    onUpdate: handleEditorUpdate
  })
}

/**
 * Hands the editor over to the shared document once collaboration has synced (OpenProject #1124).
 *
 * TipTap's `Collaboration` extension can only be attached at construction: unlike `y-monaco`'s
 * `MonacoBinding`, which `EditorMarkdown.vue` constructs against an already-live editor via
 * `bindCollabEditor`, there is no supported way to register a packaged Extension -- as opposed to a
 * raw ProseMirror plugin, which `Editor#registerPlugin` does allow after the fact -- onto an editor
 * that already exists. Attaching it at construction time unconditionally, instead of waiting for
 * `bindCollabEditor`'s post-sync gate the way this does, was considered and rejected: `y-tiptap`'s
 * sync plugin overwrites the editor's content with whatever the shared document currently holds the
 * instant it mounts, so building the collaborative editor before the session has synced would blank
 * the page's just-loaded content in favour of an empty document, with no equivalent of the read-only
 * guard `EditorMarkdown.vue` gets by delaying the *binding* rather than the whole editor. So the
 * interim editor `init()` builds stays the only one until this runs, once, and this one replaces it
 * outright rather than trying to reuse it.
 *
 * `ytext` is `startCollabSession`'s plain-text `content` field, sized for Monaco's markdown source --
 * not usable here, since TipTap's collaboration is a tree CRDT (a `Y.XmlFragment`), not a flat-text
 * one. This editor gets its own root type on the *same* shared `Y.Doc` instead (`ytext.doc`, which
 * Yjs sets once a root type is first read off a document): same room, same participants, same
 * header-field and save-notification wiring, independent content type.
 *
 * Async since OpenProject #2516: the editor swap itself still happens synchronously, exactly as
 * before, but seeding an empty fragment now waits on `claimWysiwygSeed()` first -- see that
 * function's own doc comment for why. The caller (`bindCollabEditor`'s factory below) deliberately
 * does not return this function's promise, so `bindCollabEditor`'s own `binding` bookkeeping -- which
 * expects either a real teardown object or a falsy value -- never mistakes it for one.
 */
async function swapToCollabEditor(ytext, awareness) {
  const fragment = ytext.doc.getXmlFragment('wysiwygBody')
  /*
    Nobody has written to this field yet -- either this is the first person to open the page
    collaboratively, or the room emptied out since. Either way, what this editor was just showing
    (the page's saved content) becomes the room's starting state, the same way `core/collab.ts`'s
    `buildSeed()` seeds a fresh room's markdown field from `page.content` server-side.
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
    Ask the room's server-side coordinator before actually writing anything (OpenProject #2516):
    `fragment.length === 0` above only proves nobody had written to THIS client's own copy of the
    shared document yet, which is exactly what used to race -- two people opening a brand new room's
    WYSIWYG editor at the same instant would both see it empty and both seed, duplicating the content
    once the two replicas merged. `claimWysiwygSeed` grants at most one caller across the whole
    cluster, and never sees this editor's ProseMirror JSON at all -- only a boolean crosses that call.
    `fragment.length` is re-checked after the round trip in case the room's real content (a peer's own
    seed, or a draft restore) already landed while this one was in flight.
  */
  const granted = await claimWysiwygSeed({ siteId: siteStore.id, pageId: pageStore.id })
  if (granted && fragment.length === 0) {
    // -> `emitUpdate: false`: nothing changed that `pageStore` doesn't already have from the interim
    //    editor above -- `y-tiptap`'s sync plugin observes the dispatched transaction regardless of
    //    the TipTap-level "update" event this flag gates.
    editor.value.commands.setContent(seedContent, { emitUpdate: false })
  }
}

/**
 * Opens `LinkPickerDialog` (the same component and result shape `EditorMarkdown.vue`'s own
 * `insertLink()` uses) and applies the answer as a `link` mark over the current selection.
 *
 * A real text selection keeps its own text as the label -- `setLink` marks it in place, nothing is
 * replaced. A collapsed cursor has no text to mark, so the label (`title`, falling back to `href`,
 * matching what `EditorMarkdown.vue` falls back to) is inserted first and the mark applied to it.
 */
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

/**
 * What the file manager handed back, applied to the document at the cursor.
 *
 * `EditorMarkdown.vue`/`EditorCode.vue`/`EditorAsciidoc.vue` each write their own source syntax for
 * the same event; this editor's "source" is the TipTap document, so an image asset becomes a real
 * `image` node (`setImage`) and everything else (a non-image asset, or a page) becomes a `link` mark
 * over inserted text, the same image-vs-link distinction those editors draw (OpenProject #944 --
 * previously this editor registered no `insertAsset` listener at all, so the File Manager's pick was
 * silently dropped).
 */
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
 * Take files the author brought in — pasted or dropped — and write TipTap nodes for them at the
 * cursor (or `position`, for a drop landing somewhere other than wherever the cursor already was).
 *
 * Nothing is uploaded here, mirroring `EditorMarkdown.vue`'s own `insertFilesAsAssets` (OpenProject
 * #2449): each file becomes a pending asset held against a `blob:` URL via
 * `editorStore.addPendingAsset`, and `UploadPendingAssetsDialog` sends it on save and reports back
 * where it landed -- `reloadEditorContent` below is this editor's half of applying that.
 *
 * An image becomes a real `image` node, the same way `insertAssetClb` already draws one for a File
 * Manager pick; anything else becomes a `link` mark over the file's own name -- the same image-vs-link
 * split `insertAssetClb` draws, and the same "clipboard-pasted files all need a fresh name, a drop's
 * own name is real user intent" rule `generateUniqueName` documents on `addPendingAsset` itself. Only
 * the paste call site below sets it.
 */
function insertFilesAsAssets(files, { generateUniqueName = false, position = null } = {}) {
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

/*
  Pasting a file inserts it; pasting anything else (including the rich HTML paste this editor already
  handles via ProseMirror/TipTap's own default paste rules) is left alone -- `shouldClaimPaste` is what
  keeps text winning when an image rides alongside it on the clipboard, shared verbatim with
  `EditorMarkdown.vue`. Returning `false` here is a genuine decline: ProseMirror falls through to its
  normal paste handling (and TipTap's own HTML-to-document parsing) for anything not claimed.
*/
function handlePaste(view, event) {
  if (!shouldClaimPaste(event.clipboardData)) {
    return false
  }
  event.preventDefault()
  insertFilesAsAssets(pastedFiles(event.clipboardData), { generateUniqueName: true })
  return true
}

/*
  A drop has to be claimed twice, the same as `EditorMarkdown.vue`'s Monaco pair: `dragover` is what
  tells the browser this is a valid target -- without it there is no drop at all, just the browser
  navigating away to the file -- and `drop` is where it arrives. See `shouldAcceptDrag`'s own doc
  comment for why `dragover` cannot just check `hasFiles`.
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
  // -> Dropped text lands where it was dropped, and so should a file: `posAtCoords` returns `null`
  //    when the point is off the document (or, as in a test, when nothing has actually laid out) --
  //    `insertFilesAsAssets` falls back to the current selection rather than crash on a null position.
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
  insertFilesAsAssets(pastedFiles(event.dataTransfer), { position: coords?.pos ?? null })
  return true
}

/**
 * The ProseMirror-level `editorProps` shared by both places this editor constructs a TipTap `Editor`
 * (`init()`'s interim editor and `swapToCollabEditor()`'s collaborative one) -- a fresh object per
 * call, since TipTap does not expect the same `editorProps` instance handed to two live editors.
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
 * Rewrite the live document -- image `src` / link `href` attributes pointing at a pending asset's
 * `blob:` URL -- once `UploadPendingAssetsDialog` has uploaded it and knows the real path.
 *
 * `pageStore.content` is a plain string here (the TipTap JSON document, already `.replaceAll`'d by the
 * dialog before this fires) and is a one-way write from this editor, never read back in -- so the live
 * ProseMirror document, what the reader is actually looking at, needs its own rewrite, node by node.
 * The counterpart to `EditorMarkdown.vue`'s own `reloadEditorContent`, which does the equivalent
 * find-and-replace against its Monaco text model instead.
 *
 * A single transaction of attribute-only edits (`setNodeMarkup`, `removeMark`/`addMark`) -- none of
 * which change any node's size -- so every position collected while walking the original,
 * not-yet-mutated `state.doc` stays valid for the whole transaction with no incremental remapping.
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

// MOUNTED

onMounted(() => {
  EVENT_BUS.on('insertAsset', insertAssetClb)
  EVENT_BUS.on('reloadEditorContent', reloadEditorContent)
})

init()

// -> Live collaboration. Registered as its own `onMounted`, and after `init()` above rather than
//    before it, specifically so it runs *after* `useEditor()`'s own internal `onMounted` (which
//    `init()` registers by calling `useEditor()`) has constructed `editor.value` -- `useEditor()`
//    defers construction to its own mount hook rather than building synchronously the way
//    `EditorMarkdown.vue`'s Monaco editor does, and Vue runs mount hooks in registration order, so
//    this has to be registered after that one is.
onMounted(() => {
  if (!collabEnabled.value) {
    return
  }

  /*
    "Someone else already has this open" -- said once, before the collab session below has even
    asked to connect. `pageStore.activeEditors` came with the page itself (`viewer.activeEditors` on
    `GET .../pages/:id`, task 546), read off whatever room `core/collab.ts` already has for it on this
    instance -- so this can be shown immediately, without waiting on a socket. Page-level, not
    editor-specific, so this is identical to `EditorMarkdown.vue`'s own use of it.
  */
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
        // -> Not `(ytext, awareness) => swapToCollabEditor(ytext, awareness)`: `swapToCollabEditor`
        //    is async now (OpenProject #2516), and `bindCollabEditor` treats its factory's return
        //    value as a real teardown object to keep (or a falsy value if there is none) -- an
        //    implicitly-returned Promise would be mistaken for one and later have `.destroy()`
        //    called on it. This form fires it and deliberately returns nothing.
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

  /*
    Somebody else saved the page. The editor state has already been put back to "nothing pending" by
    the session -- this is only so that the author is told why their Save button went quiet.
  */
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
  // -> Stopped before `stopCollabSession()` below patches `collabStore.status` to `off` -- left
  //    running they fire past unmount against a disposed editor (OpenProject #942).
  stopCollabStatusWatch?.()
  stopCollabLastSaveWatch?.()
  // -> Before the editor goes: leaving the room is what takes this author's avatar out of everyone
  //    else's header
  stopCollabSession()
  editor.value.destroy()
})

// -> Exposed for tests only, so a mounted instance can drive the TipTap editor directly (e.g.
//    `wrapper.vm.editor.chain().focus().insertContent(...).run()`) the way the toolbar's own
//    handlers above do, rather than trying to simulate real keystrokes through happy-dom.
// -> `menuBar` is exposed alongside it for the same reason: several of its entries are nested one or
//    two `w-menu`/`w-item` levels below any `aria-label`, which is not worth simulating a real click
//    path through happy-dom for when the toolbar row's own template already drives every entry's
//    `action`/`isActive` off nothing but the entry object itself.
defineExpose({ editor, menuBar })
</script>

<style lang="scss">
.wysiwyg-container {
  height: calc(100% - 41px);

  .wysiwyg-toolbar {
    border: none;
    display: flex;
    align-items: center;
    padding: 4px;

    /*
      OpenProject #2498: this bar had no dark-mode treatment at all, so it stayed a bright white/grey
      band regardless of theme. Dark values reuse the same `$dark-2`/`$dark-1` panel-and-border pair
      `EditorMarkdown.vue`'s own dark preview toolbar uses -- the closest sibling shape, even though
      this toolbar (formatting buttons, not a rendered preview) has no exact structural twin.
    */
    @at-root .body--light & {
      background: linear-gradient(to top, $grey-1 0%, #fff 100%);
      border-bottom: 1px solid $grey-4;
    }
    @at-root .body--dark & {
      background: linear-gradient(to top, $dark-3 0%, $dark-2 100%);
      border-bottom: 1px solid $dark-1;
    }
  }

  .ProseMirror {
    padding: 16px;
    min-height: 75vh;

    /*
      The typed content itself, so a dark toolbar above isn't paired with the default (black-on-
      whatever's-behind-it) text the rest of this rule otherwise never sets a color for.
    */
    @at-root .body--dark & {
      color: rgba(255, 255, 255, 0.87);
    }

    &-focused {
      border: none;
      outline: none;
    }

    > * + * {
      margin-top: 0.75em;
    }

    ul,
    ol {
      padding: 0 1rem;
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      line-height: 1.1;
    }

    code {
      background-color: rgba(#616161, 0.1);
      color: #616161;

      @at-root .body--dark & {
        background-color: rgba(255, 255, 255, 0.08);
        color: $grey-4;
      }
    }

    pre {
      background: #0d0d0d;
      color: #fff;
      font-family: 'JetBrainsMono', monospace;
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;

      code {
        color: inherit;
        padding: 0;
        background: none;
        font-size: 0.8rem;
      }
    }

    img {
      max-width: 100%;
      height: auto;
    }

    blockquote {
      padding-inline-start: 1rem;
      border-inline-start: 2px solid rgba(#0d0d0d, 0.1);

      @at-root .body--dark & {
        border-inline-start-color: rgba(255, 255, 255, 0.2);
      }
    }

    hr {
      border: none;
      border-top: 2px solid rgba(#0d0d0d, 0.1);
      margin: 2rem 0;

      @at-root .body--dark & {
        border-top-color: rgba(255, 255, 255, 0.2);
      }
    }

    table {
      border-collapse: collapse;
      table-layout: fixed;
      width: 100%;
      margin: 0;
      overflow: hidden;

      td,
      th {
        min-width: 1em;
        border: 2px solid #ced4da;
        padding: 3px 5px;
        vertical-align: top;
        box-sizing: border-box;
        position: relative;

        @at-root .body--dark & {
          border-color: $dark-1;
        }

        > * {
          margin-bottom: 0;
        }
      }

      th {
        font-weight: bold;
        text-align: start;
        background-color: #f1f3f5;

        @at-root .body--dark & {
          background-color: $dark-2;
        }
      }

      .selectedCell:after {
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

      .column-resize-handle {
        position: absolute;
        inset-inline-end: -2px;
        top: 0;
        bottom: -2px;
        width: 4px;
        background-color: #adf;
        pointer-events: none;
      }
    }

    .tableWrapper {
      overflow-x: auto;
    }

    .resize-cursor {
      cursor: ew-resize;
      cursor: col-resize;
    }

    ul[data-type='taskList'] {
      list-style: none;
      padding: 0;

      li {
        display: flex;
        align-items: center;

        > label {
          flex: 0 0 auto;
          margin-inline-end: 0.5rem;
        }
      }
    }

    p.is-editor-empty:first-child::before {
      content: attr(data-placeholder);
      float: left;
      color: #ced4da;
      pointer-events: none;
      height: 0;

      @at-root .body--dark & {
        color: rgba(255, 255, 255, 0.35);
      }
    }

    /*
      Remote collaborators' cursors (OpenProject #1124). `CollaborationCaret`'s default `render`/
      `selectionRender` build these two classes with nothing but a per-user `border-color`/
      `background-color` already inlined -- everything about their layout is left to CSS, matching
      the shape of TipTap's own documented example for this extension.
    */
    .collaboration-carets__caret {
      position: relative;
      margin-inline-start: -1px;
      margin-inline-end: -1px;
      border-inline-start: 1px solid;
      border-inline-end: 1px solid;
      word-break: normal;
      pointer-events: none;
    }

    /*
      -> `left`/the bottom-left square corner of `border-radius` stay physical on purpose (OpenProject
         #1601's repo-wide pass): the label is a flag anchored to the caret's own left edge, its
         bottom-left corner cut square to form the flag's point flush against the caret line. Moving
         `left` to a logical offset without also flipping which `border-radius` corner is square would
         separate the point from the line it is supposed to touch under RTL -- a coordinated redesign,
         not a mechanical property swap. See `frontend/src/logicalSpacing.test.js`.
    */
    .collaboration-carets__label {
      position: absolute;
      top: -1.4em;
      left: -1px;
      padding: 0.1rem 0.3rem;
      border-radius: 3px 3px 3px 0;
      font-size: 0.7rem;
      font-weight: 600;
      line-height: normal;
      color: #fff;
      white-space: nowrap;
      user-select: none;
    }
  }
}
</style>
