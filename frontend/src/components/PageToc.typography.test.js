import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileStringAsync } from 'sass'

import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'
import { AESTHETIC_DEFAULT_COLORS } from '../helpers/aestheticDefaults.js'

/**
 * OpenProject #2978 ("Cobalt typography: contents rail (`PageToc.vue`)"), the "Contents rail" row of
 * `ui-iteration-cobalt-typography/cobalt-typography.md` §3. That table's four roles -- eyebrow,
 * entry, entry-active, sub-entry -- split across two owners: the eyebrow ("Contents" / "Tags" /
 * "Revision") is `Index.vue`'s shared `.page-sidebar-heading` rule, already fixed by sibling Bug
 * #2967 (round 1) and out of scope here; the other three are this file's own `.page-toc-item--d0` /
 * `--d1` / `--d2` ramp plus the §4.4 active-row swap, which is what this suite pins.
 *
 * Source reading found every one of those three roles already resolving to the spec's exact values
 * through the existing `--page-toc-*` custom-property wiring (cross-checked against `tailwind.css`'s
 * Cobalt token block, itself pinned by `cobaltTokens.test.js`) -- so this is regression coverage for
 * an already-correct component, not a fix. The source-scan describe below reads as duplication with
 * the token-pin tests; it exists anyway because `cobaltTokens.test.js` pins the TOKENS in isolation
 * and this pins what `PageToc.vue`'s OWN rules do with them, which is the thing that can drift (a
 * rule pointed at the wrong token, or dropped) without the token pins ever noticing.
 */

const componentDir = dirname(fileURLToPath(import.meta.url))
const componentSource = readFileSync(join(componentDir, 'PageToc.vue'), 'utf-8')

const styleMatch = componentSource.match(/<style lang="scss">([\s\S]*?)<\/style>/)
if (!styleMatch) {
  throw new Error('PageToc.vue should still carry a `<style lang="scss">` block')
}
const styleSource = styleMatch[1]

describe('PageToc.vue --page-toc-* token wiring (source)', () => {
  const cobaltStart = styleSource.indexOf('@at-root body.body--cobalt &')
  const cobaltDarkStart = styleSource.indexOf('@at-root body.body--cobalt.body--dark &')
  const cobaltEnd = styleSource.indexOf('@at-root .body--dark &')
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
 * `PageToc.vue`'s `<style lang="scss">` block is un-scoped, global CSS reaching for bare `$grey-*`
 * palette constants -- it needs the same `@use '.../_theme.scss' as *; @use '.../_palette.scss' as
 * *;` injection `vite.config.js`'s `css.preprocessorOptions.scss.additionalData` performs at build
 * time, mirrored here the same way `Index.contentWidth.test.js#indexPageCss()` does for `Index.vue`'s
 * own un-scoped block. Compiled beside the real, Tailwind-built `tailwind.css` (`buildAppCss()`) so
 * every `var(--color-*)` / `var(--font-*)` resolves to what the app itself ships, not a hand-picked
 * subset.
 */
async function buildStylesheets() {
  const [appCss, component] = await Promise.all([
    buildAppCss(),
    compileStringAsync(
      `@use 'css/_theme.scss' as *; @use 'css/_palette.scss' as *;\n${styleSource}`,
      {
        loadPaths: [join(componentDir, '..')]
      }
    )
  ])
  return { appCss, componentCss: component.css }
}

/**
 * The list `PageToc.vue`'s template renders for one top-level entry (active and not), one d1
 * sub-entry and one d2 sub-sub-entry -- the same markup shape as its `<template>` (`item.depth` on
 * `--page-toc-depth`, `page-toc-item--active` alongside `page-toc-item--d0`), built by hand since this
 * suite exercises the compiled CSS directly rather than mounting the component.
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
     * `--q-accent` is an admin-editable, runtime-resolved brand color (`App.vue#applyTheme()`, via
     * `helpers/aestheticDefaults.js#resolveAestheticColors`) -- it carries no static value in
     * `tailwind.css` itself beyond its Ledger fallback (`#c14a52`, declared on `:root`), so a bare
     * compile of `tailwind.css` + this component's CSS resolves the active row's ink to the wrong
     * aesthetic's color. Setting it inline to `AESTHETIC_DEFAULT_COLORS.cobalt.colorAccent`
     * reproduces exactly what an unmodified Cobalt site resolves it to -- the same literal
     * `cobaltTokens.test.js` and `aestheticDefaults.js`'s own header comment both already cite as
     * Cobalt's `#c8303c`. It has to land on the `<html>` element specifically, matching where
     * `App.vue` itself sets it (`document.documentElement`) and where `tailwind.css` declares
     * `--color-accent: var(--q-accent)` (on `:root`): custom properties cascade to computed values
     * PER ELEMENT, so a later override on `<body>` alone would arrive too late to affect how
     * `--color-accent` itself was already resolved at `:root`.
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
     * OpenProject #3026: the 5px plate radius must be a standing property of `.page-toc-link`, not
     * something that only appears alongside the active row's background -- otherwise, the instant the
     * active class is removed (scrolling past a heading), the radius snaps to square while the
     * `background-color` is still fading out over its own 0.2s transition. Asserting it on a row that
     * was NEVER active (rather than toggling the class off one that was) is what proves the radius is
     * unconditional rather than merely persisting from some prior active state.
     */
    it('gives every row -- not only the active one -- the 5px plate radius, so it never has to snap in', async () => {
      const { entry } = await measure({ dark: false })
      expect(entry.radius).toBe('5px')
    })
  }
)
