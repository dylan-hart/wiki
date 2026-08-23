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
          :color="menuItem.isActive && menuItem.isActive() ? `primary` : `grey-10`"
          :aria-label="menuItem.title"
          split
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
        <w-btn-group v-else-if="menuItem.type === `btngroup`" :key="`btngrp-` + menuItem.key" flat>
          <w-btn
            v-for="child of menuItem.children"
            :key="child.key"
            flat
            :icon="child.icon"
            padding="xs"
            :class="{ 'is-active': child.isActive && child.isActive() }"
            :color="child.isActive && child.isActive() ? `primary` : `grey-10`"
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
          :color="menuItem.isActive && menuItem.isActive() ? `primary` : `grey-10`"
          @click="menuItem.action"
          :aria-label="menuItem.title"
          :disabled="menuItem.disabled && menuItem.disabled()" />
      </template>
      <!-- q-space -->
      <!-- q-btn( -->
      <!-- size='sm' -->
      <!-- unelevated -->
      <!-- color='red' -->
      <!-- label='Test' -->
      <!-- @click='snapshot' -->
      <!-- ) -->
    </div>
    <!-- q-scroll-area( -->
    <!-- :thumb-style='thumbStyle' -->
    <!-- :bar-style='barStyle' -->
    <!-- style='height: 100%;' -->
    <!-- ) -->
    <editor-content :editor="editor" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import { dialog } from '@/composables/dialog'

import { assetPath } from '@/helpers/assets'
import { createPageMentionSuggestion } from '@/helpers/editorMentions'

import LinkPickerDialog from '@/components/LinkPickerDialog.vue'

import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
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

const editorStore = useEditorStore()
const pageStore = usePageStore()
const siteStore = useSiteStore()

// I18N

const { t } = useI18n()

// STATE

let editor = null

const thumbStyle = {
  right: '2px',
  borderRadius: '5px',
  backgroundColor: '#000',
  width: '5px',
  opacity: 0.15
}
const barStyle = {
  backgroundColor: '#FAFAFA',
  width: '9px',
  opacity: 1
}
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

const menuBar = [
  {
    key: 'bold',
    icon: 'mdi:format-bold',
    title: 'Bold',
    action: () => editor.value.chain().focus().toggleBold().run(),
    isActive: () => editor.value.isActive('bold')
  },
  {
    key: 'italic',
    icon: 'mdi:format-italic',
    title: 'Italic',
    action: () => editor.value.chain().focus().toggleItalic().run(),
    isActive: () => editor.value.isActive('italic')
  },
  {
    key: 'strikethrough',
    icon: 'mdi:format-strikethrough',
    title: 'Strike',
    action: () => editor.value.chain().focus().toggleStrike().run(),
    isActive: () => editor.value.isActive('strike')
  },
  {
    key: 'code',
    icon: 'mdi:code-tags',
    title: 'Code',
    action: () => editor.value.chain().focus().toggleCode().run(),
    isActive: () => editor.value.isActive('code')
  },
  {
    key: 'fontfamily',
    icon: 'mdi:format-font',
    title: 'Font Family',
    type: 'dropdown',
    isActive: () => Boolean(editor.value.getAttributes('textStyle').fontFamily),
    children: [
      {
        key: 'fontunset',
        icon: 'mdi:format-font',
        title: 'Sans-Serif',
        action: () => editor.value.chain().focus().unsetFontFamily().run()
      },
      {
        key: 'monospace',
        icon: 'mdi:format-font',
        title: 'Monospace',
        action: () => editor.value.chain().focus().setFontFamily('monospace').run()
      }
    ]
  },
  {
    key: 'color',
    icon: 'mdi:palette',
    title: 'Text Color',
    type: 'dropdown',
    isActive: () => Boolean(editor.value.getAttributes('textStyle').color),
    children: [
      {
        key: 'color-blue',
        icon: 'mdi:palette',
        title: 'Blue',
        color: 'blue',
        isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.blue }),
        action: () => editor.value.chain().focus().setColor(TEXT_COLORS.blue).run()
      },
      {
        key: 'color-brown',
        icon: 'mdi:palette',
        title: 'Brown',
        color: 'brown',
        isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.brown }),
        action: () => editor.value.chain().focus().setColor(TEXT_COLORS.brown).run()
      },
      {
        key: 'color-green',
        icon: 'mdi:palette',
        title: 'Green',
        color: 'green',
        isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.green }),
        action: () => editor.value.chain().focus().setColor(TEXT_COLORS.green).run()
      },
      {
        key: 'color-orange',
        icon: 'mdi:palette',
        title: 'Orange',
        color: 'orange',
        isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.orange }),
        action: () => editor.value.chain().focus().setColor(TEXT_COLORS.orange).run()
      },
      {
        key: 'color-pink',
        icon: 'mdi:palette',
        title: 'Pink',
        color: 'pink',
        isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.pink }),
        action: () => editor.value.chain().focus().setColor(TEXT_COLORS.pink).run()
      },
      {
        key: 'color-purple',
        icon: 'mdi:palette',
        title: 'Purple',
        color: 'purple',
        isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.purple }),
        action: () => editor.value.chain().focus().setColor(TEXT_COLORS.purple).run()
      },
      {
        key: 'color-red',
        icon: 'mdi:palette',
        title: 'Red',
        color: 'red',
        isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.red }),
        action: () => editor.value.chain().focus().setColor(TEXT_COLORS.red).run()
      },
      {
        key: 'color-teal',
        icon: 'mdi:palette',
        title: 'Teal',
        color: 'teal',
        isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.teal }),
        action: () => editor.value.chain().focus().setColor(TEXT_COLORS.teal).run()
      },
      {
        key: 'color-yellow',
        icon: 'mdi:palette',
        title: 'Yellow',
        color: 'yellow',
        isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.yellow }),
        action: () => editor.value.chain().focus().setColor(TEXT_COLORS.yellow).run()
      },
      {
        type: 'divider'
      },
      {
        key: 'color-remove',
        icon: 'mdi:palette',
        title: 'Default',
        color: 'grey',
        action: () => editor.value.chain().focus().unsetColor().run()
      }
    ]
  },
  {
    key: 'highlight',
    icon: 'mdi:marker',
    title: 'Highlight',
    type: 'dropdown',
    isActive: () => editor.value.isActive('highlight'),
    children: [
      {
        key: 'highlight-yellow',
        icon: 'mdi:marker',
        title: 'Yellow',
        color: 'yellow',
        isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.yellow }),
        action: () =>
          editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.yellow }).run()
      },
      {
        key: 'highlight-blue',
        icon: 'mdi:marker',
        title: 'Blue',
        color: 'blue',
        isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.blue }),
        action: () =>
          editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.blue }).run()
      },
      {
        key: 'highlight-pink',
        icon: 'mdi:marker',
        title: 'Pink',
        color: 'pink',
        isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.pink }),
        action: () =>
          editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.pink }).run()
      },
      {
        key: 'highlight-green',
        icon: 'mdi:marker',
        title: 'Green',
        color: 'green',
        isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.green }),
        action: () =>
          editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.green }).run()
      },
      {
        key: 'highlight-orange',
        icon: 'mdi:marker',
        title: 'Orange',
        color: 'orange',
        isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.orange }),
        action: () =>
          editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.orange }).run()
      },
      {
        type: 'divider'
      },
      {
        key: 'highlight-remove',
        icon: 'mdi:marker-cancel',
        title: 'Remove',
        color: 'grey',
        action: () => editor.value.chain().focus().unsetHighlight().run()
      }
    ]
  },
  {
    type: 'divider'
  },
  {
    key: 'header',
    icon: 'mdi:format-header-pound',
    title: 'Header',
    type: 'dropdown',
    isActive: () => editor.value.isActive('heading'),
    children: [
      {
        key: 'h1',
        icon: 'mdi:format-header-1',
        title: 'Header 1',
        action: () => editor.value.chain().focus().toggleHeading({ level: 1 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 1 })
      },
      {
        key: 'h2',
        icon: 'mdi:format-header-2',
        title: 'Header 2',
        action: () => editor.value.chain().focus().toggleHeading({ level: 2 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 2 })
      },
      {
        key: 'h3',
        icon: 'mdi:format-header-3',
        title: 'Header 3',
        action: () => editor.value.chain().focus().toggleHeading({ level: 3 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 3 })
      },
      {
        key: 'h4',
        icon: 'mdi:format-header-4',
        title: 'Header 4',
        action: () => editor.value.chain().focus().toggleHeading({ level: 4 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 4 })
      },
      {
        key: 'h5',
        icon: 'mdi:format-header-5',
        title: 'Header 5',
        action: () => editor.value.chain().focus().toggleHeading({ level: 5 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 5 })
      },
      {
        key: 'h6',
        icon: 'mdi:format-header-6',
        title: 'Header 6',
        action: () => editor.value.chain().focus().toggleHeading({ level: 6 }).run(),
        isActive: () => editor.value.isActive('heading', { level: 6 })
      }
    ]
  },
  {
    key: 'paragraph',
    icon: 'mdi:format-paragraph',
    title: 'Paragraph',
    action: () => editor.value.chain().focus().setParagraph().run(),
    isActive: () => editor.value.isActive('paragraph')
  },
  {
    type: 'divider'
  },
  {
    key: 'align',
    type: 'btngroup',
    children: [
      {
        key: 'align-left',
        icon: 'mdi:format-align-left',
        title: 'Left Align',
        action: () => editor.value.chain().focus().setTextAlign('left').run(),
        isActive: () => editor.value.isActive({ textAlign: 'left' })
      },
      {
        key: 'align-center',
        icon: 'mdi:format-align-center',
        title: 'Center Align',
        action: () => editor.value.chain().focus().setTextAlign('center').run(),
        isActive: () => editor.value.isActive({ textAlign: 'center' })
      },
      {
        key: 'align-right',
        icon: 'mdi:format-align-right',
        title: 'Right Align',
        action: () => editor.value.chain().focus().setTextAlign('right').run(),
        isActive: () => editor.value.isActive({ textAlign: 'right' })
      },
      {
        key: 'align-justify',
        icon: 'mdi:format-align-justify',
        title: 'Justify Align',
        action: () => editor.value.chain().focus().setTextAlign('justify').run(),
        isActive: () => editor.value.isActive({ textAlign: 'justify' })
      }
    ]
  },
  {
    type: 'divider'
  },
  {
    key: 'bulletlist',
    icon: 'mdi:format-list-bulleted',
    title: 'Bullet List',
    action: () => editor.value.chain().focus().toggleBulletList().run(),
    isActive: () => editor.value.isActive('bulletList')
  },
  {
    key: 'orderedlist',
    icon: 'mdi:format-list-numbered',
    title: 'Ordered List',
    action: () => editor.value.chain().focus().toggleOrderedList().run(),
    isActive: () => editor.value.isActive('orderedList')
  },
  {
    key: 'tasklist',
    icon: 'mdi:format-list-checks',
    title: 'Task List',
    action: () => editor.value.chain().focus().toggleTaskList().run(),
    isActive: () => editor.value.isActive('taskList')
  },
  {
    type: 'divider'
  },
  {
    key: 'codeblock',
    icon: 'mdi:code-json',
    title: 'Code Block',
    action: () => editor.value.chain().focus().toggleCodeBlock().run(),
    isActive: () => editor.value.isActive('codeBlock')
  },
  {
    key: 'blockquote',
    icon: 'mdi:format-quote-open',
    title: 'Blockquote',
    action: () => editor.value.chain().focus().toggleBlockquote().run(),
    isActive: () => editor.value.isActive('blockquote')
  },
  {
    key: 'rule',
    icon: 'mdi:minus',
    title: 'Horizontal Rule',
    action: () => editor.value.chain().focus().setHorizontalRule().run()
  },
  {
    key: 'link',
    icon: 'mdi:link-variant',
    title: 'Link',
    action: () => insertLink(),
    isActive: () => editor.value.isActive('link')
  },
  {
    key: 'image',
    icon: 'mdi:image-plus',
    title: 'Image',
    action: () => {
      siteStore.openFileManager({ insertMode: true })
    }
  },
  {
    key: 'table',
    icon: 'mdi:table',
    title: 'Table',
    type: 'dropdown',
    isActive: () => editor.value.isActive('table'),
    children: [
      {
        key: 'table-insert',
        icon: 'mdi:table-large-plus',
        title: 'Insert Table',
        action: () =>
          editor.value.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
      },
      {
        type: 'divider'
      },
      {
        key: 'table-addcolumnbefore',
        icon: 'mdi:table-column-plus-before',
        title: 'Add Column Before',
        action: () => editor.value.chain().focus().addColumnBefore().run(),
        disabled: () => !editor.value.can().addColumnBefore()
      },
      {
        key: 'table-addcolumnafter',
        icon: 'mdi:table-column-plus-after',
        title: 'Add Column After',
        action: () => editor.value.chain().focus().addColumnAfter().run(),
        disabled: () => !editor.value.can().addColumnAfter()
      },
      {
        key: 'table-deletecolumn',
        icon: 'mdi:table-column-remove',
        title: 'Remove Column',
        action: () => editor.value.chain().focus().deleteColumn().run(),
        disabled: () => !editor.value.can().deleteColumn()
      },
      {
        type: 'divider'
      },
      {
        key: 'table-addrowbefore',
        icon: 'mdi:table-row-plus-before',
        title: 'Add Row Before',
        action: () => editor.value.chain().focus().addRowBefore().run(),
        disabled: () => !editor.value.can().addRowBefore()
      },
      {
        key: 'table-addrowafter',
        icon: 'mdi:table-row-plus-after',
        title: 'Add Row After',
        action: () => editor.value.chain().focus().addRowAfter().run(),
        disabled: () => !editor.value.can().addRowAfter()
      },
      {
        key: 'table-deleterow',
        icon: 'mdi:table-row-remove',
        title: 'Remove Row',
        action: () => editor.value.chain().focus().deleteRow().run(),
        disabled: () => !editor.value.can().deleteRow()
      },
      {
        type: 'divider'
      },
      {
        key: 'table-merge',
        icon: 'mdi:table-merge-cells',
        title: 'Merge Cells',
        action: () => editor.value.chain().focus().mergeCells().run(),
        disabled: () => !editor.value.can().mergeCells()
      },
      {
        key: 'table-split',
        icon: 'mdi:table-split-cell',
        title: 'Split Cell',
        action: () => editor.value.chain().focus().splitCell().run(),
        disabled: () => !editor.value.can().splitCell()
      },
      {
        type: 'divider'
      },
      {
        key: 'table-toggleHeaderColumn',
        icon: 'mdi:table-column',
        title: 'Toggle Header Column',
        action: () => editor.value.chain().focus().toggleHeaderColumn().run(),
        disabled: () => !editor.value.can().toggleHeaderColumn()
      },
      {
        key: 'table-toggleHeaderRow',
        icon: 'mdi:table-row',
        title: 'Toggle Header Row',
        action: () => editor.value.chain().focus().toggleHeaderRow().run(),
        disabled: () => !editor.value.can().toggleHeaderRow()
      },
      {
        key: 'table-toggleHeaderCell',
        icon: 'mdi:crop-square',
        title: 'Toggle Header Cell',
        action: () => editor.value.chain().focus().toggleHeaderCell().run(),
        disabled: () => !editor.value.can().toggleHeaderCell()
      },
      {
        type: 'divider'
      },
      {
        key: 'table-fix',
        icon: 'mdi:table-heart',
        title: 'Fix Table',
        action: () => editor.value.chain().focus().fixTables().run(),
        disabled: () => !editor.value.can().fixTables()
      },
      {
        key: 'table-remove',
        icon: 'mdi:table-large-remove',
        title: 'Delete Table',
        action: () => editor.value.chain().focus().deleteTable().run(),
        disabled: () => !editor.value.can().deleteTable()
      }
    ]
  },
  {
    type: 'divider'
  },
  {
    key: 'pagebreak',
    icon: 'mdi:format-page-break',
    title: 'Hard Break',
    action: () => editor.value.chain().focus().setHardBreak().run()
  },
  {
    key: 'clearformat',
    icon: 'mdi:format-clear',
    title: 'Clear Format',
    action: () => editor.value.chain().focus().clearNodes().unsetAllMarks().run()
  },
  {
    type: 'divider'
  },
  {
    key: 'undo',
    icon: 'mdi:undo-variant',
    title: 'Undo',
    action: () => editor.value.chain().focus().undo().run(),
    disabled: () => !editor.value.can().undo()
  },
  {
    key: 'redo',
    icon: 'mdi:redo-variant',
    title: 'Redo',
    action: () => editor.value.chain().focus().redo().run(),
    disabled: () => !editor.value.can().redo()
  }
]

// METHODS

/*
 * Live collaboration: still deferred, not wired -- but both premises the original deferral rested on
 * are now false, so this comment exists to say why the deferral itself still stands (OpenProject
 * #944, item 4).
 *
 * Task 485 (feature 367) originally deferred this for two concrete, checkable reasons:
 *
 *  - This component had no caller. That is no longer true: `pages/Index.vue`'s `wysiwyg` entry in
 *    `editorComponents` is live (the sibling Editor Selection feature re-enabled it), so mounting
 *    this editor is now a real, reachable path, not a dead one.
 *  - Its `@tiptap/*` dependencies were not installed. They are now -- all eleven packages this file
 *    imports resolve at v3.30.1 in `package.json`/`node_modules` (task 484 fixed the two v2-shaped
 *    imports that kept this from building at all).
 *
 * The re-decision: still not wired here, because turning it on is a materially bigger change than
 * either premise going stale implies. `EditorMarkdown.vue`'s collab session binds a *Monaco* model
 * through `y-monaco`'s `MonacoBinding`, which `bindCollabEditor`'s factory shape already
 * accommodates -- but a TipTap document needs `@tiptap/extension-collaboration` (a currently
 * uninstalled dependency of its own) plus `@tiptap/extension-collaboration-cursor` for remote
 * cursors/awareness, both configured with the shared `Y.Doc` `startCollabSession` creates, and a
 * decision about how this editor's per-keystroke `onUpdate` (which currently owns writing
 * `pageStore.content`/`render` directly) coexists with a CRDT that wants to own the document instead.
 * That is new design and testing surface belonging to a follow-up work item, not a byproduct of a
 * toolbar bug-fix pass -- filed as OpenProject #1124. The dead `Y.Doc`/`IndexeddbPersistence`/
 * `WebsocketProvider` stub that used to sit in `init()` below was already removed when this comment
 * was first written, and `composables/collab.js`'s `bindCollabEditor` already takes a binding
 * factory rather than hardcoding `y-monaco`, so #1124 has exactly this component's own `onUpdate`
 * handoff left to design -- nothing to redo in `composables/collab.js` itself.
 */

function init() {
  // -> Setup Editor View
  editorStore.$patch({
    hideSideNav: false
  })

  // -> Initialize TipTap
  editor = useEditor({
    content:
      pageStore.content && pageStore.content.startsWith('{')
        ? JSON.parse(pageStore.content)
        : `<p>${pageStore.content}</p>`,
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        // -> Configured explicitly below instead, so its options (`openOnClick`) can be set for this
        //    editing surface -- leaving it on here as well would register the `link` node twice and
        //    emit a `[tiptap warn]: Duplicate extension names found` on every mount.
        link: false,
        history: {
          depth: 500
        }
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
        openOnClick: false
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
      Typography
    ],
    onUpdate: ({ editor }) => {
      editorStore.$patch({
        lastChangeTimestamp: Temporal.Now.instant()
      })
      pageStore.$patch({
        content: JSON.stringify(editor.getJSON()),
        // -> What the author has typed IS the source, whatever the load did or did not deliver; see
        //    the guard in `pageSave`
        contentLoaded: true,
        render: editor.getHTML()
      })
    }
  })
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

function insertTable() {
  // this.ql.getModule('table').insertTable(3, 3)
}
function snapshot() {
  // console.info(Y.encodeStateVector(this.ydoc))
}

// MOUNTED

onMounted(() => {
  // init()
  EVENT_BUS.on('insertAsset', insertAssetClb)
})

onBeforeUnmount(() => {
  EVENT_BUS.off('insertAsset', insertAssetClb)
  editor.value.destroy()
})

init()

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
    border-bottom: 1px solid $grey-4;
    display: flex;
    align-items: center;
    padding: 4px;
    background: linear-gradient(to top, $grey-1 0%, #fff 100%);
  }

  .ProseMirror {
    padding: 16px;
    min-height: 75vh;

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
      padding-left: 1rem;
      border-left: 2px solid rgba(#0d0d0d, 0.1);
    }

    hr {
      border: none;
      border-top: 2px solid rgba(#0d0d0d, 0.1);
      margin: 2rem 0;
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

        > * {
          margin-bottom: 0;
        }
      }

      th {
        font-weight: bold;
        text-align: left;
        background-color: #f1f3f5;
      }

      .selectedCell:after {
        z-index: 2;
        position: absolute;
        content: '';
        left: 0;
        right: 0;
        top: 0;
        bottom: 0;
        background: rgba(200, 200, 255, 0.4);
        pointer-events: none;
      }

      .column-resize-handle {
        position: absolute;
        right: -2px;
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
          margin-right: 0.5rem;
        }
      }
    }

    p.is-editor-empty:first-child::before {
      content: attr(data-placeholder);
      float: left;
      color: #ced4da;
      pointer-events: none;
      height: 0;
    }
  }
}
</style>
