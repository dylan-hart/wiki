/**
 * The images a site has of its own — its logo, its favicon and the backdrop of its login page.
 *
 * Uploading one is the same exchange whichever it is, and the accepted formats have to agree with
 * what the endpoint checks, so both live here rather than in each admin view that offers an upload.
 */

/** What the endpoint accepts, mirroring the formats it recognizes from the bytes themselves. */
export const SITE_IMAGE_TYPES = [
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]

/**
 * Ask for an image file.
 *
 * @returns The chosen file, or null if the picker was dismissed
 */
export function pickSiteImage() {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = SITE_IMAGE_TYPES.join(',')
    input.onchange = (ev) => resolve(ev.target.files?.[0] ?? null)
    // -> Dismissing the picker fires no `change` event, so the promise would otherwise never settle
    input.oncancel = () => resolve(null)
    input.click()
  })
}

/**
 * Whether a chosen file is one the endpoint will take. The picker's filter is a suggestion the user
 * can override, and the server checks the bytes anyway; asking here beats a 415 with nothing to
 * explain it.
 */
export function isAcceptedSiteImage(file) {
  return SITE_IMAGE_TYPES.includes(file.type)
}

/**
 * Replace one of a site's images.
 *
 * @param kind One of `logo`, `favicon` or `loginBg`
 */
export async function uploadSiteImage(siteId, kind, file) {
  // -> The image is the request body itself: the endpoint takes the raw file, not a form
  await API_CLIENT.put(`sites/${siteId}/images/${kind}`, {
    body: file,
    headers: {
      'content-type': file.type
    }
  }).json()
}

/**
 * Remove one of a site's images, leaving the built-in default in its place.
 */
export async function clearSiteImage(siteId, kind) {
  await API_CLIENT.delete(`sites/${siteId}/images/${kind}`).json()
}

/**
 * Whether the Sharp extension is usable on this server, which decides whether an uploaded image gets
 * resized and re-encoded or stored as-is. Site-independent, so a page asks once on mount rather than
 * on every load.
 *
 * A failed or slow `system/extensions` call answers `true`: the callers use this to raise a "this
 * needs Sharp" indicator, and understating a warning while its answer is still unknown beats crying
 * wolf over an unrelated request failure.
 *
 * @returns {Promise<boolean>}
 */
export async function isSharpAvailable() {
  try {
    const extensions = (await API_CLIENT.get('system/extensions').json()) ?? []
    return extensions.find((ext) => ext.key === 'sharp')?.isInstalled ?? false
  } catch {
    return true
  }
}
