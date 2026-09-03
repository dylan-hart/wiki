import { describe, expect, it } from 'vitest'

import { hasFiles, pastedFiles, shouldAcceptDrag, shouldClaimPaste } from './editorFileTransfer'

/** A minimal DataTransfer-shaped stand-in -- only the members these functions actually read. */
function transfer({ files = [], text = '', types = [], items } = {}) {
  return {
    files,
    types,
    items,
    getData: (kind) => (kind === 'text/plain' ? text : '')
  }
}

/** A minimal DataTransferItem-shaped stand-in. */
function fileItem(file) {
  return { kind: 'file', getAsFile: () => file }
}
function stringItem() {
  return { kind: 'string', getAsFile: () => null }
}

const IMAGE_FILE = new File(['x'], 'screenshot.png', { type: 'image/png' })
const PDF_FILE = new File(['x'], 'manual.pdf', { type: 'application/pdf' })

describe('pastedFiles', () => {
  it('returns an empty array for a transfer with neither files nor items, or none at all', () => {
    expect(pastedFiles(transfer({ files: [] }))).toEqual([])
    expect(pastedFiles(null)).toEqual([])
    expect(pastedFiles(undefined)).toEqual([])
  })

  it('reads from `.files` when populated, ignoring `.items` entirely', () => {
    expect(pastedFiles(transfer({ files: [IMAGE_FILE], items: [fileItem(PDF_FILE)] }))).toEqual([
      IMAGE_FILE
    ])
  })

  /*
    The cross-browser gap this exists for (OpenProject #2450): if a browser's paste event ever leaves
    `clipboardData.files` empty for a pasted image while still populating `.items` -- the historically
    broader-supported clipboard surface -- reading `.files` alone would silently swallow the paste.
  */
  it('falls back to `.items` when `.files` is empty', () => {
    expect(pastedFiles(transfer({ files: [], items: [fileItem(IMAGE_FILE)] }))).toEqual([
      IMAGE_FILE
    ])
  })

  it('filters out non-file items from the `.items` fallback', () => {
    expect(
      pastedFiles(transfer({ files: [], items: [stringItem(), fileItem(IMAGE_FILE)] }))
    ).toEqual([IMAGE_FILE])
  })

  it('filters out a file-kind item whose `getAsFile()` returns null', () => {
    expect(
      pastedFiles(transfer({ files: [], items: [{ kind: 'file', getAsFile: () => null }] }))
    ).toEqual([])
  })

  it('returns an empty array when `.files` is empty and there is no `.items` either', () => {
    expect(pastedFiles(transfer({ files: [] }))).toEqual([])
  })
})

describe('hasFiles', () => {
  it('is false for a transfer with no files, or none at all', () => {
    expect(hasFiles(transfer({ files: [] }))).toBe(false)
    expect(hasFiles(null)).toBe(false)
    expect(hasFiles(undefined)).toBe(false)
  })

  it('is true once a file is present', () => {
    expect(hasFiles(transfer({ files: [IMAGE_FILE] }))).toBe(true)
  })

  it('is true via the `.items` fallback when `.files` is empty', () => {
    expect(hasFiles(transfer({ files: [], items: [fileItem(IMAGE_FILE)] }))).toBe(true)
  })
})

describe('shouldClaimPaste', () => {
  it('is false for a plain-text paste carrying no files', () => {
    expect(shouldClaimPaste(transfer({ text: 'hello' }))).toBe(false)
  })

  it('claims a paste carrying only an image and no text', () => {
    expect(shouldClaimPaste(transfer({ files: [IMAGE_FILE] }))).toBe(true)
  })

  it('claims a paste carrying a non-image file', () => {
    expect(shouldClaimPaste(transfer({ files: [PDF_FILE] }))).toBe(true)
  })

  /*
    The documented behavior `onEditorPaste` exists to preserve: copying out of a spreadsheet or a
    design tool puts an image on the clipboard ALONGSIDE the text, and text wins so the paste is not
    silently answered with a screenshot instead of the text the author meant to paste.
  */
  it('lets text win when an image is on the clipboard alongside it', () => {
    expect(shouldClaimPaste(transfer({ files: [IMAGE_FILE], text: 'from the spreadsheet' }))).toBe(
      false
    )
  })

  it('still lets text win when the accompanying file is not an image', () => {
    expect(shouldClaimPaste(transfer({ files: [PDF_FILE], text: 'see attached' }))).toBe(false)
  })

  it('is false when the plain-text entry is present but blank/whitespace-only', () => {
    // -> Some sources (e.g. an OS screenshot tool) put an empty text/plain entry on the clipboard
    //    alongside the image; that is not text to prefer, so the image still wins.
    expect(shouldClaimPaste(transfer({ files: [IMAGE_FILE], text: '   ' }))).toBe(true)
  })
})

describe('shouldAcceptDrag', () => {
  it('accepts a drop target with no files/types (nothing to claim, dragover no-ops)', () => {
    expect(shouldAcceptDrag(transfer())).toBe(false)
  })

  /*
    The cross-browser case this function exists for: `dataTransfer.files` is empty on `dragover` in
    Chrome, Firefox AND Safari alike (drag payload access is spec-restricted until `drop`), so a check
    that only looked at `.files` would never accept a single drag anywhere -- `types` is what carries
    the signal at that stage.
  */
  it('accepts a dragover with an empty `files` array but "Files" listed in `types`', () => {
    expect(shouldAcceptDrag(transfer({ files: [], types: ['Files'] }))).toBe(true)
  })

  it('accepts a dragover where files happen to be readable too', () => {
    expect(shouldAcceptDrag(transfer({ files: [IMAGE_FILE], types: ['Files'] }))).toBe(true)
  })

  it('rejects a plain text/URL drag (no file involved)', () => {
    expect(shouldAcceptDrag(transfer({ types: ['text/plain'] }))).toBe(false)
  })
})
