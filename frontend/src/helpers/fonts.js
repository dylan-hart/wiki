/**
 * Live application of Admin → Theme's `baseFont` / `contentFont`, as two independent swaps:
 *
 *  - `baseFont` writes `--font-sans` on the document root, which Tailwind's Preflight applies to
 *    `html`, so it reaches the whole app.
 *  - `contentFont` writes `--font-content` in a `<style>` scoped under `.page-contents` rather than
 *    on the root, so a reader's content font never leaks into the surrounding chrome.
 *
 * `'user'` — and any other value this catalog doesn't recognise — means "no override": no
 * stylesheet is linked and the custom property is removed rather than set, leaving `tailwind.css`'s
 * own fallback stack in effect. Nothing ever requests a font literally named "user".
 */

import { replaceHeadStyle } from '@/helpers/headStyle'

/**
 * Keyed by the value stored in `theme.baseFont` / `theme.contentFont`. Mirrors `AdminTheme.vue`'s
 * `fonts` options (minus its `user` entry) and the families vendored under
 * `public/_assets/fonts/` — keep the three in sync.
 */
const FONT_CATALOG = {
  /*
    `display` is the condensed companion a family is DESIGNED to be set with, so picking Barlow is
    one admin choice rather than two that can be got wrong independently. A family without one
    clears `--font-display`, leaving `tailwind.css`'s stack in effect.
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
 * Condensed faces come first so a heading does not reflow from condensed to normal-width and back
 * while the webfont is in flight.
 */
const CONDENSED_FALLBACK = `'Roboto Condensed', 'Helvetica Neue Condensed', -apple-system, Helvetica, Arial, sans-serif`

/**
 * `tailwind.css`'s `--font-sans` stack minus its webfont, so a vendored font that fails or has not
 * finished loading degrades the way the system stack always has.
 */
const SYSTEM_FALLBACK = `-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif`

function fontFamilyValue(font) {
  return `'${font.family}', ${SYSTEM_FALLBACK}`
}

function applyFontStylesheets(baseFont, contentFont) {
  document.querySelectorAll('link[data-theme-font]').forEach((el) => el.remove())

  const needed = new Map()
  for (const key of [baseFont, contentFont]) {
    if (FONT_CATALOG[key]) {
      needed.set(key, FONT_CATALOG[key].href)
    }
  }
  /*
   * Only the BASE font's display companion: a display face is chrome, and the content column sets
   * headings from `--font-content`, never `--font-display`.
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

function applyContentFont(contentFont) {
  const font = FONT_CATALOG[contentFont]
  replaceHeadStyle(
    'theme-content-font',
    font && `.page-contents {\n  --font-content: ${fontFamilyValue(font)};\n}`
  )
}

/**
 * @param {string} baseFont `siteStore.theme.baseFont`, e.g. `'roboto'` or `'user'`.
 * @param {string} contentFont `siteStore.theme.contentFont`, e.g. `'inter'` or `'user'`.
 */
export function applyFonts(baseFont, contentFont) {
  applyFontStylesheets(baseFont, contentFont)
  applyBaseFont(baseFont)
  applyContentFont(contentFont)
}
