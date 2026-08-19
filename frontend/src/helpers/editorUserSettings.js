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
