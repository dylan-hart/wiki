/**
 * Whether a paste or a drag/drop is carrying files, and whether the editor should claim it.
 *
 * Pulled out of `EditorMarkdown.vue` as plain functions over a `DataTransfer`-shaped object so the
 * decision itself — as opposed to the Monaco/DOM plumbing that reaches it — is unit-testable without
 * a real browser, a real editor, or a real clipboard/drag event. See task 481 (Feature 364): this is
 * the automatable slice of what is otherwise a manual cross-browser pass, covering exactly the
 * behaviors that pass exercises by hand — text winning over an accompanying image, a non-image file
 * still being claimed, and `dragover`'s files-are-empty-until-drop quirk.
 */

/**
 * The actual `File` objects a paste or drop is carrying.
 *
 * `.files` is the fast path and is what a current desktop paste/drop populates. `.items`
 * (`DataTransferItemList`) is the historically broader-supported fallback -- entries typed `'file'`
 * resolve to the same `File` via `getAsFile()` -- read only when `.files` comes back empty. This is
 * the defensive fix for the cross-browser gap flagged during the original editor-hardening pass (task
 * 481, Feature 364) and resolved here (OpenProject #2450): a browser whose paste event ever leaves
 * `clipboardData.files` empty for a pasted image while still populating `.items` would otherwise
 * silently swallow the paste rather than insert it.
 */
export function pastedFiles(transfer) {
  if (transfer?.files?.length) {
    return Array.from(transfer.files)
  }
  if (!transfer?.items) {
    return []
  }
  return Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean)
}

/** Whether a paste or drop is carrying files, as opposed to text. */
export function hasFiles(transfer) {
  return pastedFiles(transfer).length > 0
}

/*
  Pasting a file inserts it; pasting anything else is left alone.

  Text wins when both are on the clipboard. Copying from a spreadsheet or a design tool puts a bitmap
  there ALONGSIDE the text, and an editor that answered those pastes with a screenshot would be
  infuriating -- so the image is only taken when there is no text to prefer.
*/
export function shouldClaimPaste(clipboardData) {
  if (!hasFiles(clipboardData)) {
    return false
  }
  return (clipboardData.getData('text/plain') ?? '').trim().length === 0
}

/**
 * Whether a `dragover` should be accepted as a valid file-drop target.
 *
 * `dataTransfer.files` is empty during `dragenter`/`dragover` in every browser -- the drag payload
 * itself is protected until `drop`, per the HTML Drag and Drop spec -- so `hasFiles` alone would never
 * open the drop target at all. `types` IS readable at that stage and is required by spec to contain
 * the literal string `"Files"` when a native file is being dragged, in Chromium, Firefox and WebKit
 * alike, which is what makes it the reliable check here.
 */
export function shouldAcceptDrag(dataTransfer) {
  return hasFiles(dataTransfer) || (dataTransfer?.types ?? []).includes('Files')
}
