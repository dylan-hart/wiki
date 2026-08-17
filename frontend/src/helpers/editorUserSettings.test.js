import { describe, expect, it } from 'vitest'

import { resolveEditorFontSize, resolveInitialPreviewShown } from './editorUserSettings.js'

describe('resolveEditorFontSize()', () => {
  it('uses the saved font size when there is one', () => {
    expect(resolveEditorFontSize({ fontSize: 22 })).toBe(22)
  })

  it('falls back to 16 when nothing was ever saved', () => {
    expect(resolveEditorFontSize({})).toBe(16)
    expect(resolveEditorFontSize(null)).toBe(16)
    expect(resolveEditorFontSize(undefined)).toBe(16)
  })

  it('accepts an explicit fallback', () => {
    expect(resolveEditorFontSize({}, 20)).toBe(20)
  })
})

describe('resolveInitialPreviewShown()', () => {
  it('honors a saved preference at any window width', () => {
    expect(resolveInitialPreviewShown({ previewShown: false }, true)).toBe(false)
    expect(resolveInitialPreviewShown({ previewShown: true }, false)).toBe(true)
  })

  it('falls back to the width check when no preference was ever saved', () => {
    expect(resolveInitialPreviewShown({}, true)).toBe(true)
    expect(resolveInitialPreviewShown({}, false)).toBe(false)
    expect(resolveInitialPreviewShown(null, true)).toBe(true)
    expect(resolveInitialPreviewShown(undefined, false)).toBe(false)
  })
})
