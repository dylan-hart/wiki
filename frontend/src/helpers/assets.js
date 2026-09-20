/**
 * How a page's source points at an uploaded file: from the site root, so a page that later moves to
 * another folder keeps pointing at the same picture, which a page-relative path would not. `fileSrc`
 * (`renderers/htmlImages.js`) resolves it to the `/_files/` URL at render time, so what is stored is
 * a readable path rather than the shape this instance happens to serve files under.
 */

/** `folderPath` carries no leading or trailing slash of its own; empty means the site root. */
export function assetPath(folderPath, fileName) {
  return folderPath ? `/${folderPath}/${fileName}` : `/${fileName}`
}

/** Matches the route `backend/controllers/files.ts` serves uploads under. */
export const FILES_PREFIX = '/_files/'

/**
 * What `assetPath` resolves to, for anything handing a file straight to a browser: a link to copy,
 * an `<img>` built outside the renderer. Writing this into a page's source instead would nail the
 * content to the shape this server happens to serve files under.
 */
export function assetUrl(folderPath, fileName) {
  return `${FILES_PREFIX}${folderPath ? `${folderPath}/${fileName}` : fileName}`
}
