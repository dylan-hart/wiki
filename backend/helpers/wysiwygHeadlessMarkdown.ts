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
 * Whether a `contentType: 'html'` row's `content` is actually a serialized Tiptap/ProseMirror JSON
 * document rather than real HTML (OpenProject #3400) -- the historical quirk this whole task exists
 * to clean up. A genuine `code`-editor page's `content` is real markup and starts with a tag (`<`, or
 * plain text); only the legacy WYSIWYG rows this predates start with `{`. Shared by the run-once job
 * (`tasks/simple/convert-wysiwyg-json.ts`) and the frontend's lazy on-open fallback
 * (`EditorWysiwyg.vue`), which does the same `startsWith('{')` check client-side -- kept in sync by
 * hand since the two workspaces install separately and share no code.
 */
export function isLegacyWysiwygJson(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.trimStart().startsWith('{')
}

/**
 * The Tiptap node/mark set this converts against.
 *
 * Deliberately narrower than `EditorWysiwyg.vue`'s own `buildExtensions()`: that list is a live Vue
 * component's, closed over the page/site stores (`Mention`'s suggestion popup, `CodeBlockLowlight`'s
 * syntax-highlight registry) that only make sense inside a mounted editor, and it grows over time as
 * sibling work adds new constructs (blocks, footnotes, GitHub-style alerts, …) that a legacy row
 * predating all of them was never written in anyway. This list only has to round-trip what the
 * WYSIWYG editor could actually produce as of the last release before #3395 -- StarterKit's own nodes
 * (paragraph, heading, bold/italic/strike/code, code block, blockquote, lists, hr, hard break) plus
 * the handful of extensions `buildExtensions()` has carried from the start (images, links, tables,
 * task lists, text align/style/color/font, highlight, smart typography). `MarkdownManager.serialize()`
 * falls back to a generic renderer for any node type it doesn't recognize rather than throwing, so a
 * legacy document using something outside this set degrades to plain text for that one node instead
 * of failing the whole page -- see `convertTiptapJsonToMarkdown`'s own doc comment for what still
 * counts as an outright failure.
 */
function headlessExtensions() {
  return [
    StarterKit.configure({
      // -> Registered separately below, exactly like `EditorWysiwyg.vue`'s own `buildExtensions()`,
      //    so its options apply and StarterKit's bundled copy doesn't register the node twice.
      link: false,
      // -> No live undo stack to cap -- this never mounts an editable view.
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

// -> Built once, not per call: registering ~15 extensions into a `MarkdownManager` is real work
//    (`registerExtension()` walks each one's markdown/parseDOM config), and this converter has no
//    mutable state a shared instance could leak between pages -- every call is a pure `serialize()`
//    off whatever JSON it's handed.
const manager = new MarkdownManager({ extensions: headlessExtensions() })

/**
 * Convert one legacy row's parsed `content` JSON into the markdown text `content` now stores.
 *
 * @param json `JSON.parse(row.content)` -- the caller's, so a malformed-JSON row is the caller's
 *   parse failure to catch and report, not this function's.
 * @throws When `json` isn't a Tiptap document at all (no `doc` node), which is the one shape
 *   `MarkdownManager.serialize()` cannot do anything useful with -- everything else it degrades
 *   gracefully on a node-by-node basis rather than throwing (see `headlessExtensions()`'s doc
 *   comment), so this is deliberately the only failure case this function itself raises.
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
