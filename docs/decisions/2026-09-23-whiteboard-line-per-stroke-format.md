# Decision: whiteboard body is one stroke per line

**Date:** 2026-09-23 · **Context:** OpenProject #3777, the Yjs concurrent-edit check the
[go/no-go record](2026-09-22-whiteboard-block-go-no-go.md) required before real-time editing is
offered for `block-whiteboard`. **Status:** Accepted. The project owner chose the fix.

## Finding

The go/no-go record's first no-go condition fired. Format 1 stored the drawing as one JSON line,
`{"v":1,"w":800,"h":450,"s":[…]}`. A stroke rewrote the whole code-block text, and y-tiptap turned
that into one insert at the common-prefix/suffix boundary, which on an empty board is just inside
`[]`. Two first strokes drawn at once merged as `"s":[{A}{B}]`, which is not JSON. The block then
showed "could not be read", refused further strokes, and the server saved the broken body.

## Options

| Option                                                 | Verdict                                                                                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One stroke per line                                    | **Chosen.** Concurrent strokes land as separate lines, and a damaged line costs one stroke, not the board                                                       |
| Single-editor lock on a whiteboard while others collab | Rejected. It needs a lock protocol over the collab room, and it takes away drawing together, which is the point of offering the block in a collaborative editor |
| Pull the block                                         | Rejected. The failure is in the body format, not in the block, and the format can be fixed                                                                      |

## Format 2

```
{"v":2,"w":800,"h":450}
{"c":"#1f2937","z":6,"p":[...]}
{"c":"#1f2937","z":6,"p":[...]}
```

- An empty board is the header line alone.
- The header has to parse and validate, or the board is unreadable. A header with no `v` is
  invalid. A different `v` is a version mismatch, so a format 1 body is reported as version 1. There
  is no format 1 reader and no migration, since there are no production instances.
- Each stroke line is parsed and validated on its own. A line that fails is skipped and counted
  (`parseBoard`'s `dropped`). Every existing safety property still applies to the lines that parse:
  the byte, stroke and point caps, clamping, the strict `#hex` colour, and no `unsafeSVG` or string
  interpolation into SVG.
- The block (`board.js#measureBody`), the editor (`helpers/whiteboardLimits.js`) and the server
  (`helpers/whiteboardLimits.ts`) count the cap the same way. Every non-blank line after the header
  is a stroke, even one that does not parse. Points come only from lines that parse to an object with
  an array `p`.

## Always append

The block builds a new body as the text it was given, plus `\n`, plus the new stroke's JSON. It
does not re-serialise the board. A re-serialised board drops any damaged line, so the new body would
no longer extend the old one and the editor would fall back to replacing the whole text.
`applyWhiteboardBody` inserts only the appended suffix when the new body extends the code block's
trimmed text, at the end of that text. It replaces the whole text otherwise.

Trade-off, accepted: a damaged line stays in the body until someone edits it out by hand.

y-tiptap diffs the code block's old and new text itself, whatever the ProseMirror step was. So when
the old text is a prefix of the new, the merge is a pure insert at the end, and concurrent strokes
become separate lines either way. The suffix insert still matters when the code block ends in a
line break, which the block trims away. A whole replacement there diffs to an insert after that
line break with no line break of its own, and two concurrent strokes would join on one line.

## What this changes in the go/no-go record

- **Persistence format.** Format (a) is still a fenced body inside `::block-whiteboard`. It is now
  one line per stroke under a header line, not one compact JSON line.
- **Costs.** "One very long line makes every history diff a whole-line change" no longer holds. A
  stroke adds one line, so a history diff shows the strokes that changed. Every save still stores
  the whole drawing again in `pageHistory.content`.
- **Yjs check.** Done. `frontend/src/editor/wysiwyg/whiteboardInsert.yjs.test.js` binds two editors
  to their own `Y.Doc` through the real `Collaboration` extension. It covers concurrent first strokes
  on an empty board, concurrent strokes on a drawn board, one replica appending while the other
  removes its last stroke, a code block ending in whitespace, and concurrent undo.
- **Round-trip budget.** The near-cap WYSIWYG round trip (200 strokes of 110 points, about 227 KiB)
  measured the same in both formats on the same machine, about 12 to 14 ms in the editor and about
  40 ms for the whole test case. It stays well under 250 ms.
