/**
 * The WYSIWYG editor's toolbar, as data: one entry per button (or per dropdown, via `items`), each
 * carrying its icon, its title, what clicking it does and how to tell whether it is currently on.
 *
 * ~500 lines of static definition that closed over `EditorWysiwyg.vue`'s own bindings, which is the
 * only reason it lived there. Everything it needs now comes in: the editor itself, the two colour
 * palettes (which stay with the component, where the reasoning about legibility belongs), the two
 * actions that are not editor commands at all, and `t` (OpenProject #3206) -- every `title` below is
 * both the visible label and, via `EditorWysiwyg.vue`'s `:aria-label="menuItem.title"` /
 * `:aria-label="child.title"`, the accessible name, so it has to resolve through the real translation
 * table rather than being a literal English string. Keys live under `editor.wysiwyg.*` in
 * `backend/locales/en.json`, the same namespacing convention `EditorMarkdown.vue`'s `editor.markup.*`
 * already establishes. `EditorWysiwyg.vue` calls this from inside a `computed()`, not a one-time
 * `const`, specifically so a live locale switch rebuilds the whole array (and therefore every
 * translated title) rather than leaving stale English labels behind from whatever locale was active
 * when the component mounted.
 *
 * @param {() => {value: object}|null} getEditorRef Reads the component's live TipTap editor ref.
 *   A getter rather than the ref itself, because that binding is still `null` when the toolbar is
 *   built -- the editor is created in the component's own `init()`, on mount.
 * @param {object} opts
 * @param {Record<string, string>} opts.TEXT_COLORS
 * @param {Record<string, string>} opts.HIGHLIGHT_COLORS
 * @param {() => void} opts.insertLink Opens the shared link picker and applies the answer.
 * @param {(opts: object) => void} opts.openFileManager Opens the file manager in insert mode.
 * @param {(key: string, params?: object) => string} opts.t `useI18n()`'s `t`, from the caller --
 *   translates every menu item's `title` against `editor.wysiwyg.*`.
 */
export function buildMenuBar(
  getEditorRef,
  { TEXT_COLORS, HIGHLIGHT_COLORS, insertLink, openFileManager, t }
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
      title: t('editor.wysiwyg.bold'),
      action: () => editor.value.chain().focus().toggleBold().run(),
      isActive: () => editor.value.isActive('bold')
    },
    {
      key: 'italic',
      icon: 'tabler:italic',
      title: t('editor.wysiwyg.italic'),
      action: () => editor.value.chain().focus().toggleItalic().run(),
      isActive: () => editor.value.isActive('italic')
    },
    {
      key: 'strikethrough',
      icon: 'tabler:strikethrough',
      title: t('editor.wysiwyg.strike'),
      action: () => editor.value.chain().focus().toggleStrike().run(),
      isActive: () => editor.value.isActive('strike')
    },
    {
      key: 'code',
      icon: 'tabler:code',
      title: t('editor.wysiwyg.code'),
      action: () => editor.value.chain().focus().toggleCode().run(),
      isActive: () => editor.value.isActive('code')
    },
    {
      key: 'fontfamily',
      icon: 'tabler:typography',
      title: t('editor.wysiwyg.fontFamily'),
      type: 'dropdown',
      isActive: () => Boolean(editor.value.getAttributes('textStyle').fontFamily),
      children: [
        {
          key: 'fontunset',
          icon: 'tabler:typography',
          title: t('editor.wysiwyg.sansSerif'),
          action: () => editor.value.chain().focus().unsetFontFamily().run()
        },
        {
          key: 'monospace',
          icon: 'tabler:typography',
          title: t('editor.wysiwyg.monospace'),
          action: () => editor.value.chain().focus().setFontFamily('monospace').run()
        }
      ]
    },
    {
      key: 'color',
      icon: 'tabler:palette',
      title: t('editor.wysiwyg.textColor'),
      type: 'dropdown',
      isActive: () => Boolean(editor.value.getAttributes('textStyle').color),
      children: [
        {
          key: 'color-blue',
          icon: 'tabler:palette',
          title: t('editor.wysiwyg.colorBlue'),
          color: 'blue',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.blue }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.blue).run()
        },
        {
          key: 'color-brown',
          icon: 'tabler:palette',
          title: t('editor.wysiwyg.colorBrown'),
          color: 'brown',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.brown }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.brown).run()
        },
        {
          key: 'color-green',
          icon: 'tabler:palette',
          title: t('editor.wysiwyg.colorGreen'),
          color: 'green',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.green }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.green).run()
        },
        {
          key: 'color-orange',
          icon: 'tabler:palette',
          title: t('editor.wysiwyg.colorOrange'),
          color: 'orange',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.orange }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.orange).run()
        },
        {
          key: 'color-pink',
          icon: 'tabler:palette',
          title: t('editor.wysiwyg.colorPink'),
          color: 'pink',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.pink }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.pink).run()
        },
        {
          key: 'color-purple',
          icon: 'tabler:palette',
          title: t('editor.wysiwyg.colorPurple'),
          color: 'purple',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.purple }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.purple).run()
        },
        {
          key: 'color-red',
          icon: 'tabler:palette',
          title: t('editor.wysiwyg.colorRed'),
          color: 'red',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.red }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.red).run()
        },
        {
          key: 'color-teal',
          icon: 'tabler:palette',
          title: t('editor.wysiwyg.colorTeal'),
          color: 'teal',
          isActive: () => editor.value.isActive('textStyle', { color: TEXT_COLORS.teal }),
          action: () => editor.value.chain().focus().setColor(TEXT_COLORS.teal).run()
        },
        {
          key: 'color-yellow',
          icon: 'tabler:palette',
          title: t('editor.wysiwyg.colorYellow'),
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
          title: t('editor.wysiwyg.colorDefault'),
          color: 'grey',
          action: () => editor.value.chain().focus().unsetColor().run()
        }
      ]
    },
    {
      key: 'highlight',
      icon: 'tabler:highlight',
      title: t('editor.wysiwyg.highlight'),
      type: 'dropdown',
      isActive: () => editor.value.isActive('highlight'),
      children: [
        {
          key: 'highlight-yellow',
          icon: 'tabler:highlight',
          title: t('editor.wysiwyg.colorYellow'),
          color: 'yellow',
          isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.yellow }),
          action: () =>
            editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.yellow }).run()
        },
        {
          key: 'highlight-blue',
          icon: 'tabler:highlight',
          title: t('editor.wysiwyg.colorBlue'),
          color: 'blue',
          isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.blue }),
          action: () =>
            editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.blue }).run()
        },
        {
          key: 'highlight-pink',
          icon: 'tabler:highlight',
          title: t('editor.wysiwyg.colorPink'),
          color: 'pink',
          isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.pink }),
          action: () =>
            editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.pink }).run()
        },
        {
          key: 'highlight-green',
          icon: 'tabler:highlight',
          title: t('editor.wysiwyg.colorGreen'),
          color: 'green',
          isActive: () => editor.value.isActive('highlight', { color: HIGHLIGHT_COLORS.green }),
          action: () =>
            editor.value.chain().focus().toggleHighlight({ color: HIGHLIGHT_COLORS.green }).run()
        },
        {
          key: 'highlight-orange',
          icon: 'tabler:highlight',
          title: t('editor.wysiwyg.colorOrange'),
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
          title: t('editor.wysiwyg.highlightRemove'),
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
      title: t('editor.wysiwyg.header'),
      type: 'dropdown',
      isActive: () => editor.value.isActive('heading'),
      children: [
        {
          key: 'h1',
          icon: 'tabler:h-1',
          title: t('editor.wysiwyg.headerLevel', { level: 1 }),
          action: () => editor.value.chain().focus().toggleHeading({ level: 1 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 1 })
        },
        {
          key: 'h2',
          icon: 'tabler:h-2',
          title: t('editor.wysiwyg.headerLevel', { level: 2 }),
          action: () => editor.value.chain().focus().toggleHeading({ level: 2 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 2 })
        },
        {
          key: 'h3',
          icon: 'tabler:h-3',
          title: t('editor.wysiwyg.headerLevel', { level: 3 }),
          action: () => editor.value.chain().focus().toggleHeading({ level: 3 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 3 })
        },
        {
          key: 'h4',
          icon: 'tabler:h-4',
          title: t('editor.wysiwyg.headerLevel', { level: 4 }),
          action: () => editor.value.chain().focus().toggleHeading({ level: 4 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 4 })
        },
        {
          key: 'h5',
          icon: 'tabler:h-5',
          title: t('editor.wysiwyg.headerLevel', { level: 5 }),
          action: () => editor.value.chain().focus().toggleHeading({ level: 5 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 5 })
        },
        {
          key: 'h6',
          icon: 'tabler:h-6',
          title: t('editor.wysiwyg.headerLevel', { level: 6 }),
          action: () => editor.value.chain().focus().toggleHeading({ level: 6 }).run(),
          isActive: () => editor.value.isActive('heading', { level: 6 })
        }
      ]
    },
    {
      key: 'paragraph',
      icon: 'tabler:pilcrow',
      title: t('editor.wysiwyg.paragraph'),
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
          title: t('editor.wysiwyg.alignLeft'),
          action: () => editor.value.chain().focus().setTextAlign('left').run(),
          isActive: () => editor.value.isActive({ textAlign: 'left' })
        },
        {
          key: 'align-center',
          icon: 'tabler:align-center',
          title: t('editor.wysiwyg.alignCenter'),
          action: () => editor.value.chain().focus().setTextAlign('center').run(),
          isActive: () => editor.value.isActive({ textAlign: 'center' })
        },
        {
          key: 'align-right',
          icon: 'tabler:align-right',
          title: t('editor.wysiwyg.alignRight'),
          action: () => editor.value.chain().focus().setTextAlign('right').run(),
          isActive: () => editor.value.isActive({ textAlign: 'right' })
        },
        {
          key: 'align-justify',
          icon: 'tabler:align-justified',
          title: t('editor.wysiwyg.alignJustify'),
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
      title: t('editor.wysiwyg.bulletList'),
      action: () => editor.value.chain().focus().toggleBulletList().run(),
      isActive: () => editor.value.isActive('bulletList')
    },
    {
      key: 'orderedlist',
      icon: 'tabler:list-numbers',
      title: t('editor.wysiwyg.orderedList'),
      action: () => editor.value.chain().focus().toggleOrderedList().run(),
      isActive: () => editor.value.isActive('orderedList')
    },
    {
      key: 'tasklist',
      icon: 'tabler:list-check',
      title: t('editor.wysiwyg.taskList'),
      action: () => editor.value.chain().focus().toggleTaskList().run(),
      isActive: () => editor.value.isActive('taskList')
    },
    {
      type: 'divider'
    },
    {
      key: 'codeblock',
      icon: 'tabler:json',
      title: t('editor.wysiwyg.codeBlock'),
      action: () => editor.value.chain().focus().toggleCodeBlock().run(),
      isActive: () => editor.value.isActive('codeBlock')
    },
    {
      key: 'blockquote',
      icon: 'tabler:blockquote',
      title: t('editor.wysiwyg.blockquote'),
      action: () => editor.value.chain().focus().toggleBlockquote().run(),
      isActive: () => editor.value.isActive('blockquote')
    },
    {
      key: 'rule',
      icon: 'tabler:minus',
      title: t('editor.wysiwyg.horizontalRule'),
      action: () => editor.value.chain().focus().setHorizontalRule().run()
    },
    {
      key: 'link',
      icon: 'tabler:link',
      title: t('editor.wysiwyg.link'),
      action: () => insertLink(),
      isActive: () => editor.value.isActive('link')
    },
    {
      key: 'image',
      icon: 'tabler:photo-plus',
      title: t('editor.wysiwyg.image'),
      action: () => {
        openFileManager({ insertMode: true })
      }
    },
    {
      key: 'table',
      icon: 'tabler:table',
      title: t('editor.wysiwyg.table'),
      type: 'dropdown',
      isActive: () => editor.value.isActive('table'),
      children: [
        {
          key: 'table-insert',
          icon: 'tabler:table-plus',
          title: t('editor.wysiwyg.tableInsert'),
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
          title: t('editor.wysiwyg.tableAddColumnBefore'),
          action: () => editor.value.chain().focus().addColumnBefore().run(),
          disabled: () => !editor.value.can().addColumnBefore()
        },
        {
          key: 'table-addcolumnafter',
          icon: 'tabler:column-insert-right',
          title: t('editor.wysiwyg.tableAddColumnAfter'),
          action: () => editor.value.chain().focus().addColumnAfter().run(),
          disabled: () => !editor.value.can().addColumnAfter()
        },
        {
          key: 'table-deletecolumn',
          icon: 'tabler:column-remove',
          title: t('editor.wysiwyg.tableRemoveColumn'),
          action: () => editor.value.chain().focus().deleteColumn().run(),
          disabled: () => !editor.value.can().deleteColumn()
        },
        {
          type: 'divider'
        },
        {
          key: 'table-addrowbefore',
          icon: 'tabler:row-insert-top',
          title: t('editor.wysiwyg.tableAddRowBefore'),
          action: () => editor.value.chain().focus().addRowBefore().run(),
          disabled: () => !editor.value.can().addRowBefore()
        },
        {
          key: 'table-addrowafter',
          icon: 'tabler:row-insert-bottom',
          title: t('editor.wysiwyg.tableAddRowAfter'),
          action: () => editor.value.chain().focus().addRowAfter().run(),
          disabled: () => !editor.value.can().addRowAfter()
        },
        {
          key: 'table-deleterow',
          icon: 'tabler:row-remove',
          title: t('editor.wysiwyg.tableRemoveRow'),
          action: () => editor.value.chain().focus().deleteRow().run(),
          disabled: () => !editor.value.can().deleteRow()
        },
        {
          type: 'divider'
        },
        {
          key: 'table-merge',
          icon: 'tabler:layout-board',
          title: t('editor.wysiwyg.tableMergeCells'),
          action: () => editor.value.chain().focus().mergeCells().run(),
          disabled: () => !editor.value.can().mergeCells()
        },
        {
          key: 'table-split',
          icon: 'tabler:layout-columns',
          title: t('editor.wysiwyg.tableSplitCell'),
          action: () => editor.value.chain().focus().splitCell().run(),
          disabled: () => !editor.value.can().splitCell()
        },
        {
          type: 'divider'
        },
        {
          key: 'table-toggleHeaderColumn',
          icon: 'tabler:table-column',
          title: t('editor.wysiwyg.tableToggleHeaderColumn'),
          action: () => editor.value.chain().focus().toggleHeaderColumn().run(),
          disabled: () => !editor.value.can().toggleHeaderColumn()
        },
        {
          key: 'table-toggleHeaderRow',
          icon: 'tabler:table-row',
          title: t('editor.wysiwyg.tableToggleHeaderRow'),
          action: () => editor.value.chain().focus().toggleHeaderRow().run(),
          disabled: () => !editor.value.can().toggleHeaderRow()
        },
        {
          key: 'table-toggleHeaderCell',
          icon: 'tabler:square',
          title: t('editor.wysiwyg.tableToggleHeaderCell'),
          action: () => editor.value.chain().focus().toggleHeaderCell().run(),
          disabled: () => !editor.value.can().toggleHeaderCell()
        },
        {
          type: 'divider'
        },
        {
          key: 'table-fix',
          icon: 'tabler:table-heart',
          title: t('editor.wysiwyg.tableFix'),
          action: () => editor.value.chain().focus().fixTables().run(),
          disabled: () => !editor.value.can().fixTables()
        },
        {
          key: 'table-remove',
          icon: 'tabler:table-minus',
          title: t('editor.wysiwyg.tableDelete'),
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
      title: t('editor.wysiwyg.hardBreak'),
      action: () => editor.value.chain().focus().setHardBreak().run()
    },
    {
      key: 'clearformat',
      icon: 'tabler:clear-formatting',
      title: t('editor.wysiwyg.clearFormat'),
      action: () => editor.value.chain().focus().clearNodes().unsetAllMarks().run()
    },
    {
      type: 'divider'
    },
    {
      key: 'undo',
      icon: 'tabler:arrow-back-up',
      title: t('editor.wysiwyg.undo'),
      action: () => editor.value.chain().focus().undo().run(),
      disabled: () => !editor.value.can().undo()
    },
    {
      key: 'redo',
      icon: 'tabler:arrow-forward-up',
      title: t('editor.wysiwyg.redo'),
      action: () => editor.value.chain().focus().redo().run(),
      disabled: () => !editor.value.can().redo()
    }
  ]
}
