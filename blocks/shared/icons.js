import { html } from 'lit'

/**
 * Icons, for blocks.
 *
 * A block draws an icon from the same reference the rest of the app uses — `mdi:account-edit` — and
 * gets it from this instance's own `/_icons`, which serves the part of the Iconify API protocol the
 * frontend speaks. Nothing here reaches Iconify itself: the server is what decides whether an icon
 * can be had, and an instance that is offline still answers for every icon it has been asked for
 * before.
 *
 * Shared because more than one block needs it, and one cache across all of them means a page whose
 * every row carries the same icon asks for it once.
 */

/** Icons already fetched, by `prefix:name`. Holds the promise, so concurrent callers share a request. */
const iconCache = new Map()

/**
 * Fetch an icon as inline SVG.
 *
 * Inline rather than an `<img>` so the drawing takes the colour of whatever it sits in — Iconify's
 * SVGs paint with `currentColor`, which an image cannot see. The instance serves them from its own
 * `/_icons`, cached hard, so this is a local request.
 *
 * An empty string for anything that is not a `prefix:name` reference, an icon the server will not
 * serve, or a request that failed: a missing icon is a row without one, not a row that breaks.
 *
 * An `img:` reference is `iconImageUrl()`'s to resolve, not this function's — it names a file to
 * point an `<img>` at, not an Iconify icon to fetch, so it is rejected here before either the cache
 * or `/_icons` ever see it. This is the one place that check has to happen: every caller shares it
 * for free, and `''` is never written to `iconCache` for a reference that was never a fetch to begin
 * with.
 *
 * @param {string} reference An Iconify reference, e.g. `mdi:home`.
 * @returns {Promise<string>} The SVG markup, or an empty string.
 */
export async function fetchIcon(reference) {
  if (iconImageUrl(reference) !== null) {
    return ''
  }
  if (iconCache.has(reference)) {
    return iconCache.get(reference)
  }
  const [prefix, name] = reference.split(':')
  if (!prefix || !name) {
    return ''
  }
  const promise = fetch(`/_icons/${encodeURIComponent(prefix)}/${encodeURIComponent(name)}.svg`)
    .then((resp) => (resp.ok ? resp.text() : ''))
    .catch(() => '')
  iconCache.set(reference, promise)
  return promise
}

/**
 * The address an `img:` reference points at, or null for one that is not an image.
 *
 * The icon picker's other tab hands back `img:/_assets/icons/…`, which is a file to point an `<img>`
 * at rather than an icon to resolve — so it is the caller's to draw, and its colour is its own.
 *
 * @param {string} reference
 * @returns {string|null}
 */
export function iconImageUrl(reference) {
  return reference.startsWith('img:') ? reference.slice(4) : null
}

/**
 * The chrome glyphs a block draws for itself, as the path of a 24x24 MDI icon.
 *
 * Not everything goes through `fetchIcon` above: a block whose own controls carry icons -- the PDF
 * viewer's toolbar, the gallery's lightbox -- needs them on screen the moment it renders, and a
 * request in the way of that would show as a toolbar of empty buttons for as long as it took. These
 * are the handful of glyphs that costs, inlined once here rather than copied into each block (BLK-F8).
 *
 * An icon an author or administrator picked is a different thing entirely and still resolves through
 * `/_icons`: it is not knowable at build time, so it cannot live in a table like this one.
 */
export const MDI_PATHS = {
  previous: 'M15.41,16.58L10.83,12L15.41,7.41L14,6L8,12L14,18L15.41,16.58Z',
  next: 'M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z',
  close:
    'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
  zoomOut: 'M19,13H5V11H19V13Z',
  zoomIn: 'M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z',
  open: 'M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z'
}

/**
 * Draw one of the paths above.
 *
 * `aria-hidden`, and painted in `currentColor` by inheritance: the glyph is decoration on a control
 * that names itself, not content of its own.
 *
 * @param {string} path One of `MDI_PATHS`.
 */
export function inlineIcon(path) {
  return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" /></svg>`
}
