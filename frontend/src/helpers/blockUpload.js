/**
 * Client-side pre-check for a custom block upload (`BlockUploadDialog.vue`).
 *
 * Mirrors the two checks the backend can only fail *after* receiving the whole file — the extension
 * (a compiled block is always `component.js`) and the configured upload size limit — so the browser
 * can turn those down before spending a request on them. Everything else the backend rejects (no
 * static `definition`, a tag collision) can only be answered by the server, since it requires
 * parsing the source; those failures come back through the API response and are handled with
 * `apiErrorMessage`, not here.
 */

/**
 * Fallback max upload size, in bytes, when the real configured limit could not be read (an admin
 * without `manage:system` cannot fetch `system/security`, so this dialog treats it as best-effort).
 * Mirrors `security.uploadMaxFileSize` in `backend/base.yml`, the same default `api/blocks.ts` falls
 * back to server-side — kept in sync by hand since the two live in separate workspaces.
 */
export const DEFAULT_MAX_BLOCK_UPLOAD_SIZE = 10485760

/**
 * @param {{ name: string, size: number }|null|undefined} file A `File`, or anything shaped like one.
 * @param {number} [maxFileSize] In bytes. Non-positive means unlimited.
 * @returns {{ ok: true } | { ok: false, reason: 'missing' | 'extension' | 'size' }}
 */
export function validateBlockFile(file, maxFileSize = DEFAULT_MAX_BLOCK_UPLOAD_SIZE) {
  if (!file) {
    return { ok: false, reason: 'missing' }
  }
  if (!/\.js$/i.test(file.name)) {
    return { ok: false, reason: 'extension' }
  }
  if (maxFileSize > 0 && file.size > maxFileSize) {
    return { ok: false, reason: 'size' }
  }
  return { ok: true }
}
