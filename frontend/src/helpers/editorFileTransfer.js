/**
 * `.items` is the fallback for any browser that leaves `.files` empty for a pasted image while
 * still populating the item list -- without it such a paste is silently swallowed.
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

export function hasFiles(transfer) {
  return pastedFiles(transfer).length > 0
}

/*
  Text wins when both are on the clipboard: a spreadsheet or design tool puts a bitmap there
  ALONGSIDE the text, and answering those pastes with a screenshot would be infuriating.
*/
export function shouldClaimPaste(clipboardData) {
  if (!hasFiles(clipboardData)) {
    return false
  }
  return (clipboardData.getData('text/plain') ?? '').trim().length === 0
}

/**
 * Per the HTML Drag and Drop spec the payload is protected until `drop`, so `dataTransfer.files` is
 * empty during `dragover` and `hasFiles` alone would never open the drop target. `types` is
 * readable at that stage and must contain the literal `"Files"` for a native file drag.
 */
export function shouldAcceptDrag(dataTransfer) {
  return hasFiles(dataTransfer) || (dataTransfer?.types ?? []).includes('Files')
}
