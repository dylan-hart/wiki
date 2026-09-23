# Whiteboard format 2 comment recommendations (#3777)

No existing comment is contradicted by the format 2 change. `models/rendering.ts#extractText`'s
"whiteboard stroke JSON read as text but are not prose" still holds for a body of JSON lines, and
`board.js`, `component.js`, `whiteboardInsert.js` and both `whiteboardLimits` helpers carry no
comments. Nothing to delete or correct.

## blocks/block-whiteboard/component.js, `_finishStroke`

**Add.** Proposed, above `this._board = next`:

```
// FIXME: the board takes the stroke before the editor has accepted it. When
// applyWhiteboardBody refuses the body (a block or page cap), the stroke stays drawn although
// the fence never changed, and the next stroke is appended after it and sent again.
```

Reason: a real defect found while reading, older than format 2 (format 1 re-serialised `_board`,
refused stroke included, the same way). The editor tells the author "the last stroke was not kept"
while the block keeps showing it until the fence next changes.
