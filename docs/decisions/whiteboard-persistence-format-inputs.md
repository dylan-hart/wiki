# Whiteboard block: persistence-format inputs

Inputs for the whiteboard block's persistence decision (OpenProject #3734, under Feature #3711). This
records what a throwaway prototype measured. It does not make the decision. The prototype
(`blocks/block-whiteboard`, a round-trip test) was scratch and is not merged.

Authoring is only in the page editor. The block is read-only at view time.

## What was prototyped

One block read a saved drawing from each of three formats.

- **(a) Fenced JSON body.** `::block-whiteboard` wrapping a `whiteboard` fence of stroke JSON, read
  with `readFencedSource`.
- **(b) Asset reference.** `::block-whiteboard{src="/boards/plan.svg"}` rendering an `<img>`.
- **(c) Server row.** `::block-whiteboard{drawingKey="board-1"}` fetching a checklist-style
  `GET /sites/:siteId/pages/:pageId/whiteboard/:blockKey`. Fetch mocked, no table added.

`blocks/definitions.test.js` passed with the block present, and so did the existing
every-block WikiBlock round-trip in `frontend/src/editor/wysiwyg/wikiBlockMarkdown.test.js`.
`static definition` stayed a plain literal.

## Measurements

| Format | Round-trip through the markdown renderer and `EditorWysiwyg`'s WikiBlock node                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------- |
| (a)    | Body identical byte for byte, including a body containing a bare `::` line and `"` characters.                   |
| (b)    | `src` survives unchanged.                                                                                        |
| (c)    | `drawingKey` survives unchanged. The DOM lowercases it to `drawingkey`, which `blockAllowances` already handles. |

`EditorMarkdown.vue` is a text editor, so a fenced body or an attribute passes through it untouched.

Format (a) cost, compact single-line JSON (points as `[x,y]` pairs):

| Strokes x points | Markdown | Stored HTML | Markdown render | WYSIWYG round-trip |
| ---------------- | -------- | ----------- | --------------- | ------------------ |
| 20 x 50          | 11 kB    | 12 kB       | 2 ms            | 5 ms               |
| 200 x 100        | 208 kB   | 216 kB      | 2 ms            | 248 ms             |
| 1000 x 100       | 1.04 MB  | 1.08 MB     | 6 ms            | 7.9 s              |

The WYSIWYG round trip grows faster than linearly (5x the data, about 32x the time). The default
`bodyParserLimit` is 5 MB.

## Per format

### (a) Fenced body in page markdown

- No schema, route or asset. Versioned, copied, moved, restored and exported with the page. Needs no
  extra permission check, because reading the page reads the drawing.
- Zero requests at view time.
- A `whiteboard` fence outside the fence list at `frontend/src/renderers/markdown.js` renders as
  `<pre class="codeblock hljs"><code class="language-whiteboard">`. The raw JSON is visible until the
  block mounts, or forever when the block is disabled. Adding `whiteboard` to that list, as drawio
  has, gives the quiet `codeblock-whiteboard` form.
- `models/rendering.ts#extractText` keeps `pre` text, so the coordinates land in `searchContent`.
  It would need a `pre.codeblock-whiteboard` exclusion.
- `pageHistory.content` is a full snapshot per save, so every save stores the drawing again.
- One very long line makes every history diff a whole-line change.
- Not tested: concurrent editing through the Yjs collaboration extension merging inside one long JSON
  line.

### (b) SVG or PNG asset

- Cheap at view time (an `<img>`), and stays out of page content, history and search.
- The drawing is not re-editable from a bare PNG or plain SVG. It needs the source embedded (SVG
  `<metadata>`, PNG `tEXt`), or a second copy of it, which is format (a) again.
- Asset read access is a separate rule from page read (`read:assets`, `mayOnAsset`). A reader who
  may read the page but not the asset sees a broken image.
- The asset has its own lifecycle. A page restore or history view does not roll it back, and deleting
  or moving the asset folder breaks the page.
- SVG is served with `SVG_CSP` (`sandbox`) in `controllers/files.ts`. That holds as long as the
  block draws it through `<img>`, where no script runs.
- Each save uploads a file, so the editor needs `write:assets`.

### (c) Server row and route

- View time needs three sequential requests before paint: `/sites/current`, page-by-hash for the id,
  then the route (asserted in the prototype's block test).
- It needs a new table. The flat base migration and snapshot belong to #3729 this round, so a new
  table collides with it.
- `checklistExecutions` is a run log that "touches neither page history nor the approvals workflow".
  That is right for a checklist and wrong for authored content. A drawing row would not be in
  `pageHistory`, would not be rolled back by a restore, would bypass approvals, and would not follow
  a duplicated page. The `(pageId, blockKey)` key also means pasting the block onto another page
  yields an empty board.
- An editor that writes the row before the page save leaves orphans when the save is abandoned.
- The editor's unsaved-draft preview cannot show a row that has not been written.

## Reading

- (a) is the only option with no new server surface. Its costs are size and search noise, both
  containable with a size cap, compact point encoding and the two small edits above.
- (c) fits a run log and fits authored content poorly on history, approvals and copy semantics.
- (b) is the fallback if large boards matter, provided the source travels inside the file.
