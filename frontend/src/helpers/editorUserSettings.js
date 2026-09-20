/**
 * @param {{ fontSize?: number } | null | undefined} userSettings
 * @param {number} [fallback] Mirrors `EditorMarkdownUserSettingsOverlay`'s own default, so a user
 *   who never opened that overlay gets the size a freshly-saved one there would produce.
 * @returns {number}
 */
export function resolveEditorFontSize(userSettings, fallback = 16) {
  return userSettings?.fontSize ?? fallback
}

/**
 * A saved preference wins at any window width, in both directions; only a user who has never saved
 * one falls back to the width check, since below `md` source and preview would each get half a
 * small window.
 *
 * @param {{ previewShown?: boolean } | null | undefined} userSettings
 * @param {boolean} isWideEnough Whether the viewport is at or above the `md` breakpoint
 * @returns {boolean}
 */
export function resolveInitialPreviewShown(userSettings, isWideEnough) {
  if (typeof userSettings?.previewShown === 'boolean') {
    return userSettings.previewShown
  }
  return isWideEnough
}

/**
 * `null` is the caller's cue to fall back to the stylesheet's responsive `50vw` rather than a
 * hardcoded pixel width. Anything not a finite positive number (`0`, negative, `NaN`, a string
 * from hand-edited settings) counts as never saved, not as a collapsed pane.
 *
 * @param {{ previewWidth?: number } | null | undefined} userSettings
 * @returns {number | null} Width in CSS pixels.
 */
export function resolveInitialPreviewWidth(userSettings) {
  const width = userSettings?.previewWidth
  return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : null
}
