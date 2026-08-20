# Markdown Editor List Continuation — Design

**Date:** 2026-08-20
**Status:** Approved
**OpenProject:** #802
**Scope of this document:** Enter-key list continuation/exit for the Monaco-based Markdown editor
(`frontend/src/components/EditorMarkdown.vue`). Toolbar button behavior (re-clicking Unordered/Ordered/Task
List on an existing list line) is explicitly out of scope — see "Scope decisions" below.

## Why this exists

`insertBeforeEachLine({ content, before })` (`EditorMarkdown.vue:1078`), the shared handler behind the
Unordered List, Ordered List, and Task List toolbar buttons, strips-or-prepends a literal prefix per
selected line on click. It has no concept of "the cursor is inside an existing list" and no numbering logic
at all — pressing Enter mid-list today just produces a plain line, same as anywhere else in the document.
Every other editor with list support (VS Code, Word, Google Docs) continues the list automatically on Enter
and exits it when Enter is pressed on an already-empty item; #802 asks for that same fluent-typing behavior
here.

## Scope decisions

Established through clarifying questions before this design was written:

- **Enter-key continuation only.** Toolbar re-click behavior (clicking Ordered List while already on an
  ordered-list line) is a separate, unrelated interaction and out of scope for this ticket.
- **All three list types** — unordered (`- `), ordered (`1. ` / `1) `), and task (`- [ ] ` / `- [x] `) — get
  continuation. A continued task item is always inserted unchecked, regardless of whether the item being
  continued from was checked.
- **Empty-item Enter exits the list.** Pressing Enter on a line that is only a marker (no content after it)
  removes the marker instead of adding another empty item — the standard "second Enter to leave the list"
  behavior.
- **Ordered-list numbering increments the current line's number by 1.** No backward scan of the list for
  gaps or a "true" next value; whatever number is on the line Enter was pressed from, plus one. Simple,
  matches how someone actually types top-to-bottom, and doesn't require parsing the surrounding list.
- **Indentation is preserved** — the new line copies the current line's leading whitespace, so nested/indented
  list items keep continuing at the same nesting level.
- **Renumbering the rest of the list is out of scope.** Inserting a continuation in the middle of an existing
  1-2-3 sequence does not walk forward and renumber subsequent lines; only the new line's own number is
  computed, from the line Enter was pressed on.
- **Blockquote-prefixed lists (`> - item`) are out of scope.** The detection regexes don't match `>`-prefixed
  lines; those fall through to default Enter behavior, unchanged from today.

## Architecture

A new function, `continueList()`, colocated in `EditorMarkdown.vue` next to `insertBeforeEachLine()`. It's
registered as a Monaco editor action alongside the existing `editTableCommand`/`editBlockCommand` setup
(~line 1770-1796):

```js
editor.addAction({
  id: 'wikijs.continueList',
  label: 'Continue List',
  keybindings: [monaco.KeyCode.Enter],
  precondition: 'editorTextFocus && !suggestWidgetVisible && !renameInputVisible',
  run: () => continueList()
})
```

Binding the action to `Enter` shadows Monaco's native Enter handling entirely — there is no "decline and
let Monaco handle it" once the key is bound. `continueList()` is therefore a dispatcher: it must always
produce *some* correct Enter behavior. Its fallback for every case that isn't a list continuation or exit is

```js
editor.trigger('keyboard', 'type', { text: '\n' })
```

which re-invokes Monaco's own default Enter pipeline (indentation rules, auto-closing, etc.) exactly as if
the action weren't registered.

## Detection

`continueList()` only engages for a single caret with an empty selection:

```js
const selections = editor.getSelections()
if (selections.length !== 1 || !selections[0].isEmpty()) {
  return fallbackToDefaultEnter()
}
```

Multi-cursor Enter and Enter-over-a-selection both fall through — a conservative default for input shapes
outside what this design covers, rather than guessing at per-cursor behavior.

For the simple-caret case, the current line's full text is matched against three regexes, checked in this
order (task before unordered, since a task line also starts with `-`):

```js
const TASK_RE = /^(\s*)-\s\[([ xX])\]\s/
const ORDERED_RE = /^(\s*)(\d+)([.)])\s/
const UNORDERED_RE = /^(\s*)([-*+])\s/
```

Each captures the leading indentation (`\s*`) verbatim. `ORDERED_RE` additionally captures the number and
the delimiter char (`.` or `)`), so a hand-typed `1) foo` list continues as `2) `, not silently normalized to
a period. If none match, it's not a list line and the fallback applies.

A match also requires the cursor to be at or after the end of the matched marker (`cursor.column >=
match[0].length + 1`). Enter pressed *before or inside* the marker itself (e.g. cursor at column 1, ahead of
the leading whitespace) isn't continuation — the fallback split would otherwise duplicate the marker onto
the moved-down line. This is the same "outside what we designed for" fallback as the multi-cursor/selection
case above, not a new behavior.

## Continue vs. exit

Given a match — indentation, list type, and (for ordered) number + delimiter — plus the line's text with the
matched marker stripped:

- **Empty item → exit.** If the marker-stripped remainder is empty (the line is only the marker, e.g. `- `
  or `  3. `), replace the entire current line with `''`. A single-line edit: no newline inserted, no new
  marker. The cursor lands on the now-blank line.

- **Non-empty item → continue.** Otherwise, perform a normal split at the cursor position — text before the
  cursor stays on the current line, text at/after the cursor moves to a new line, matching Monaco's own
  default Enter split — and prefix the new line with the captured indentation plus the continuation marker:
  - Unordered: the source line's bullet character (`-`, `*`, or `+`), preserved rather than
    normalized — same precedent as the ordered-list delimiter below
  - Task: `- [ ] ` (always unchecked)
  - Ordered: `${number + 1}${delimiter} `

  This is one Monaco edit spanning the split point (one undo step), not two separate operations. Cursor
  position within the line is not otherwise significant — a continuation triggered from the middle of a
  non-empty item still splits and prefixes the moved trailing text, the same as typing Enter mid-sentence
  would, just now prefixed.

- **No match → fallback.** `fallbackToDefaultEnter()` from the Architecture section.

## Testing

Unit tests co-located in `EditorMarkdown.test.js`, driving `continueList()` directly against a real Monaco
model, per this project's existing test conventions for the file:

- Continue: unordered, ordered (increments; preserves `.` vs `)` delimiter), task (always inserts unchecked,
  tested from both a checked and an unchecked previous item)
- Exit: empty item for each of the three list types, including with leading indentation
- Indentation preserved on continuation, for a nested item
- Mid-line cursor split still prefixes the new line correctly
- Fallback: plain (non-list) line, multi-cursor, non-empty selection — each produces an ordinary `\n` split
  with no marker inserted

No Playwright/e2e case is planned. The live-Playwright-verification step used elsewhere in this project's
workflow rounds targets cross-boundary bugs (build config, worker bundling); this is self-contained editor
logic that a Monaco-model unit test exercises directly and faithfully.
