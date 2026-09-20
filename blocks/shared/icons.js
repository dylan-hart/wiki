import { html } from 'lit'

/**
 * A block draws an icon from the same `prefix:name` reference the rest of the app uses, served by
 * this instance's own `/_icons`. Nothing here reaches Iconify itself: the server decides whether an
 * icon can be had, and an offline instance still answers for every icon asked for before.
 */

/** By `prefix:name`, holding the promise, so concurrent callers share one request. */
const iconCache = new Map()

/**
 * Inline SVG rather than an `<img>` so the drawing takes the colour of whatever it sits in —
 * Iconify's SVGs paint with `currentColor`, which an image cannot see.
 *
 * An empty string for anything that is not a `prefix:name` reference, an icon the server will not
 * serve, or a request that failed: a missing icon is a row without one, not a row that breaks.
 *
 * An `img:` reference is `iconImageUrl()`'s to resolve, and is refused before the cache or `/_icons`
 * see it — `''` cached under it would poison every later read of that reference, since nothing
 * records why an entry is empty.
 *
 * @param {string} reference An Iconify reference, e.g. `tabler:home`.
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
 * The icon picker's other tab hands back `img:/_assets/icons/…`, which is a file to point an `<img>`
 * at rather than an icon to resolve — so it is the caller's to draw, and its colour is its own.
 */
export function iconImageUrl(reference) {
  return reference.startsWith('img:') ? reference.slice(4) : null
}

/**
 * A block's own chrome -- a toolbar, a lightbox -- needs its glyphs on screen the moment it renders,
 * and a `fetchIcon` request in the way of that shows as empty buttons for as long as it takes, so
 * those few paths (24x24 MDI) are inlined here.
 *
 * An icon an author or administrator picked is not knowable at build time and still resolves through
 * `/_icons`.
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
 * `aria-hidden`, and painted in `currentColor` by inheritance: the glyph is decoration on a control
 * that names itself, not content of its own.
 *
 * @param {string} path One of `MDI_PATHS`.
 */
export function inlineIcon(path) {
  return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" /></svg>`
}
