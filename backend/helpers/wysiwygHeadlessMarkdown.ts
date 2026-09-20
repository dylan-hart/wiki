import { Markdown, MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import Color from '@tiptap/extension-color'
import FontFamily from '@tiptap/extension-font-family'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import Typography from '@tiptap/extension-typography'

/**
 * A legacy WYSIWYG row stores serialized Tiptap JSON under `contentType: 'html'`, so it starts with
 * `{`; real markup never does. `EditorWysiwyg.vue` repeats this check client-side -- keep the two in
 * sync by hand, the workspaces share no code.
 */
export function isLegacyWysiwygJson(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.trimStart().startsWith('{')
}

/**
 * Deliberately narrower than `EditorWysiwyg.vue`'s `buildExtensions()`, which is closed over a
 * mounted editor's stores: this only has to round-trip what a legacy row could contain.
 * `MarkdownManager.serialize()` renders an unrecognized node type generically rather than throwing,
 * so anything outside this set degrades to plain text for that one node.
 */
function headlessExtensions() {
  return [
    StarterKit.configure({
      // -> Registered separately below so its options apply and it isn't registered twice.
      link: false,
      // -> Never mounts an editable view, so there is no undo stack.
      undoRedo: false
    }),
    Color,
    FontFamily,
    Highlight.configure({ multicolor: true }),
    Image,
    Link.configure({
      openOnClick: false,
      protocols: ['blob']
    }),
    Table,
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TextStyle,
    Typography,
    Markdown
  ]
}

// -> Built once, not per call: registering the extensions is real work, and `serialize()` is pure,
//    so a shared instance leaks nothing between pages.
const manager = new MarkdownManager({ extensions: headlessExtensions() })

/**
 * @param json the caller's own `JSON.parse(row.content)`; a malformed row is its failure to report.
 * @throws Only when `json` has no top-level `doc` node -- the one shape `serialize()` cannot
 *   degrade node by node.
 */
export function convertTiptapJsonToMarkdown(json: unknown): string {
  if (
    typeof json !== 'object' ||
    json === null ||
    (json as { type?: unknown }).type !== 'doc' ||
    !Array.isArray((json as { content?: unknown }).content)
  ) {
    throw new Error('Not a Tiptap document: missing a top-level "doc" node.')
  }
  return manager.serialize(json as Record<string, unknown>)
}
