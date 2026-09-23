# Decision: whiteboard block go/no-go

**Date:** 2026-09-22 · **Context:** OpenProject #3736, closing Feature #3711 (Investigate an
embeddable whiteboard/ink block for freehand drawing in pages). **Status:** Accepted. The project
owner confirmed it in the #3714 deep-dive.

## Recommendation

**Go**, scoped to a freehand ink block, not a diagramming whiteboard.

- **Library:** `perfect-freehand` 1.2.3, driven by our own Lit element and pointer handling.
- **Persistence:** format (a), a fenced JSON stroke body inside `::block-whiteboard`.
- **Server surface:** no new route, table or asset. Three small edits and a size cap (see
  Required changes).
- **CSP:** no directive change.

Authoring happens only in the page editor. The block is read-only at view time.

## Evidence

Each spike's evidence is cited here rather than repeated. Figures below are copied from them.

| Spike                            | Where the evidence lives                                                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #3733 library evaluation         | The "Spike result: drawing libraries for a whiteboard block" matrix, comment 11225 on #3733. The throwaway `blocks/block-whiteboard-spike/` element was not committed.                          |
| #3734 persistence                | `docs/decisions/whiteboard-persistence-format-inputs.md`. The scratch block and round-trip tests are on local branch `wp-3734-whiteboard-scratch` (commit `e0b1aa724`), which is not for merge. |
| #3735 sanitizer, storage and CSP | `docs/decisions/2026-09-21-whiteboard-sanitizer-storage-csp-analysis.md` and its fixture `backend/helpers/htmlSanitizePolicy.whiteboard.test.ts` (18 tests, no policy edits).                   |

## Library

Measured on the repo's own rolldown config (`platform: 'browser'`, minified, gzip), per #3733.

| Library                         | Licence                                                               | Gzipped, static                                | `script-src 'self'`                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `perfect-freehand` 1.2.3        | MIT                                                                   | **2.0 kB** (the spike block built to 2.65 kB)  | Clean, no `eval`, no workers                                                                                                 |
| `signature_pad` 5.1.4           | MIT                                                                   | 4.7 kB                                         | Clean                                                                                                                        |
| `@excalidraw/excalidraw` 0.18.1 | MIT                                                                   | 413 kB, plus a 743 kB font-subset worker chunk | The subset worker's embind glue calls `new Function` and instantiates wasm, needing `'unsafe-eval'` and `'wasm-unsafe-eval'` |
| `tldraw` 5.4.2                  | tldraw License: no production use without a key or commercial licence | 608 kB                                         | Clean, but licence rules it out                                                                                              |

Baselines in this repo, gzipped: `block-pdf.js` 132.9 kB plus a 366.3 kB worker, mermaid's entry graph
193.5 kB, `block-katex.js` 617.9 kB, `block-openapi.js` 423.1 kB. The recommended library is smaller
than every existing media or diagram block. Excalidraw's initial 413 kB is about twice mermaid's.

Why `perfect-freehand`:

- It takes `[x, y, pressure]` and returns an outline, so pen pressure from `PointerEvent.pressure`
  works and we own pointer capture and `touch-action: none`.
- It renders into our own SVG inside the shadow root, so there is no shadow-DOM portal or font problem.
- It needs no assets and no CSP change.

Rejected:

- **tldraw:** the licence alone. It cannot ship in an AGPL product without a paid key.
- **Excalidraw:** it needs React bundled into a Lit block, 13 MB of self-hosted fonts through
  `EXCALIDRAW_ASSET_PATH` (the default falls back to `esm.sh`), a shadow-DOM workaround, and either
  `'unsafe-eval'` and `'wasm-unsafe-eval'` in `cspDirectives` or no font embedding on export. Widening
  `script-src` defeats the guarantee `CLAUDE.md` treats as load-bearing. It is the right choice only if
  a full diagramming whiteboard becomes the goal.
- **`signature_pad`:** viable, and the fallback if a ready-made canvas with `toSVG`/`fromData` matters
  more than pressure-sensitive pen input. It has no true pen pressure and sets `touch-action` itself.

Not verified by #3733: behaviour in a real browser under an enforced CSP. Excalidraw and tldraw were
assessed from published bundles and licences, not run.

## Persistence format

The prototype in #3734 loaded a saved drawing from all three candidates, and
`blocks/definitions.test.js` and the every-block `WikiBlock` round trip in
`frontend/src/editor/wysiwyg/wikiBlockMarkdown.test.js` passed with the block present.

| Format                   | Server surface                                     | Verdict                                                                                                      |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| (a) Fenced JSON body     | None. Versioned, copied and restored with the page | **Chosen**                                                                                                   |
| (b) SVG or PNG asset     | Asset upload and `read:assets` rules               | Fallback for large boards, only if the source travels inside the file                                        |
| (c) Server row and route | A new table, three sequential fetches before paint | Rejected: it bypasses page history, approvals and page duplication, and a pasted block yields an empty board |

Why (a):

- It is the only option with no new server surface, no extra permission check and zero requests at
  view time.
- It round-trips byte for byte through the markdown renderer and the WYSIWYG node, including a body
  with a bare `::` line.
- Measured cost, compact single-line JSON: 20 strokes of 50 points is 11 kB (5 ms WYSIWYG round trip),
  200 of 100 is 208 kB (248 ms), 1000 of 100 is 1.04 MB (7.9 s). The round trip is superlinear, so the
  cost is real and needs a cap.

Costs of (a) that the follow-up must contain:

- Every save stores the drawing again in `pageHistory.content`.
- One very long line makes every history diff a whole-line change.
- The coordinates land in `searchContent`.
- Concurrent editing through the Yjs collaboration extension merging inside one long JSON line is
  untested.

Why not (b) first: a bare PNG or SVG is not re-editable, `sanitizeSvg` drops `<metadata>` so source
cannot be embedded there (`<desc>` survives), asset read is a separate rule from page read, and page
restore does not roll an asset back. Why not (c): `checklistExecutions` is a run log that deliberately
skips page history and approvals, which is right for a checklist and wrong for authored content, and
a new table would also collide with the flat base migration.

## Required changes

From #3735, for format (a). Nothing here has been made yet.

| Change                                                                                                                                      | File                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| None for the sanitizer: `blockAllowances` allows `block-whiteboard` and its declared props once the manifest exists and the site enables it | `backend/helpers/htmlSanitizePolicy.ts`            |
| Add `whiteboard` to the quiet-fence list, so an unmounted or disabled block does not show highlighted JSON                                  | `frontend/src/renderers/markdown.js` (`codeBlock`) |
| Exclude `pre.codeblock-whiteboard` from search text                                                                                         | `backend/models/rendering.ts` (`extractText`)      |
| Enforce the size cap on save, refusing rather than truncating                                                                               | `backend/models/rendering.ts` (`postProcess`)      |
| None for CSP: no directive change. `img-src` has no `blob:`, so previews use `data:`                                                        | `backend/base.yml` (`cspDirectives`)               |
| None for `bodyParserLimit` (5 MB)                                                                                                           | `backend/base.yml`                                 |

The two SVG items in #3735 (keep source in `<desc>`, allow `vector-effect`, `pointer-events` and
`font-weight`) apply only to inline SVG or format (b), so they are out of scope for the recommended
path.

**Size cap** (proposed by #3735 from the #3734 measurements): 256 KiB of body text per block, at most
2,000 strokes or 50,000 points, and 1 MiB across all whiteboard blocks on a page. Enforce it in three
places, since any one can be bypassed: the editor refuses further strokes, the block refuses to draw
past it and shows its error box, and the server refuses the save. Silently dropping strokes on save
destroys the author's drawing.

**View-time input is untrusted.** The JSON never passes the SVG allowlist, and any author can write
it. The block must not build SVG by interpolating JSON strings or through `unsafeSVG`. It uses Lit `svg`
templates or `createElementNS`, validates colours against a strict `#hex` shape and clamps
coordinates and widths to finite numbers.

## Follow-up build Feature

Recommended scope, in this order:

1. `blocks/block-whiteboard`: Lit element on `perfect-freehand`, pointer and pen input, read-only at
   view time, safe SVG construction, size refusal, dark mode via `DarkMode` (the white `.sheet` keeps
   ink legible in both themes, so no re-inking is needed).
2. Editor authoring: a stroke-capture surface in the page editor, the per-block cap, and a compact
   point encoding to keep bodies small.
3. The three server and renderer edits above, plus a backend test for the save-time cap.
4. Tests: block tests with jsdom, a `WikiBlock` round trip, and a hostile-JSON case for the view-time
   renderer.
5. An e2e under `security.enforceCsp` in the style of `e2e/tests/csp.spec.js`, which also closes
   #3733's unverified real-browser point.
6. A Yjs concurrent-edit check on a long JSON line before real-time editing is offered for this block.

Out of scope for the first build: shapes, text, arrows, a stencil library, an asset-backed export, and
any new table.

## No-go conditions

Reverse this to no-go if any of these turns out true:

- The Yjs check shows a concurrent edit corrupts the JSON body, and the block cannot be made
  single-editor.
- The cap cannot be held under about 250 ms for a full-size board in the WYSIWYG round trip.
- A full diagramming whiteboard is wanted. That is a different product: it needs Excalidraw and a
  CSP decision this record does not make.
