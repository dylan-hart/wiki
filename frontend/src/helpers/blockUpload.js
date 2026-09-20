/**
 * Client-side pre-check for a custom block upload. Mirrors the two checks the backend can only fail
 * *after* receiving the whole file — the extension and the upload size limit — so the browser can
 * turn those down before spending a request on them. Everything else the backend rejects (no static
 * `definition`, a tag collision) needs the source parsed, so it stays server-side.
 */

/**
 * Used when the real configured limit could not be read: an admin without `manage:system` cannot
 * fetch `system/security`. Mirrors `security.uploadMaxFileSize` in `backend/base.yml`, the same
 * default `api/blocks.ts` falls back to — kept in sync by hand across the two workspaces.
 */
export const DEFAULT_MAX_BLOCK_UPLOAD_SIZE = 10485760

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
