import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { AESTHETIC_DEFAULT_COLORS } from '../helpers/aestheticDefaults.js'

/**
 * The source-scan describe below reads as duplication of the token-pin tests. It exists anyway
 * because `cobaltTokens.test.js` pins the TOKENS in isolation and this pins what `PageToc.vue`'s OWN
 * rules do with them -- a rule pointed at the wrong token, or dropped, is invisible to the token pins.
 */

const componentDir = dirname(fileURLToPath(import.meta.url))
const componentSource = readFileSync(join(componentDir, 'PageToc.vue'), 'utf-8')

const styleMatch = componentSource.match(/<style>([\s\S]*?)<\/style>/)
if (!styleMatch) {
  throw new Error('PageToc.vue should still carry a `<style>` block')
}
const styleSource = styleMatch[1]

describe('PageToc.vue --page-toc-* token wiring (source)', () => {
  const cobaltStart = styleSource.indexOf('body.body--cobalt .page-toc {')
  const cobaltDarkStart = styleSource.indexOf('body.body--cobalt.body--dark .page-toc {')
  // -> Each of these two rules is a single, self-contained flat block, so the block's own next `\n}`
  //    is its real close
  const cobaltEnd = styleSource.indexOf('\n}', cobaltDarkStart) + 1
  expect(cobaltStart).toBeGreaterThan(-1)
  expect(cobaltDarkStart).toBeGreaterThan(cobaltStart)
  expect(cobaltEnd).toBeGreaterThan(cobaltDarkStart)

  const cobaltLightBlock = styleSource.slice(cobaltStart, cobaltDarkStart)
  const cobaltDarkBlock = styleSource.slice(cobaltDarkStart, cobaltEnd)

  it('routes Entry (d0) ink through --color-text-body', () => {
    expect(cobaltLightBlock).toMatch(/--page-toc-ink-strong:\s*var\(--color-text-body\);/)
  })

  it('routes Sub-entry (d1/d2, "same as d1" per the handoff) ink through --color-text-secondary', () => {
    expect(cobaltLightBlock).toMatch(/--page-toc-ink:\s*var\(--color-text-secondary\);/)
    expect(cobaltLightBlock).toMatch(/--page-toc-ink-soft:\s*var\(--color-text-secondary\);/)
  })

  it('routes the active row (§4.4) through --color-accent on --color-accent-wash, at weight 600, with a 5px plate', () => {
    expect(cobaltLightBlock).toMatch(/--page-toc-active-ink:\s*var\(--color-accent\);/)
    expect(cobaltLightBlock).toMatch(/--page-toc-active-surface:\s*var\(--color-accent-wash\);/)
    expect(cobaltLightBlock).toMatch(/--page-toc-active-weight:\s*600;/)
    expect(cobaltLightBlock).toMatch(/--page-toc-active-radius:\s*5px;/)
  })

  it('dark restates only the colour tokens (--color-*-dark), matching §5 ("dark restates colours only")', () => {
    expect(cobaltDarkBlock).toMatch(/--page-toc-active-ink:\s*var\(--color-accent-dark\);/)
    expect(cobaltDarkBlock).toMatch(/--page-toc-active-surface:\s*var\(--color-accent-wash-dark\);/)
  })

  it('never sets font-size/weight/line-height/letter-spacing/text-transform inside the Cobalt blocks (§2/§6 audit constraint)', () => {
    for (const block of [cobaltLightBlock, cobaltDarkBlock]) {
      expect(block).not.toMatch(
        /[\s;{](font-size|font-weight|line-height|letter-spacing|text-transform)\s*:/
      )
    }
  })
})

/**
 * Assembled beside the real, Tailwind-built `tailwind.css` so that every `var(--color-*)` /
 * `var(--font-*)` resolves to what the app itself ships, not to a hand-picked subset.
 */
async function buildStylesheets() {
  const appCss = await buildAppCss()
  return { appCss, componentCss: styleSource }
}

/**
 * The same markup shape `PageToc.vue`'s template renders, built by hand because this suite exercises
 * the compiled CSS directly rather than mounting the component -- keep it in step with the template.
 */
const SAMPLE = `
  <nav class="page-toc">
    <ul class="page-toc-list">
      <li class="page-toc-item page-toc-item--d0" style="--page-toc-depth:0">
        <a class="page-toc-link" href="#a">Introduction</a>
      </li>
      <li class="page-toc-item page-toc-item--d0 page-toc-item--active" style="--page-toc-depth:0">
        <a class="page-toc-link" href="#b">Usage</a>
      </li>
      <li class="page-toc-item page-toc-item--d1" style="--page-toc-depth:1">
        <a class="page-toc-link" href="#c">Basic usage</a>
      </li>
      <li class="page-toc-item page-toc-item--d2" style="--page-toc-depth:2">
        <a class="page-toc-link" href="#d">A finer point</a>
      </li>
    </ul>
  </nav>`

describe(
  'PageToc.vue Cobalt contents-rail typography (real browser, OpenProject #2978)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser
    let stylesheets

    /**
     * `--q-accent` is an admin-editable, runtime-resolved brand color carrying no static value in
     * `tailwind.css` beyond its Ledger fallback, so a bare compile resolves the active row's ink to
     * the wrong aesthetic's color; setting it inline reproduces what an unmodified Cobalt site
     * resolves it to. It has to land on `<html>` specifically, where `App.vue` sets it and where
     * `tailwind.css` declares `--color-accent: var(--q-accent)`: custom properties resolve to
     * computed values PER ELEMENT, so an override on `<body>` alone would arrive too late.
     */
    async function measure({ dark: darkMode = false } = {}) {
      const { appCss, componentCss } = stylesheets
      const page = await browser.newPage()
      try {
        const bodyClasses = ['body--cobalt', darkMode ? 'body--dark' : ''].filter(Boolean).join(' ')
        await page.setContent(
          `<!doctype html><html style="--q-accent: ${AESTHETIC_DEFAULT_COLORS.cobalt.colorAccent}">` +
            `<head><style>${appCss}</style><style>${componentCss}</style></head>` +
            `<body class="${bodyClasses}">${SAMPLE}</body></html>`
        )
        return await page.evaluate(() => {
          const styleOf = (selector) => getComputedStyle(document.querySelector(selector))
          const entry = styleOf('.page-toc-item--d0:not(.page-toc-item--active) .page-toc-link')
          const active = styleOf('.page-toc-item--d0.page-toc-item--active .page-toc-link')
          const sub1 = styleOf('.page-toc-item--d1 .page-toc-link')
          const sub2 = styleOf('.page-toc-item--d2 .page-toc-link')
          const pick = (s) => ({
            family: s.fontFamily,
            size: s.fontSize,
            weight: s.fontWeight,
            letterSpacing: s.letterSpacing,
            color: s.color
          })
          return {
            entry: {
              ...pick(entry),
              radius: entry.borderRadius
            },
            sub1: pick(sub1),
            sub2: pick(sub2),
            active: {
              ...pick(active),
              background: active.backgroundColor,
              radius: active.borderRadius
            }
          }
        })
      } finally {
        await page.close()
      }
    }

    beforeAll(async () => {
      browser = await chromium.launch()
      stylesheets = await buildStylesheets()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('draws Entry (d0) as 500 13px Barlow, --color-text-body, no tracking', async () => {
      const { entry } = await measure({ dark: false })
      expect(entry.family).toMatch(/^Barlow\b/)
      expect(entry.size).toBe('13px')
      expect(entry.weight).toBe('500')
      expect(entry.letterSpacing).toBe('normal')
      // -> --color-text-body Cobalt light, #1a2038
      expect(entry.color).toBe('rgb(26, 32, 56)')
    })

    it('draws Entry dark as the same face/size/weight, restating only colour (#e8ecff)', async () => {
      const { entry } = await measure({ dark: true })
      expect(entry.family).toMatch(/^Barlow\b/)
      expect(entry.size).toBe('13px')
      expect(entry.weight).toBe('500')
      expect(entry.color).toBe('rgb(232, 236, 255)')
    })

    it('draws Sub-entry (d1) as 400 12.5px Barlow, --color-text-secondary', async () => {
      const { sub1 } = await measure({ dark: false })
      expect(sub1.family).toMatch(/^Barlow\b/)
      expect(sub1.size).toBe('12.5px')
      expect(sub1.weight).toBe('400')
      // -> --color-text-secondary Cobalt light, #4a5580
      expect(sub1.color).toBe('rgb(74, 85, 128)')
    })

    it('draws Sub-entry dark (d1) at the same face/size/weight, restating only colour (#a7b3ea)', async () => {
      const { sub1 } = await measure({ dark: true })
      expect(sub1.size).toBe('12.5px')
      expect(sub1.weight).toBe('400')
      expect(sub1.color).toBe('rgb(167, 179, 234)')
    })

    it('draws d2 at 400 12px, "same as d1" colour in both themes', async () => {
      const light = await measure({ dark: false })
      const dark = await measure({ dark: true })
      expect(light.sub2.size).toBe('12px')
      expect(light.sub2.weight).toBe('400')
      expect(light.sub2.color).toBe(light.sub1.color)
      expect(dark.sub2.size).toBe('12px')
      expect(dark.sub2.color).toBe(dark.sub1.color)
    })

    it('marks the active row at 600 13px, accent text on the accent wash, with a 5px plate (§4.4)', async () => {
      const { active } = await measure({ dark: false })
      expect(active.size).toBe('13px')
      expect(active.weight).toBe('600')
      // -> --color-accent (Cobalt admin default #c8303c) on --color-accent-wash #ffe9eb
      expect(active.color).toBe('rgb(200, 48, 60)')
      expect(active.background).toBe('rgb(255, 233, 235)')
      expect(active.radius).toBe('5px')
    })

    it('marks the active row dark at the same weight/size, restating only colour (#ff8f97 on a translucent wash)', async () => {
      const { active } = await measure({ dark: true })
      expect(active.weight).toBe('600')
      expect(active.size).toBe('13px')
      // -> --color-accent-dark #ff8f97
      expect(active.color).toBe('rgb(255, 143, 151)')
      // -> --color-accent-wash-dark, rgb(255 77 90 / 0.16)
      expect(active.background).toBe('rgba(255, 77, 90, 0.16)')
    })

    /**
     * The radius must be a standing property of `.page-toc-link`, not something that only appears
     * alongside the active row's background -- otherwise the instant the active class is removed the
     * radius snaps to square while `background-color` is still fading out. Asserting it on a row that
     * was NEVER active is what proves it unconditional rather than left over from a prior state.
     */
    it('gives every row -- not only the active one -- the 5px plate radius, so it never has to snap in', async () => {
      const { entry } = await measure({ dark: false })
      expect(entry.radius).toBe('5px')
    })
  }
)
