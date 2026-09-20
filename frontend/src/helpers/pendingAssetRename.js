/**
 * Renaming a pending (not-yet-uploaded) asset. Its extension is fixed -- derived from the file's
 * actual type when it was queued (`editorStore.addPendingAsset`), not from anything a user types --
 * so every function here only touches the base half and rejoins it with the extension it found.
 */

/**
 * A name with no dot at all, or one that starts with a dot (a dotfile), has no extension to protect
 * and is treated as pure base.
 */
export function splitBaseName(fileName) {
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0) {
    return { base: fileName, ext: '' }
  }
  return { base: fileName.slice(0, dotIndex), ext: fileName.slice(dotIndex + 1) }
}

/** Leaves room for the extension under the 255-char limit the backend's `assets.fileName` has. */
const MAX_BASE_NAME_LENGTH = 200

/**
 * Deliberately mirrors `backend/models/assets.ts`'s `sanitizeFileName`, including reducing a path
 * to its last segment the way `path.basename` does (a pasted `../../etc/passwd` becomes `passwd`,
 * not a mangled join). Not because this value is trusted -- the upload re-sanitizes it regardless
 * -- but so what a reader accepts here is what they see stored once the asset lands.
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

export function validateBaseName(sanitized) {
  if (!sanitized) {
    return 'File name cannot be empty.'
  }
  return null
}

/**
 * `sanitizeBaseName` only ever sees the base half, so a base ending in a dot ("report.") joins with
 * the extension's own leading dot into a doubled dot ("report..png") that neither half's sanitizing
 * alone catches. The backend's `sanitizeFileName` collapses that on upload regardless, against the
 * whole assembled name, so the same collapse runs here -- otherwise this pane shows a name the
 * upload silently stores under a different one.
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
