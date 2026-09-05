/**
 * The WYSIWYG editor's toolbar, as data: one entry per button (or per dropdown, via `items`), each
 * carrying its icon, its title, what clicking it does and how to tell whether it is currently on.
 *
 * ~500 lines of static definition that closed over `EditorWysiwyg.vue`'s own bindings, which is the
 * only reason it lived there. Everything it needs now comes in: the editor itself, the two colour
 * palettes (which stay with the component, where the reasoning about legibility belongs), and the
 * two actions that are not editor commands at all.
 *
 * @param {() => {value: object}|null} getEditorRef Reads the component's live TipTap editor ref.
 *   A getter rather than the ref itself, because that binding is still `null` when the toolbar is
 *   built -- the editor is created in the component's own `init()`, on mount.
 * @param {object} opts
 * @param {Record<string, string>} opts.TEXT_COLORS
 * @param {Record<string, string>} opts.HIGHLIGHT_COLORS
 * @param {() => void} opts.insertLink Opens the shared link picker and applies the answer.
 * @param {(opts: object) => void} opts.openFileManager Opens the file manager in insert mode.
 */
export function buildMenuBar(
  getEditorRef,
  { TEXT_COLORS, HIGHLIGHT_COLORS, insertLink, openFileManager }
) {
  /*
    A live view of the component's own `editor` binding rather than a captured copy: it is assigned
    on mount and its `.value` is replaced again when the collaborative editor is swapped in, and
    every entry below reads `editor.value` at click time exactly as it did in the component.
  */
  const editor = {
    get value() {
      return getEditorRef()?.value
    }
  }

  return [
    {
      key: 'bold',
      icon: 'tabler:bold',
      title: 'Bold',
      action: () => editor.value.chain().focus().toggleBold().run(),
      isActive: () => editor.value.isActive('bold')
    },
    {
      key: 'italic',
      icon: 'tabler:italic',
      title: 'Italic',
      action: () => editor.value.chain().focus().toggleItalic().run(),
      isActive: () => editor.value.isActive('italic')
    },
    {
      key: 'strikethrough',
      icon: 'tabler:strikethrough',
      title: 'Strike',
      action: () => editor.value.chain().focus().toggleStrike().run(),
      isActive: () => editor.value.isActive('strike')
    },
    {
      key: 'code',
      icon: 'tabler:code',
      title: 'Code',
      action: () => editor.value.chain().focus().toggleCode().run(),
      isActive: () => editor.value.isActive('code')
    },
    {
      key: 'fontfamily',
      icon: 'tabler:typography',
      title: 'Font Family',
      type: 'dropdown',
      isActive: () => Boolean(editor.value.getAttributes('textStyle').fontFamily),
      children: [
        {
          key: 'fontunset',
          icon: 'tabler:typography',
          title: 'Sans-Serif',
          action: () => editor.value.chain().focus().unsetFontFamily().run()
        },
        {
          key: 'monospace',
          icon: 'tabler:typography',
          title: 'Monospace',
          action: () => editor.value.chain().focus().setFontFamily('monospace').run()
        }
      ]
    },
    {
      key: 'color',
      icon: 'tabler:palette',
      title: 'Text Color',
      type: 'dropdown',
      isActive: () => Boolean(editor.value.getAttributes('textStyle').color),
      children: [
        {
          key: 'color-blue',
          icon: 'tabler:palette',
          title: 'Blue',
          color: 'blue',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.blue }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.blue).run()
        },
        {
          key: 'color-brown',
          icon: 'tabler:palette',
          title: 'Brown',
          color: 'brown',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.brown }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.brown).run()
        },
        {
          key: 'color-green',
          icon: 'tabler:palette',
          title: 'Green',
          color: 'green',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.green }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.green).run()
        },
        {
          key: 'color-orange',
          icon: 'tabler:palette',
          title: 'Orange',
          color: 'orange',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.orange }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.orange).run()
        },
        {
          key: 'color-pink',
          icon: 'tabler:palette',
          title: 'Pink',
          color: 'pink',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.pink }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.pink).run()
        },
        {
          key: 'color-purple',
          icon: 'tabler:palette',
          title: 'Purple',
          color: 'purple',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.purple }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.purple).run()
        },
        {
          key: 'color-red',
          icon: 'tabler:palette',
          title: 'Red',
          color: 'red',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.red }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.red).run()
        },
        {
          key: 'color-teal',
          icon: 'tabler:palette',
          title: 'Teal',
          color: 'teal',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.teal }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.teal).run()
        },
        {
          key: 'color-yellow',
          icon: 'tabler:palette',
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
          icon: 'tabler:palette',
          title: 'Default',
          color: 'grey',
          action: () => editor.value.chain().focus().unsetColor().run()
        }
      ]
    },
    {
      key: 'highlight',
      icon: 'tabler:highlight',
      title: 'Highlight',
      type: 'dropdown',
      isActive: () => editor.value.isActive('highlight'),
      children: [
        {
          key: 'highlight-yellow',
          icon: 'tabler:highlight',
          title: 'Yellow',
          color: 'yellow',
          isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.yellow }),
          action: () =>
            editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.yellow }).run()
        },
        {
          key: 'highlight-blue',
          icon: 'tabler:highlight',
          title: 'Blue',
          color: 'blue',
          isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.blue }),
          action: () =>
            editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.blue }).run()
        },
        {
          key: 'highlight-pink',
          icon: 'tabler:highlight',
          title: 'Pink',
          color: 'pink',
          isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.pink }),
          action: () =>
            editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.pink }).run()
        },
        {
          key: 'highlight-green',
          icon: 'tabler:highlight',
          title: 'Green',
          color: 'green',
          isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.green }),
          action: () =>
            editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.green }).run()
        },
        {
          key: 'highlight-orange',
          icon: 'tabler:highlight',
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
          icon: 'tabler:highlight-off',
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
      icon: 'tabler:heading',
      title: 'Header',
      type: 'dropdown',
      isActive: () => editor.value.isActive('heading'),
      children: [
        {
          key: 'h1',
          icon: 'tabler:h-1',
          title: 'Header 1',
          action: () => editor.value.chain().focus().toggleHeading({ level: 1 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 1 })
        },
        {
          key: 'h2',
          icon: 'tabler:h-2',
          title: 'Header 2',
          action: () => editor.value.chain().focus().toggleHeading({ level: 2 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 2 })
        },
        {
          key: 'h3',
          icon: 'tabler:h-3',
          title: 'Header 3',
          action: () => editor.value.chain().focus().toggleHeading({ level: 3 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 3 })
        },
        {
          key: 'h4',
          icon: 'tabler:h-4',
          title: 'Header 4',
          action: () => editor.value.chain().focus().toggleHeading({ level: 4 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 4 })
        },
        {
          key: 'h5',
          icon: 'tabler:h-5',
          title: 'Header 5',
          action: () => editor.value.chain().focus().toggleHeading({ level: 5 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 5 })
        },
        {
          key: 'h6',
          icon: 'tabler:h-6',
          title: 'Header 6',
          action: () => editor.value.chain().focus().toggleHeading({ level: 6 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 6 })
        }
      ]
    },
    {
      key: 'paragraph',
      icon: 'tabler:pilcrow',
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
          icon: 'tabler:align-left',
          title: 'Left Align',
          action: () => editor.value.chain().focus().setTextAlign('left').run(),
          isActive: () => editor.value.isActive({ textAlign: 'left' })
        },
        {
          key: 'align-center',
          icon: 'tabler:align-center',
          title: 'Center Align',
          action: () => editor.value.chain().focus().setTextAlign('center').run(),
          isActive: () => editor.value.isActive({ textAlign: 'center' })
        },
        {
          key: 'align-right',
          icon: 'tabler:align-right',
          title: 'Right Align',
          action: () => editor.value.chain().focus().setTextAlign('right').run(),
          isActive: () => editor.value.isActive({ textAlign: 'right' })
        },
        {
          key: 'align-justify',
          icon: 'tabler:align-justified',
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
      icon: 'tabler:list',
      title: 'Bullet List',
      action: () => editor.value.chain().focus().toggleBulletList().run(),
      isActive: () => editor.value.isActive('bulletList')
    },
    {
      key: 'orderedlist',
      icon: 'tabler:list-numbers',
      title: 'Ordered List',
      action: () => editor.value.chain().focus().toggleOrderedList().run(),
      isActive: () => editor.value.isActive('orderedList')
    },
    {
      key: 'tasklist',
      icon: 'tabler:list-check',
      title: 'Task List',
      action: () => editor.value.chain().focus().toggleTaskList().run(),
      isActive: () => editor.value.isActive('taskList')
    },
    {
      type: 'divider'
    },
    {
      key: 'codeblock',
      icon: 'tabler:json',
      title: 'Code Block',
      action: () => editor.value.chain().focus().toggleCodeBlock().run(),
      isActive: () => editor.value.isActive('codeBlock')
    },
    {
      key: 'blockquote',
      icon: 'tabler:blockquote',
      title: 'Blockquote',
      action: () => editor.value.chain().focus().toggleBlockquote().run(),
      isActive: () => editor.value.isActive('blockquote')
    },
    {
      key: 'rule',
      icon: 'tabler:minus',
      title: 'Horizontal Rule',
      action: () => editor.value.chain().focus().setHorizontalRule().run()
    },
    {
      key: 'link',
      icon: 'tabler:link',
      title: 'Link',
      action: () => insertLink(),
      isActive: () => editor.value.isActive('link')
    },
    {
      key: 'image',
      icon: 'tabler:photo-plus',
      title: 'Image',
      action: () => {
        openFileManager({ insertMode: true })
      }
    },
    {
      key: 'table',
      icon: 'tabler:table',
      title: 'Table',
      type: 'dropdown',
      isActive: () => editor.value.isActive('table'),
      children: [
        {
          key: 'table-insert',
          icon: 'tabler:table-plus',
          title: 'Insert Table',
          action: () =>
            editor.value
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run()
        },
        {
          type: 'divider'
        },
        {
          key: 'table-addcolumnbefore',
          icon: 'tabler:column-insert-left',
          title: 'Add Column Before',
          action: () => editor.value.chain().focus().addColumnBefore().run(),
          disabled: () => !editor.value.can().addColumnBefore()
        },
        {
          key: 'table-addcolumnafter',
          icon: 'tabler:column-insert-right',
          title: 'Add Column After',
          action: () => editor.value.chain().focus().addColumnAfter().run(),
          disabled: () => !editor.value.can().addColumnAfter()
        },
        {
          key: 'table-deletecolumn',
          icon: 'tabler:column-remove',
          title: 'Remove Column',
          action: () => editor.value.chain().focus().deleteColumn().run(),
          disabled: () => !editor.value.can().deleteColumn()
        },
        {
          type: 'divider'
        },
        {
          key: 'table-addrowbefore',
          icon: 'tabler:row-insert-top',
          title: 'Add Row Before',
          action: () => editor.value.chain().focus().addRowBefore().run(),
          disabled: () => !editor.value.can().addRowBefore()
        },
        {
          key: 'table-addrowafter',
          icon: 'tabler:row-insert-bottom',
          title: 'Add Row After',
          action: () => editor.value.chain().focus().addRowAfter().run(),
          disabled: () => !editor.value.can().addRowAfter()
        },
        {
          key: 'table-deleterow',
          icon: 'tabler:row-remove',
          title: 'Remove Row',
          action: () => editor.value.chain().focus().deleteRow().run(),
          disabled: () => !editor.value.can().deleteRow()
        },
        {
          type: 'divider'
        },
        {
          key: 'table-merge',
          icon: 'tabler:layout-board',
          title: 'Merge Cells',
          action: () => editor.value.chain().focus().mergeCells().run(),
          disabled: () => !editor.value.can().mergeCells()
        },
        {
          key: 'table-split',
          icon: 'tabler:layout-columns',
          title: 'Split Cell',
          action: () => editor.value.chain().focus().splitCell().run(),
          disabled: () => !editor.value.can().splitCell()
        },
        {
          type: 'divider'
        },
        {
          key: 'table-toggleHeaderColumn',
          icon: 'tabler:table-column',
          title: 'Toggle Header Column',
          action: () => editor.value.chain().focus().toggleHeaderColumn().run(),
          disabled: () => !editor.value.can().toggleHeaderColumn()
        },
        {
          key: 'table-toggleHeaderRow',
          icon: 'tabler:table-row',
          title: 'Toggle Header Row',
          action: () => editor.value.chain().focus().toggleHeaderRow().run(),
          disabled: () => !editor.value.can().toggleHeaderRow()
        },
        {
          key: 'table-toggleHeaderCell',
          icon: 'tabler:square',
          title: 'Toggle Header Cell',
          action: () => editor.value.chain().focus().toggleHeaderCell().run(),
          disabled: () => !editor.value.can().toggleHeaderCell()
        },
        {
          type: 'divider'
        },
        {
          key: 'table-fix',
          icon: 'tabler:table-heart',
          title: 'Fix Table',
          action: () => editor.value.chain().focus().fixTables().run(),
          disabled: () => !editor.value.can().fixTables()
        },
        {
          key: 'table-remove',
          icon: 'tabler:table-minus',
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
      icon: 'tabler:page-break',
      title: 'Hard Break',
      action: () => editor.value.chain().focus().setHardBreak().run()
    },
    {
      key: 'clearformat',
      icon: 'tabler:clear-formatting',
      title: 'Clear Format',
      action: () => editor.value.chain().focus().clearNodes().unsetAllMarks().run()
    },
    {
      type: 'divider'
    },
    {
      key: 'undo',
      icon: 'tabler:arrow-back-up',
      title: 'Undo',
      action: () => editor.value.chain().focus().undo().run(),
      disabled: () => !editor.value.can().undo()
    },
    {
      key: 'redo',
      icon: 'tabler:arrow-forward-up',
      title: 'Redo',
      action: () => editor.value.chain().focus().redo().run(),
      disabled: () => !editor.value.can().redo()
    }
  ]
}
