import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileStringAsync } from 'sass'

import { CHROMIUM_TIMEOUT, buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #2969 ("Add Cobalt typography regression tests"), Epic #2968 ("Cobalt typography
 * role-table conformance sweep"). Pins down `ui-iteration-cobalt-typography/cobalt-typography.md`
 * §7's own test spec, written against that document's role table (§3) and its four role swaps (§4):
 * outside those four, Cobalt is required to move colour ONLY -- every type role's family, size,
 * weight, line-height and letter-spacing has to be identical to Ledger's, and identical again between
 * Cobalt light and Cobalt dark (§5: "dark restates colours only").
 *
 * This file intentionally makes almost no assertion about what a role's ABSOLUTE metrics are -- the
 * round of sibling work packages that land alongside this one (#2973-#2984) are what set those
 * values, several of them by rewriting `em`-relative rules to the absolute px the handoff calls for,
 * and hard-coding today's numbers here would just make this suite the next thing that goes stale. What
 * IS pinned, per §7, is the INVARIANT: same metrics across aesthetic and mode, except at the four named
 * role-swap seams, where the Cobalt-specific values ARE asserted literally, off the spec table.
 */

// ---------------------------------------------------------------------------------------------
// Source-scan: the two `body.body--cobalt` / `body.body--cobalt.body--dark` token blocks in
// `tailwind.css` never restate a `--font-*` custom property or set a literal font-size/font-weight/
// line-height/letter-spacing/text-transform declaration (§2 -- extends `cobaltTokens.test.js`'s
// source-scan pattern to the typography half of the same constraint).
// ---------------------------------------------------------------------------------------------

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'tailwind.css')
const cssSource = readFileSync(CSS_PATH, 'utf-8')

/**
 * Every top-level `${selector} { ... }` block in `source`, found by brace-depth counting rather
 * than `cobaltTokens.test.js`'s `indexOf('\n}')` shortcut. `body.body--cobalt` and
 * `body.body--cobalt.body--dark` are each declared MORE THAN ONCE in `tailwind.css` -- a typography
 * token pair (~L762/~L989) and at least two unrelated pairs further down (block/tabs tokens,
 * infobox/spoiler/checklist/index/countdown/live-data/gallery tokens) -- so this scans every
 * occurrence rather than assuming the first is the only one, per the round-2 coordination note's own
 * warning about the second block. A descendant compound like `body.body--cobalt .w-chip { ... }` is
 * NOT one of these blocks (the literal `body.body--cobalt {` search requires the brace immediately
 * after, with only whitespace between), which is deliberate: §4's role swaps are expected to live on
 * selectors like that one, not inside the bare token block.
 */
function blocksFor(source, selector) {
  const blocks = []
  let cursor = 0
  for (;;) {
    const start = source.indexOf(selector, cursor)
    if (start === -1) {
      break
    }
    const braceStart = source.indexOf('{', start)
    let depth = 0
    let i = braceStart
    for (; i < source.length; i += 1) {
      if (source[i] === '{') {
        depth += 1
      } else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          break
        }
      }
    }
    blocks.push(source.slice(start, i + 1))
    cursor = i + 1
  }
  return blocks
}

const lightBlocks = blocksFor(cssSource, 'body.body--cobalt {')
const darkBlocks = blocksFor(cssSource, 'body.body--cobalt.body--dark {')

/*
  A literal declaration only -- the property name has to start right at a declaration boundary
  (`{`, `;` or a newline, plus optional indentation), never partway through a longer custom property
  name. Without that anchor, `--infobox-name-font-size: 15px;` or `--checklist-summary-font: 400
  12.5px var(--font-sans);` (both real, legitimate declarations already in this file's non-typography
  Cobalt blocks) would read as violations of the very properties they merely happen to end with.
*/
const forbiddenPropRe =
  /(?:^|[;{\n])[ \t]*(font-size|font-weight|line-height|letter-spacing|text-transform)[ \t]*:/gi
const fontVarRe = /(?:^|[;{\n])[ \t]*--font-[a-z0-9-]*[ \t]*:/gi

describe('tailwind.css body.body--cobalt / body.body--cobalt.body--dark blocks stay colour-only', () => {
  it('finds at least one of each block (the token blocks have not moved or been removed)', () => {
    expect(lightBlocks.length).toBeGreaterThan(0)
    expect(darkBlocks.length).toBeGreaterThan(0)
  })

  it.each([
    ['body.body--cobalt', lightBlocks],
    ['body.body--cobalt.body--dark', darkBlocks]
  ])('every %s block restates no --font-* custom property', (name, blocks) => {
    blocks.forEach((block, index) => {
      const matches = [...block.matchAll(fontVarRe)].map((m) => m[0].trim())
      expect(
        matches,
        `${name} block #${index} restates a --font-* token: ${matches.join(', ')}`
      ).toEqual([])
    })
  })

  it.each([
    ['body.body--cobalt', lightBlocks],
    ['body.body--cobalt.body--dark', darkBlocks]
  ])(
    'every %s block sets no font-size/font-weight/line-height/letter-spacing/text-transform',
    (name, blocks) => {
      blocks.forEach((block, index) => {
        const matches = [...block.matchAll(forbiddenPropRe)].map((m) => m[1])
        expect(matches, `${name} block #${index} sets: ${matches.join(', ')}`).toEqual([])
      })
    }
  )
})

// ---------------------------------------------------------------------------------------------
// Real browser: extends `_page-contents.test.js`'s `measure()` pattern to the ten roles §7 names.
// ---------------------------------------------------------------------------------------------

describe(
  'Cobalt typography -- real browser (§7)',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser

    /*
      One sample of each of the ten roles §7 names, all on one page so a single `measure()` call
      covers every one of them. The four content roles (h1/h2/p/code/pre code) sit inside
      `.page-contents`, the article stylesheet's own root class; the four shared-component roles
      (`.w-btn`, `.w-section-header`, `.w-badge`, `.w-chip`) are reconstructed as the exact classes
      each component's own template renders for its default/base variant -- the same technique
      `sectionHeaderRhythm.test.js` uses for `.w-section-header` itself -- since `buildAppCss()`
      compiles `tailwind.css` alone and cannot mount a real SFC. `.w-chip` is rendered at
      `size="sm"` (`SIZES.sm` = `12px`), matching `PageTags.vue`'s own tag-chip call site and the
      §4.3 role swap this element is standing in for.
    */
    const SAMPLE = `
      <article class="page-contents">
        <h1 id="probe-h1">A rendered page title</h1>
        <h2 id="probe-h2">A section heading</h2>
        <p id="probe-p">Body paragraph text, long enough to wrap onto more than one line.</p>
        <ol>
          <li id="probe-li">a first step
            <ol><li>a nested sub-step</li></ol>
          </li>
          <li>a second step</li>
        </ol>
        <p>Inline <code id="probe-code">cardinal-ctl</code> mentioned in prose.</p>
        <pre class="codeblock"><code id="probe-pre-code">const x = 1</code></pre>
      </article>
      <button id="probe-btn" class="w-btn w-unstyled relative inline-flex flex-nowrap items-center justify-center gap-2 align-middle font-medium no-underline outline-offset-2 transition-[background-color,box-shadow,opacity,transform] select-none focus-visible:outline-2 w-btn--solid text-[12.5px] leading-[1.715em] rounded-control cursor-pointer hover:brightness-110">Save changes</button>
      <div id="probe-section-header" class="w-section-header">Section</div>
      <div id="probe-badge" class="w-badge inline-flex min-h-3.5 items-center justify-center px-1.5 py-0.5 font-mono text-[9px] leading-none font-semibold rounded-mark">3</div>
      <div id="probe-chip" class="w-chip inline-flex max-w-full flex-nowrap items-center gap-1.5 leading-tight align-middle rounded-pill px-2 py-[3px] border border-hairline bg-surface text-slate dark:border-border-dark dark:bg-dark-3 dark:text-text-secondary-dark" style="font-size:12px">on-call</div>
    `

    let stylesheets

    async function buildStylesheets() {
      const cssDir = dirname(fileURLToPath(import.meta.url))
      const [appCss, content] = await Promise.all([
        buildAppCss(),
        compileStringAsync(readFileSync(join(cssDir, '_page-contents.scss'), 'utf-8'), {
          loadPaths: [cssDir]
        })
      ])
      return { appCss, contentCss: content.css }
    }

    /**
     * The five typographic properties §7 names, for each of the ten roles, in one condition
     * (`cobalt`/`dark` booleans stack on `<body>` exactly as `composables/aesthetic.js` does).
     * `liNumeral` reads the numbered-step circle's `::before`, the same technique
     * `_page-contents.test.js`'s own numbered-list "real browser" describe uses.
     */
    async function measure({ dark: darkMode = false, cobalt = false } = {}) {
      const { appCss, contentCss } = stylesheets
      const page = await browser.newPage()
      try {
        const bodyClasses = [darkMode ? 'body--dark' : '', cobalt ? 'body--cobalt' : '']
          .filter(Boolean)
          .join(' ')
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body class="${bodyClasses}">${SAMPLE}</body></html>`
        )
        return await page.evaluate(() => {
          const props = (el) => {
            const s = getComputedStyle(el)
            return {
              fontFamily: s.fontFamily,
              fontSize: s.fontSize,
              fontWeight: s.fontWeight,
              lineHeight: s.lineHeight,
              letterSpacing: s.letterSpacing
            }
          }
          const beforeProps = (el) => {
            const s = getComputedStyle(el, '::before')
            return {
              fontFamily: s.fontFamily,
              fontSize: s.fontSize,
              fontWeight: s.fontWeight,
              lineHeight: s.lineHeight,
              letterSpacing: s.letterSpacing,
              width: s.width,
              height: s.height,
              color: s.color,
              backgroundColor: s.backgroundColor
            }
          }
          const at = (selector) => document.querySelector(selector)
          return {
            h1: props(at('#probe-h1')),
            h2: props(at('#probe-h2')),
            p: props(at('#probe-p')),
            code: props(at('#probe-code')),
            preCode: props(at('#probe-pre-code')),
            btn: props(at('#probe-btn')),
            sectionHeader: props(at('#probe-section-header')),
            badge: props(at('#probe-badge')),
            liNumeral: beforeProps(at('#probe-li')),
            chip: props(at('#probe-chip'))
          }
        })
      } finally {
        await page.close()
      }
    }

    let ledger
    let cobaltLight
    let cobaltDark

    beforeAll(async () => {
      browser = await chromium.launch()
      stylesheets = await buildStylesheets()
      ledger = await measure({ dark: false, cobalt: false })
      cobaltLight = await measure({ dark: false, cobalt: true })
      cobaltDark = await measure({ dark: true, cobalt: true })
    })

    afterAll(async () => {
      await browser?.close()
    })

    // -> The five properties §7 lists, read off a measured role
    const METRIC_KEYS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing']
    const pick = (entry) => Object.fromEntries(METRIC_KEYS.map((key) => [key, entry[key]]))

    // -> Every role §7 names, except the two of them that are §4 role swaps
    const NON_SWAP_ROLES = ['h1', 'h2', 'p', 'code', 'preCode', 'btn', 'sectionHeader', 'badge']
    // -> §4.2 (numbered steps) and §4.3 (tag chips) -- the two role swaps this element list reaches
    const SWAP_ROLES = ['liNumeral', 'chip']

    it('measures all ten roles in all three conditions', () => {
      for (const condition of [ledger, cobaltLight, cobaltDark]) {
        for (const role of [...NON_SWAP_ROLES, ...SWAP_ROLES]) {
          expect(condition[role], role).toBeTruthy()
        }
      }
    })

    it.each(NON_SWAP_ROLES)(
      '%s keeps identical typography under Cobalt as under Ledger -- Cobalt moves colour only (§2)',
      (role) => {
        expect(pick(cobaltLight[role]), role).toEqual(pick(ledger[role]))
      }
    )

    it('every measured role keeps identical typography between Cobalt light and Cobalt dark -- dark restates colour only (§5)', () => {
      for (const role of [...NON_SWAP_ROLES, ...SWAP_ROLES]) {
        expect(pick(cobaltDark[role]), role).toEqual(pick(cobaltLight[role]))
      }
    })

    /*
      The two role swaps this element list reaches (§4.2, §4.3): asserted against the spec table's
      OWN Cobalt values, per §7, rather than against Ledger's -- a swap role is precisely the one
      place the two aesthetics are allowed to differ in more than colour.
    */
    describe('§4 role swaps -- Cobalt-specific values, not equality with Ledger', () => {
      it('numbered-step numeral (§4.2): 600 11px/24px mono, a 24px disc, white on the accent', () => {
        expect(cobaltLight.liNumeral.fontFamily).toMatch(/mono/i)
        expect(cobaltLight.liNumeral.fontSize).toBe('11px')
        expect(cobaltLight.liNumeral.fontWeight).toBe('600')
        expect(cobaltLight.liNumeral.lineHeight).toBe('24px')
        expect(cobaltLight.liNumeral.width).toBe('24px')
        expect(cobaltLight.liNumeral.height).toBe('24px')
        // -> A white numeral in both modes -- the disc's own fill is what carries the accent, not
        //    the digit, per the locked dark-theme rule (`_page-contents.scss`'s own comment on it)
        expect(cobaltLight.liNumeral.color).toBe('rgb(255, 255, 255)')
        expect(cobaltDark.liNumeral.color).toBe('rgb(255, 255, 255)')
        // -> `--color-heading-h2` light / `#3d6df7` dark -- the disc itself is the one thing this
        //    role swap lets differ between modes, since it carries the swap's own colour, not text
        expect(cobaltLight.liNumeral.backgroundColor).not.toBe(cobaltDark.liNumeral.backgroundColor)
      })

      it('tag chip (§4.3): 500 12px Barlow, up one weight step from Ledger’s 400', () => {
        expect(cobaltLight.chip.fontWeight).toBe('500')
        expect(cobaltLight.chip.fontSize).toBe('12px')
        expect(cobaltLight.chip.fontFamily.replace(/["']/g, '')).toMatch(/^Barlow,/)
        expect(cobaltLight.chip.letterSpacing).toBe('normal')
      })
    })

    /*
      §7's last two bullets, swept across every measured role in every condition rather than pinned
      to one -- a blanket invariant, not a per-role assertion, is what stops a THIRTEENTH element some
      future role table entry adds from being the one nobody remembered to check.
    */
    describe('type-family invariants, swept across every measured role', () => {
      const stripQuotes = (family) => family.replace(/["']/g, '')
      const isBarlowCondensed = (family) => stripQuotes(family).startsWith('Barlow Condensed')
      const isBarlowSans = (family) => stripQuotes(family).startsWith('Barlow,')

      it('is at least weight 600 wherever the family is Barlow Condensed (display face)', () => {
        for (const condition of [ledger, cobaltLight, cobaltDark]) {
          for (const role of [...NON_SWAP_ROLES, ...SWAP_ROLES]) {
            const { fontFamily, fontWeight } = condition[role]
            if (isBarlowCondensed(fontFamily)) {
              expect(
                Number(fontWeight),
                `${role}: ${fontFamily} ${fontWeight}`
              ).toBeGreaterThanOrEqual(600)
            }
          }
        }
      })

      it('carries normal letter-spacing wherever the family is Barlow (sans stack)', () => {
        for (const condition of [ledger, cobaltLight, cobaltDark]) {
          for (const role of [...NON_SWAP_ROLES, ...SWAP_ROLES]) {
            const { fontFamily, letterSpacing } = condition[role]
            if (isBarlowSans(fontFamily)) {
              expect(letterSpacing, `${role}: ${fontFamily}`).toBe('normal')
            }
          }
        }
      })
    })
  }
)
