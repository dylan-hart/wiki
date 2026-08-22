/**
 * Renaming a pending (not-yet-uploaded) asset before it uploads (OpenProject #878).
 *
 * The extension is fixed -- derived from the file's actual type when it was queued
 * (`editorStore.addPendingAsset`), not from anything a user types -- so every function here only
 * ever touches the base half of the name and rejoins it with the extension it found.
 */

/**
 * Split a pending asset's stored file name into its editable base and its fixed extension.
 *
 * `lastIndexOf` rather than a regex: a name with no dot at all (or one that starts with a dot, e.g.
 * a dotfile) has no extension to protect, so it is treated as pure base with nothing to keep fixed.
 */
export function splitBaseName(fileName) {
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0) {
    return { base: fileName, ext: '' }
  }
  return { base: fileName.slice(0, dotIndex), ext: fileName.slice(dotIndex + 1) }
}

/** Long enough for any real title, short enough to leave room for the extension under the 255-char
 *  limit the backend itself enforces (`db/schema.ts`'s `assets.fileName` / `sanitizeFileName`). */
const MAX_BASE_NAME_LENGTH = 200

/**
 * Reduce a user-typed base name to something safe to store and later re-upload as part of a file
 * name.
 *
 * Deliberately mirrors `backend/models/assets.ts`'s `sanitizeFileName`: a path is reduced to its
 * last segment exactly the way `path.basename` does (a pasted `../../etc/passwd` becomes `passwd`,
 * not a mangled join of every segment), then that segment is lowercased, whitespace is collapsed to
 * dashes, everything outside `[a-z0-9._-]` is stripped, and no leading or doubled dots survive. Not
 * because this value is trusted -- the upload re-sanitizes it regardless -- but so what a reader
 * accepts here is what they actually see stored rather than a surprise once the asset lands.
 */
export function sanitizeBaseName(input) {
  const lastSegment = String(input ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .pop()
  return lastSegment
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/g, '-')
    .replaceAll(/[^a-z0-9._-]/g, '')
    .replace(/^\.+/, '')
    .replaceAll(/\.{2,}/g, '.')
    .slice(0, MAX_BASE_NAME_LENGTH)
}

/** Whether a sanitized base name may be committed -- `null` when it may, an explanation when not. */
export function validateBaseName(sanitized) {
  if (!sanitized) {
    return 'File name cannot be empty.'
  }
  return null
}

/**
 * Rename a pending asset's file name, keeping its extension fixed.
 *
 * `sanitizeBaseName` only ever sees the base half, so a base ending in a dot (e.g. the user typed
 * "report.") joins with the extension's own leading dot into a doubled dot ("report..png") that
 * neither half's sanitizing alone catches. `backend/models/assets.ts`'s `sanitizeFileName` collapses
 * that on upload regardless (it runs against the whole assembled name), which would otherwise leave
 * this pane showing a name the upload silently stores under a different one -- so the same collapse
 * is re-run here, against the full joined string, to keep what is displayed and what would upload in
 * agreement before that ever happens.
 *
 * @param {string} fileName The pending asset's current, fully-extensioned file name.
 * @param {string} newBaseInput Whatever the user typed as the new base name.
 * @returns {{ ok: true, fileName: string } | { ok: false, error: string }}
 */
export function renameFileName(fileName, newBaseInput) {
  const { ext } = splitBaseName(fileName)
  const sanitized = sanitizeBaseName(newBaseInput)
  const error = validateBaseName(sanitized)
  if (error) {
    return { ok: false, error }
  }
  const joined = ext ? `${sanitized}.${ext}` : sanitized
  return { ok: true, fileName: joined.replaceAll(/\.{2,}/g, '.') }
}
