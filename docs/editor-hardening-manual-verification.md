# Manual verification: CodeLens providers, paste, and drag-and-drop

Task 481 (Feature 364, "Markdown/Monaco Editor Hardening"). Covers the "Edit Table" / "Edit Block
Parameters" CodeLens providers, image/file paste, file drag-and-drop onto the editor, and
`EditorCodeBlockMenu.vue`'s filter + Enter-selects-first flow, all in `EditorMarkdown.vue`.

## What this pass actually is

The task asks for a structured pass "in Chrome, Firefox, and Safari" — this run has no GUI browser
available (headless sandbox; Playwright's own browser-binary installer here only provisions
Chromium, and there is no way to drive the real Safari application at all, headless or otherwise).
So the two things that genuinely need a human at a real browser — literal OS clipboard image
paste/OS file drag, and eyeballing where Monaco actually draws a lens — are recorded below as an
**open item**, not silently skipped or fabricated as "verified."

What could legitimately be done without one: every decision this code makes that is pure logic over
plain data (does the lens appear for this table/block, does this paste get claimed, does this
dragover get accepted, what does Enter select) has been extracted to unit-testable functions and
locked down with real, passing regression tests — none of that existed before this task. And the one
mechanism the task specifically flags as fragile (the capture-phase paste listener) was read in full
and checked against the DOM Level 3 Events spec, which is what follows.

## Code audit findings

**No confirmed cross-browser bug.** Specifically checked:

- **Capture-phase paste listener** (`pasteCaptureNode.addEventListener('paste', onEditorPaste,
  true)`, one element above Monaco's own container). Capture-phase ordering (outside-in, this
  listener before Monaco's `CopyPasteController`) is standard DOM Level 3 Events behavior, identical
  in Chromium, Firefox and WebKit — nothing here depends on a Chromium-only API the way
  `:host-context()` did for the blocks (see `blocks/shared/theme.js`'s header comment, which this
  task's own description points at). This part is structurally sound in all three engines.
- **`dragover`'s empty-`files` quirk.** `dataTransfer.files` is empty during `dragenter`/`dragover`
  in every browser (drag payload access is spec-restricted until `drop`), not a Firefox-only
  oddity — and the existing code already falls back to `dataTransfer.types.includes('Files')` for
  exactly this reason (`onEditorDragOver`, now `shouldAcceptDrag`). Confirmed correct by inspection
  and now pinned by `editorFileTransfer.test.js`.
- **What could NOT be confirmed without a real browser**: whether `ClipboardEvent.clipboardData.files`
  is actually populated for an image copied from the OS (a screenshot tool, Preview, a design app) in
  Safari and Firefox the same way it is in Chromium. This is the one place real OS-to-web-API bridging
  is involved rather than this codebase's own logic, and it is exactly the kind of thing that can go
  silently wrong in exactly the two engines the task's own coordination note warns about. **This is
  the residual open item** — a human with Safari and Firefox needs to actually copy an image and paste
  it into the editor once each. If it silently no-ops (nothing inserted, no console error), the fix is
  almost certainly in `onEditorPaste`/`shouldClaimPaste` reading `clipboardData.items` as a fallback
  where `.files` comes back empty, since `.items` has broader historical support for pasted images
  than `.files` does.
- **`editor.getTargetAtClientPoint(event.clientX, event.clientY)`** on drop (cursor-follows-drop-point):
  `clientX`/`clientY` are ordinary `DragEvent` fields with no cross-engine variance; nothing
  Monaco-internal here is browser-conditional either.
- **CodeLens providers** (`findEditableTables`/`hasEditableParams` gating what
  `registerCodeLensProvider` offers): this is this codebase's own filtering logic, evaluated once
  against the document text — Monaco then draws a lens per returned range the same way regardless of
  engine. The filtering itself is now covered by `markdownTable.test.js` / `markdownBlocks.test.js`
  (multi-line cell, `^^` rowspan, fenced-code-block, headerless MultiMarkdown, second-body table; a
  block with no definition, an empty `props` list, a child block). What was **not** re-verified here
  is Monaco's own lens *rendering position* in each engine — that is Monaco's code, not this
  repository's, and out of scope for a code audit.

## New automated coverage added

All net-new, all passing (`npx vitest run` from `frontend/`):

| File | Covers |
| --- | --- |
| `frontend/src/helpers/markdownTable.test.js` | `findEditableTables` — the exact "editable" boundary the Edit Table lens uses: ordinary/headerless tables found; multi-line-cell, `^^`-rowspan, fenced-code-block, and second-body tables excluded; multiple tables in one document. |
| `frontend/src/helpers/markdownBlocks.test.js` | `findBlocks`, the new `hasEditableParams`, `blockValues`, `blockOpeningLine` — the Edit Block Parameters lens's gating (no definition / empty `props` / a tabset child → no lens) plus the pre-fill/write-back round trip. |
| `frontend/src/helpers/editorFileTransfer.js` + `.test.js` | New pure module, extracted from `EditorMarkdown.vue`: `shouldClaimPaste` (image-with-text → text wins; image-without-text and non-image-file → claimed; blank/whitespace-only text/plain entry → image still wins) and `shouldAcceptDrag` (the dragover files-empty fallback above). |
| `frontend/src/components/EditorCodeBlockMenu.test.js` | Full mount (not shallow) of the real menu: common-languages shortlist vs. full list, label/id/alias filtering, no-results state, Enter selects the first common entry unfiltered and the first *filtered* match once typing, Enter no-ops on zero matches, filter resets on reopen. |

## Reopening pre-filled (Edit Table / Edit Block Parameters)

Reviewed by inspection, no test added (these are UI-heavy overlays/dialogs, not pure logic):
`editTable`/`editBlock` in `EditorMarkdown.vue` re-look-up the table/block from the *current* model
text at click time (not from the lens's original arguments) — correct, since a lens is provided once
and the document may have changed since. `TableEditorOverlay.vue` reads `siteStore.overlayOpts.source`
straight through `parseTable`; `BlockParamsDialog.vue` receives `values` computed by `blockValues`
(written attribute, or the prop's own default) as a `props.values` copy, so cancelling leaves the page
untouched. No bug found in either path.

## Bottom line

Nothing was found broken enough to fix, and nothing here is a Chromium-only implementation the way
`:host-context()` was — the mechanisms are DOM-spec-standard, not engine-specific tricks. The one
remaining unknown (OS clipboard image paste actually reaching `clipboardData.files` in Safari and
Firefox) is a real gap in this run's coverage, not a swept-under-the-rug one — recorded here rather
than assumed passing.
