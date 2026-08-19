/**
 * The Monaco font size to open the Markdown editor at.
 *
 * The user's saved preference when there is one, `EditorMarkdownUserSettingsOverlay`'s own default
 * otherwise -- so a user who has never opened that overlay gets the exact same size a freshly-saved
 * one there would produce, rather than a second hardcoded number to keep in sync with it.
 *
 * @param {{ fontSize?: number } | null | undefined} userSettings This user's saved Markdown editor settings
 * @param {number} [fallback] Used when no size was ever saved
 * @returns {number}
 */
export function resolveEditorFontSize(userSettings, fallback = 16) {
  return userSettings?.fontSize ?? fallback
}

/**
 * Whether the preview pane should be open on first mount.
 *
 * The user's saved preference wins outright, at any window width -- a saved `false` stays closed on
 * a wide monitor, and a saved `true` stays open on a narrow one. Only a user who has never saved a
 * preference falls back to the width check: `isWideEnough` is the app's `md` breakpoint (1024px, see
 * `useMinWidth` in `composables/screen.js`), below which the source and the preview would each get
 * half a small window, so the pane defaults shut and is opened deliberately from the toolbar.
 *
 * @param {{ previewShown?: boolean } | null | undefined} userSettings This user's saved Markdown editor settings
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
 * The preview pane's width to open at, in CSS pixels.
 *
 * `null` means "no saved preference" -- the caller's cue to fall back to the SCSS default (a
 * responsive `50vw`) rather than a hardcoded pixel number, so a user who has never dragged the
 * resize divider keeps getting the same width-of-viewport behaviour this editor always had. Only a
 * finite, positive number saved by a real drag is honoured; anything else (missing, `0`, negative,
 * `NaN`, a stray string from hand-edited settings) is treated the same as "never saved" rather than
 * producing a collapsed or invalid pane width.
 *
 * @param {{ previewWidth?: number } | null | undefined} userSettings This user's saved Markdown editor settings
 * @returns {number | null}
 */
export function resolveInitialPreviewWidth(userSettings) {
  const width = userSettings?.previewWidth
  return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : null
}
