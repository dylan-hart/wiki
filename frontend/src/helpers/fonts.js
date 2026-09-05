/**
 * Live application of Admin → Theme's `baseFont` / `contentFont` selection.
 *
 * The two are independent runtime font-family swaps:
 *
 *  - `baseFont` writes `--font-sans` on the document root, which is what `tailwind.css`'s
 *    `@theme static` block feeds to Tailwind's Preflight (`html { font-family: var(--font-sans) }`)
 *    — so it reaches the whole app, exactly where `--font-sans` was already used before this module
 *    existed.
 *  - `contentFont` writes `--font-content` scoped under `.page-contents`, mirroring how
 *    `App.vue`'s `applyCodeBlocksTheme()` nests a highlight.js theme under the same selector: a
 *    `<style>` element with `.page-contents { --font-content: … }` rather than a property set on
 *    the root, so a reader's chosen content font never leaks into surrounding chrome (the sidebar,
 *    the header, admin screens). `_page-contents.scss` reads it as
 *    `font-family: var(--font-content, var(--font-sans))`, so with nothing selected the content
 *    column falls back to the same font as the rest of the app, not to the browser default.
 *
 * Only the stylesheet(s) actually selected are linked into `<head>` — the vendored assets from
 * `public/_assets/fonts/<key>/<key>.css` (task 715) — deduplicated when `baseFont` and
 * `contentFont` name the same font, so a site using one font everywhere downloads it once.
 *
 * `'user'` (and any other value this catalog doesn't recognise, e.g. an unset default) means "no
 * override": no stylesheet is linked for it, and the corresponding custom property is removed
 * rather than set to something. That leaves the fallback stack already declared in `tailwind.css`
 * (`--font-sans: 'Barlow', -apple-system, …`) — or, for content, the `var(--font-content,
 * var(--font-sans))` fallback — in effect. Nothing ever requests a font literally named "user".
 */

import { replaceHeadStyle } from '@/helpers/injectCss'

/**
 * Every self-hosted font the admin area's font pickers offer, keyed by the value stored in
 * `theme.baseFont` / `theme.contentFont`. Mirrors the `fonts` options array in `AdminTheme.vue`
 * (minus its `user` entry, which this module treats as "no override" rather than a real font) and
 * the families vendored under `public/_assets/fonts/` in task 715.
 */
const FONT_CATALOG = {
  /*
    `display` is the condensed companion a family is DESIGNED to be set with, and Barlow is the only
    entry that has one -- it is what makes the Cardinal pairing (Barlow Condensed headings over
    Barlow body copy) a single choice in the admin picker rather than two that can be got wrong
    independently. Its stylesheet is linked alongside the base family's and its name is written to
    `--font-display`; a family with no companion clears that property, leaving the fallback stack in
    `tailwind.css` in effect.
  */
  barlow: {
    family: 'Barlow',
    href: '/_assets/fonts/barlow/barlow.css',
    display: {
      family: 'Barlow Condensed',
      href: '/_assets/fonts/barlow-condensed/barlow-condensed.css'
    }
  },
  inter: { family: 'Inter', href: '/_assets/fonts/inter/inter.css' },
  opensans: { family: 'Open Sans', href: '/_assets/fonts/opensans/opensans.css' },
  montserrat: { family: 'Montserrat', href: '/_assets/fonts/montserrat/montserrat.css' },
  roboto: { family: 'Roboto', href: '/_assets/fonts/roboto/roboto.css' },
  rubik: { family: 'Rubik', href: '/_assets/fonts/rubik/rubik.css' },
  tajawal: { family: 'Tajawal', href: '/_assets/fonts/tajawal/tajawal.css' }
}

/**
 * The condensed tail of `tailwind.css`'s `--font-display` stack, reused after whichever display
 * family is actually selected -- same role as `SYSTEM_FALLBACK` below, but it keeps trying
 * CONDENSED faces first so a heading does not reflow from condensed to normal-width and back while
 * the webfont is in flight.
 */
const CONDENSED_FALLBACK = `'Roboto Condensed', 'Helvetica Neue Condensed', -apple-system, Helvetica, Arial, sans-serif`

/**
 * The non-webfont tail of `tailwind.css`'s existing `--font-sans` stack, reused as the fallback
 * after whichever family is actually selected so a vendored font that fails to load (or hasn't
 * finished loading) degrades the same way the system stack always has.
 */
const SYSTEM_FALLBACK = `-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif`

function fontFamilyValue(font) {
  return `'${font.family}', ${SYSTEM_FALLBACK}`
}

/**
 * Link the stylesheet(s) for whichever selections are actual fonts (`'user'` and unknown values
 * contribute none), replacing whatever this helper linked last time.
 */
function applyFontStylesheets(baseFont, contentFont) {
  document.querySelectorAll('link[data-theme-font]').forEach((el) => el.remove())

  const needed = new Map()
  for (const key of [baseFont, contentFont]) {
    if (FONT_CATALOG[key]) {
      needed.set(key, FONT_CATALOG[key].href)
    }
  }
  /*
   * Only the BASE font's display companion, and under its own `<key>-display` name so a caller can
   * still address either sheet: a display face is chrome, and the content column never sets headings
   * in it (`_page-contents.scss` reads `--font-content`, not `--font-display`).
   */
  const baseDisplay = FONT_CATALOG[baseFont]?.display
  if (baseDisplay) {
    needed.set(`${baseFont}-display`, baseDisplay.href)
  }
  for (const [key, href] of needed) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.dataset.themeFont = key
    document.head.appendChild(link)
  }
}

/**
 * Apply `baseFont` app-wide via `--font-sans` on the document root.
 */
function applyBaseFont(baseFont) {
  const font = FONT_CATALOG[baseFont]
  const root = document.documentElement
  if (!font) {
    root.style.removeProperty('--font-sans')
    root.style.removeProperty('--font-display')
    return
  }
  root.style.setProperty('--font-sans', fontFamilyValue(font))
  if (font.display) {
    root.style.setProperty('--font-display', `'${font.display.family}', ${CONDENSED_FALLBACK}`)
  } else {
    root.style.removeProperty('--font-display')
  }
}

/**
 * Apply `contentFont` scoped to `.page-contents` via a `--font-content` custom property, following
 * the same nested-`<style>` pattern `applyCodeBlocksTheme()` uses.
 */
function applyContentFont(contentFont) {
  const font = FONT_CATALOG[contentFont]
  replaceHeadStyle(
    'theme-content-font',
    font && `.page-contents {\n  --font-content: ${fontFamilyValue(font)};\n}`
  )
}

/**
 * Apply the site's `baseFont` and `contentFont` theme selections as independent, live font-family
 * swaps: link only the stylesheet(s) actually needed, then set (or clear) the two custom
 * properties they back.
 *
 * @param {string} baseFont `siteStore.theme.baseFont`, e.g. `'roboto'` or `'user'`.
 * @param {string} contentFont `siteStore.theme.contentFont`, e.g. `'inter'` or `'user'`.
 */
export function applyFonts(baseFont, contentFont) {
  applyFontStylesheets(baseFont, contentFont)
  applyBaseFont(baseFont)
  applyContentFont(contentFont)
}
