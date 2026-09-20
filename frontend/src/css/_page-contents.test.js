import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * `_page-contents.css` styles raw rendered markdown: a stylesheet partial with no component to
 * mount, so these assert against its source text.
 *
 * Content renders in whatever direction the active locale sets (`composables/direction.js`), so a
 * physical `-left`/`-right` here stays glued to the visual left -- the TRAILING edge of an RTL row
 * -- stranding the accent bar behind the title and the description's rule on the wrong side of the
 * text (upstream requarks/wiki #1639). A logical `-inline-start` resolves against `dir` on its own.
 */
describe('_page-contents.css ul.links-list', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
  const start = source.indexOf('ul.links-list {')
  const end = source.indexOf('@media (prefers-reduced-motion: reduce) {', start)
  if (start === -1 || end === -1) {
    throw new Error(
      'ul.links-list block not found in _page-contents.css -- has it moved or been renamed?'
    )
  }
  const block = source.slice(start, end)

  it('carries no physical left/right properties that would strand the accent bar and rule on the wrong edge under RTL', () => {
    expect(block).not.toMatch(/[\s;{](margin|padding|border)-left/)
    expect(block).not.toMatch(/[\s;{](margin|padding|border)-right/)
  })

  it('anchors the row accent bar to the logical leading edge, in both its rest and hover/focus colour', () => {
    expect(block).toMatch(/>\s*li\s*\{[^}]*border-inline-start:\s*3px solid var\(--content-rule\)/s)
    expect(block).toMatch(/border-inline-start-color:\s*var\(--content-link\)/)
  })

  it('anchors the description rule (em) to the logical leading edge, at both breakpoints', () => {
    expect(block).toMatch(/margin-inline-start:\s*0\.5em/)
    expect(block).toMatch(/padding-inline-start:\s*0\.75em/)
    expect(block).toMatch(/border-inline-start:\s*1px solid var\(--content-rule\)/)

    // -> The phone breakpoint zeroes all three back out when the two halves stack
    expect(block).toMatch(/margin-inline-start:\s*0;/)
    expect(block).toMatch(/padding-inline-start:\s*0;/)
    expect(block).toMatch(/border-inline-start:\s*0;/)
  })

  it('starts the list itself with no leading-edge padding, via the logical property', () => {
    expect(block).toMatch(/ul\.links-list\s*\{\s*margin:[^}]*padding-inline-start:\s*0/s)
  })
})

/**
 * Scans the whole source rather than one selector's slice: the bug class is "a physical property
 * snuck back in anywhere in this file", not "in one specific rule".
 *
 * `pre { … direction: ltr … }` is the one carve-out -- it pins code blocks left-to-right, and
 * logical properties resolve against an element's OWN computed `direction`, so a physical property
 * inside that subtree stays visually stable under RTL either way.
 */
describe('_page-contents.css logical properties (whole file)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')

  const codeblockStart = source.indexOf('  pre {')
  const codeblockEnd = source.indexOf('The copy button, added to each block', codeblockStart)
  if (codeblockStart === -1 || codeblockEnd === -1) {
    throw new Error('pre { … direction: ltr … } block not found -- has it moved or been renamed?')
  }
  const codeblockBlock = source.slice(codeblockStart, codeblockEnd)
  if (!codeblockBlock.includes('direction: ltr')) {
    throw new Error(
      'The carved-out `pre` block no longer declares `direction: ltr` -- update the exception or restore it'
    )
  }

  const scanned = source.slice(0, codeblockStart) + source.slice(codeblockEnd)

  it('carries no physical margin/padding/border -left or -right declaration outside the codeblock exception', () => {
    expect(scanned).not.toMatch(/[\s;{](?:margin|padding|border)-(?:left|right)(?:-[a-z]+)?\s*:/)
  })

  it('carries no bare `left:`/`right:` position declaration outside the codeblock exception', () => {
    expect(scanned).not.toMatch(/[\s;{](?:left|right)\s*:/)
  })

  it('carries no physical `text-align: left|right` outside the codeblock exception', () => {
    expect(scanned).not.toMatch(/text-align:\s*(?:left|right)\s*[;}]/)
  })

  it('anchors the blockquote gutter and its padding to the logical leading edge', () => {
    // -> The band down the leading edge is a `::before` sized in `inset-inline-start` so it
    //    follows `dir`; an inset `box-shadow`, the physical alternative, could not.
    expect(source).toMatch(
      /blockquote\s*\{[^}]*padding-block:\s*0\.9em;\s*padding-inline:\s*3\.5em 1\.1em;/s
    )
    expect(source).toMatch(
      /blockquote\s*\{[^}]*&::before\s*\{[^}]*inset-inline-start:\s*0;[^}]*border-inline-end:\s*1px solid var\(--content-rule\)/s
    )
  })

  it("anchors every admonition severity's accent bar to the logical leading edge", () => {
    for (const hue of ['info', 'success', 'important', 'warning', 'danger']) {
      expect(source).toMatch(
        new RegExp(
          `&\\.is-${hue},\\s*&:has\\(> \\.is-${hue}\\) \\{[^}]*border-inline-start-color:\\s*var\\(--content-${hue}\\)`,
          's'
        )
      )
    }
  })

  it('rounds the admonition corners opposite the accent bar via logical corner properties, scoped to Cobalt only', () => {
    expect(source).toMatch(
      /body\.body--cobalt & \{\s*border-start-end-radius:\s*6px;\s*border-end-end-radius:\s*6px;/
    )
  })

  /**
   * Membership in the SHARED selector list, not merely that a severity's own tail block exists:
   * the hue loop above covers the latter, and a severity with its own colours but no place in this
   * list silently falls back to the base `blockquote::before` gutter for its border and icon.
   */
  it('includes .is-question in the shared admonition selector list, alongside the other five kinds', () => {
    const sharedBlockStart = source.indexOf('&.is-info,')
    const sharedBlockEnd = source.indexOf('&::before {', sharedBlockStart)
    if (sharedBlockStart === -1 || sharedBlockEnd === -1) {
      throw new Error(
        'Shared admonition blockquote block not found -- has it moved or been renamed?'
      )
    }
    const selectorList = source.slice(sharedBlockStart, sharedBlockEnd)
    for (const kind of ['info', 'success', 'important', 'warning', 'danger', 'question']) {
      expect(selectorList).toMatch(new RegExp(`&\\.is-${kind},\\s*&:has\\(> \\.is-${kind}\\)`))
    }
  })

  it('positions the admonition icon from the logical leading edge', () => {
    expect(source).toMatch(/inset-inline-start:\s*1\.1em;\s*width:\s*1\.25em;/)
  })

  it('pins every code block to `direction: ltr` and converts the line-number gutter to logical properties', () => {
    expect(source).toMatch(/pre\s*\{[^}]*direction:\s*ltr;/s)
    expect(source).toMatch(
      /pre\.codeblock\.line-numbers\s*\{\s*position:\s*relative;\s*padding-inline-start:\s*3\.6rem/
    )
    expect(source).toMatch(
      /inset-inline-start:\s*-2\.5rem;\s*width:\s*2rem;\s*border-inline-end:\s*1px solid var\(--content-rule\)/
    )
    expect(source).toMatch(
      /padding-inline-end:\s*0\.7em;\s*color:\s*var\(--content-ink-faint\);\s*text-align:\s*end;/
    )
  })

  it('swaps the table cell rule to `border-inline-end` so the last logical column suppresses the correct edge', () => {
    expect(source).toMatch(
      /\[role='columnheader'\],\s*\[role='cell'\]\s*\{[^}]*border-inline-end:\s*1px solid var\(--content-table-col-rule\)/s
    )
    expect(source).toMatch(/\[role='row'\]\s*>\s*:last-child\s*\{\s*border-inline-end:\s*0;\s*\}/)
    expect(source).toMatch(
      /\[role='columnheader'\]\s*\{\s*border-inline-end-color:\s*var\(--content-table-head-rule\)/
    )
  })

  it("aligns table cells and the caption to the logical start, leaving room for markdown's own explicit `---:` alignment", () => {
    expect(source).toMatch(
      /\[role='columnheader'\],\s*\[role='cell'\]\s*\{[^}]*text-align:\s*start;/s
    )
    expect(source).toMatch(/caption\s*\{[^}]*text-align:\s*start;/s)
  })
})

describe('_page-contents.css admonition corners -- square by default, rounded under Cobalt (OpenProject #3131)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')

  function admonitionBlock() {
    const start = source.indexOf('&.is-info,\n    &:has(> .is-info),\n    &.is-success,')
    if (start === -1) {
      throw new Error('Admonition selector group not found in _page-contents.css -- has it moved?')
    }
    let depth = 0
    let braceStart = -1
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '{') {
        if (braceStart === -1) braceStart = i
        depth += 1
      } else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          return source.slice(start, i + 1)
        }
      }
    }
    throw new Error('Admonition selector group block is unterminated in _page-contents.css')
  }

  const block = admonitionBlock()

  it('sets no border-radius of its own at the top level of the block (Ledger draws it square)', () => {
    const cobaltStart = block.indexOf('body.body--cobalt &')
    expect(cobaltStart).toBeGreaterThan(-1)
    const outsideCobalt = block.slice(0, cobaltStart)
    expect(outsideCobalt).not.toMatch(/border-radius/)
    expect(outsideCobalt).not.toMatch(/border-start-end-radius/)
    expect(outsideCobalt).not.toMatch(/border-end-end-radius/)
  })

  it('carries no `&::after { content: none }` at the top level, letting the plain blockquote corner marks cascade through', () => {
    const cobaltStart = block.indexOf('body.body--cobalt &')
    const outsideCobalt = block.slice(0, cobaltStart)
    expect(outsideCobalt).not.toMatch(/&::after\s*\{\s*content:\s*none;\s*\}/)
  })

  it('insets the corner marks past the accent bar on the logical leading edge (OpenProject #3462)', () => {
    const cobaltStart = block.indexOf('body.body--cobalt &')
    const outsideCobalt = block.slice(0, cobaltStart)
    expect(outsideCobalt).toMatch(/&::after\s*\{[^}]*inset-inline-start:\s*-9px;/s)
    expect(outsideCobalt).not.toMatch(/&::after\s*\{[^}]*(?:\bleft|\bright):/s)
  })

  it('re-rounds the two corners and re-suppresses the marks, but only inside an explicit body.body--cobalt scope', () => {
    const cobaltStart = block.indexOf('body.body--cobalt &')
    const cobaltBlock = block.slice(cobaltStart)
    expect(cobaltBlock).toMatch(/border-start-end-radius:\s*6px;/)
    expect(cobaltBlock).toMatch(/border-end-end-radius:\s*6px;/)
    expect(cobaltBlock).toMatch(/&::after\s*\{\s*content:\s*none;\s*\}/)
  })

  /*
   * What source-reading cannot confirm: which of the two competing rules (the plain blockquote's
   * Cobalt override and this admonition's more specific one) the cascade applies, and what a
   * browser actually paints for the corners and the pseudo-element.
   */
  describe('real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser
    let stylesheets

    const SAMPLE = `
      <article class="page-contents">
        <blockquote class="is-info"><p>An informational note.</p></blockquote>
      </article>`

    async function buildStylesheets() {
      const cssDir = dirname(fileURLToPath(import.meta.url))
      const contentCss = readFileSync(join(cssDir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      return { appCss, contentCss }
    }

    async function measure({ dark: darkMode = false, cobalt = false, rtl = false } = {}) {
      const { appCss, contentCss } = stylesheets
      const page = await browser.newPage()
      try {
        const bodyClasses = [darkMode ? 'body--dark' : '', cobalt ? 'body--cobalt' : '']
          .filter(Boolean)
          .join(' ')
        await page.setContent(
          `<!doctype html><html${rtl ? ' dir="rtl"' : ''}><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body class="${bodyClasses}">${SAMPLE}</body></html>`
        )
        return await page.evaluate(() => {
          const el = document.querySelector('blockquote.is-info')
          const cs = getComputedStyle(el)
          const after = getComputedStyle(el, '::after')
          return {
            afterLeft: after.left,
            afterRight: after.right,
            borderLeft: cs.borderLeftWidth,
            borderRight: cs.borderRightWidth,
            // -> The corner opposite the accent bar under LTR -- top-right, physically.
            radius: cs.borderTopRightRadius,
            afterContent: after.content,
            afterBackgroundImage: after.backgroundImage
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

    it('draws a square-cornered box with the corner marks present under Ledger, light and dark', async () => {
      const light = await measure({ dark: false })
      const dark = await measure({ dark: true })
      expect(light.radius).toBe('0px')
      expect(dark.radius).toBe('0px')
      // -> `content: none` computes to the keyword string 'none'; a real mark sets `content: ''`,
      //    which computes to an empty string, not the literal text 'none'.
      expect(light.afterContent).not.toBe('none')
      expect(dark.afterContent).not.toBe('none')
      expect(light.afterBackgroundImage).toMatch(/linear-gradient/)
      expect(dark.afterBackgroundImage).toMatch(/linear-gradient/)
    })

    // -> The 4px accent bar pushes the padding box in from the border edge, so the leading marks
    //    need a deeper inset than the plain quote's `-5px`: `-9px` = -5, less the bar's extra 3px,
    //    less the `::after`'s own 1px transparent border, which leaves the leading stroke 3px clear
    //    of the bar's outer edge.
    it('pushes the leading corner marks out past the accent bar, leaving the trailing side at the base inset (LTR)', async () => {
      const m = await measure()
      expect(m.borderLeft).toBe('4px')
      expect(m.afterLeft).toBe('-9px')
      expect(m.afterRight).toBe('-5px')
    })

    it('mirrors the leading-edge offset under RTL, where the accent bar sits on the right', async () => {
      const m = await measure({ rtl: true })
      expect(m.borderRight).toBe('4px')
      expect(m.afterRight).toBe('-9px')
      expect(m.afterLeft).toBe('-5px')
    })

    it('draws a rounded box with no corner marks under Cobalt, light and dark', async () => {
      const cobaltLight = await measure({ dark: false, cobalt: true })
      const cobaltDark = await measure({ dark: true, cobalt: true })
      expect(cobaltLight.radius).toBe('6px')
      expect(cobaltDark.radius).toBe('6px')
      expect(cobaltLight.afterContent).toBe('none')
      expect(cobaltDark.afterContent).toBe('none')
    })
  })
})

/**
 * A literal hex here would silently stop following a re-themed value the token itself picks up.
 * `--content-success`/`--content-warning` are the same shape and deliberately left out.
 */
describe('_page-contents.css admonition tones resolve through the color token', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')

  it.each([
    ['--content-info', '--color-info'],
    ['--content-danger', '--color-negative'],
    ['--content-important', '--color-ink']
  ])('%s references var(%s), not a literal hex', (property, token) => {
    const match = source.match(new RegExp(`${property}\\s*:\\s*([^;]+);`))
    expect(match, `${property} declaration found`).toBeTruthy()
    expect(match[1].trim()).toBe(`var(${token})`)
  })
})

/**
 * The colour half of these constructs is pinned numerically in `helpers/accessibility.test.js`
 * instead: a hex is only right relative to the ground it lands on, which is a contrast assertion,
 * not a source one.
 */
describe('_page-contents.css rendered content beyond prose', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')

  function blockFor(selector) {
    const start = source.indexOf(selector)
    if (start === -1) {
      throw new Error(`\`${selector}\` not found in _page-contents.css -- has it moved?`)
    }
    let depth = 0
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '{') {
        depth += 1
      } else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          return source.slice(start, i + 1)
        }
      }
    }
    throw new Error(`\`${selector}\` block is unterminated in _page-contents.css`)
  }

  describe('task-list checkbox', () => {
    const block = blockFor('.task-list-item-checkbox {')

    it('draws a done item in the accent rather than the grey that was in no palette', () => {
      expect(block).toMatch(/background-color:\s*var\(--content-tick\)/)
      expect(source).toMatch(/--content-tick:\s*var\(--color-accent-fill\)/)
      expect(source).toMatch(/--content-tick:\s*var\(--color-accent-dark\)/)
      // -> Scoped to the declaration rather than searching the file for the old hex: the
      //    stylesheet's own comment still names it.
      expect(source).not.toMatch(/--content-tick:\s*#/)
    })

    it('leaves an item still to do as an outline, not a white square', () => {
      expect(source).toMatch(/--content-tick-empty:\s*transparent/)
      expect(source).not.toMatch(/--content-tick-empty:\s*#fff/)
    })

    it('edges that outline in the off-control tone, per theme', () => {
      expect(block).toMatch(/border:\s*1px solid var\(--content-tick-edge\)/)
      expect(source).toMatch(/--content-tick-edge:\s*var\(--color-slate-pale\)/)
      expect(source).toMatch(/--content-tick-edge:\s*var\(--color-disabled-dark\)/)
    })

    it('keeps the box the same size ticked or not, by colouring the border rather than hiding it', () => {
      expect(block).toMatch(/border-color:\s*var\(--content-tick\)/)
      expect(block).not.toMatch(/border-color:\s*transparent/)
    })

    /*
     * A tick is a data URI, so its stroke cannot be a custom property: the two themes need two
     * URIs. Recolouring one with a filter is what "dark mode is a second palette" rules out.
     */
    it('carries a white tick on the light accent and an ink tick on the dark one', () => {
      expect(block).toMatch(/stroke='%23fff'/)
      expect(block).toMatch(/\.body--dark &[\s\S]*stroke='%2314171f'/)
    })
  })

  describe('kbd', () => {
    const block = blockFor('  kbd {')

    it('is a flat square plate, not a key cap', () => {
      expect(block).toMatch(/border:\s*1px solid var\(--content-rule\)/)
      // -> The lip of a physical key; nothing in Cardinal is bevelled or weighted.
      expect(block).not.toContain('border-bottom-width')
    })

    it('is set in the mono face on the tint, like every other small framed mark', () => {
      expect(block).toMatch(/font-family:\s*var\(--font-mono\)/)
      expect(block).toMatch(/background-color:\s*var\(--content-surface-alt\)/)
      expect(block).toMatch(/letter-spacing:/)
    })

    it('takes the same theme-aware ink as an inline code chip', () => {
      expect(block).toMatch(/color:\s*var\(--content-code-ink\)/)
      expect(source).toMatch(/--content-code-ink:\s*var\(--color-slate\)/)
      expect(source).toMatch(/--content-code-ink:\s*var\(--color-slate-light\)/)
    })

    it('drops the plate inside a heading, the way an inline code span does', () => {
      expect(source).toMatch(/kbd\s*\{\s*padding:\s*0;\s*border:\s*0;\s*background:\s*none;/)
    })
  })

  /*
   * `markdown-it-glossary.js` puts `.glossary-term` on both forms it can emit -- an unlinked
   * `<abbr>` and a linked `<a>` -- and the generic `a` rule sets `text-decoration: none`, so only
   * a class-keyed rule reaches both.
   */
  describe('glossary term', () => {
    const block = blockFor('.glossary-term {')

    it('gets its own dotted underline and "help" cursor, independent of which tag the renderer chose', () => {
      expect(block).toMatch(/text-decoration:\s*underline dotted/)
      expect(block).toMatch(/text-decoration-thickness:\s*1px/)
      expect(block).toMatch(/text-underline-offset:\s*3px/)
      expect(block).toMatch(/cursor:\s*help/)
    })

    it('is keyed off the class, not the `abbr` tag, so it also reaches the linked `<a>` form', () => {
      expect(block.startsWith('.glossary-term')).toBe(true)
    })
  })

  describe('footnotes', () => {
    it('bleeds the separator back through the container padding, like the title rule', () => {
      const sep = blockFor('.footnotes-sep {')
      expect(sep).toMatch(/margin-inline:\s*calc\(-1 \* var\(--content-bleed\)\)/)
    })

    it('sets the reference mark in the mono face', () => {
      expect(blockFor('.footnote-ref > a {')).toMatch(/font-family:\s*var\(--font-mono\)/)
    })

    it('rules the notes as rows and sets their markers as mono accent figures', () => {
      const item = blockFor('    .footnote-item {')
      expect(item).toMatch(/border-bottom:\s*1px solid var\(--content-rule\)/)
      expect(item).toMatch(/&::marker\s*\{[^}]*font-family:\s*var\(--font-mono\)/s)
      expect(item).toMatch(/&::marker\s*\{[^}]*color:\s*var\(--content-link\)/s)
    })

    it('marks a landed note with the accent plate rather than a yellow highlighter', () => {
      const landed = blockFor('.footnote-item.is-anchor-landed {')
      expect(landed).toMatch(/background-color:\s*var\(--content-landed-wash\)/)
      expect(landed).toMatch(/border-inline-start:\s*2px solid var\(--content-landed-edge\)/)
      // -> `--content-mark` is the author's own `<mark>` highlighter; a landed note is a different
      //    statement and takes the accent wash instead.
      expect(landed).not.toContain('--content-mark')
      expect(source).toMatch(/--content-landed-wash:\s*var\(--color-accent-wash\)/)
      expect(source).toMatch(/--content-landed-wash:\s*var\(--color-accent-wash-dark\)/)
    })

    it('sets the backref as a mono accent glyph', () => {
      const backref = blockFor('.footnote-backref {')
      expect(backref).toMatch(/font-family:\s*var\(--font-mono\)/)
      expect(backref).toMatch(/color:\s*var\(--content-link\)/)
    })
  })

  describe('the code block itself', () => {
    it('takes its ink and both edges from tokens, so print can put them back', () => {
      const pre = blockFor('  pre {')
      expect(pre).toMatch(/color:\s*var\(--content-code-block-ink\)/)
      expect(pre).toMatch(/border:\s*1px solid var\(--content-code-frame\)/)
      expect(pre).toMatch(/border-inline-start:\s*2px solid var\(--content-code-edge\)/)
    })

    it('frames itself on a dark page only, and lightens the accent edge there', () => {
      expect(source).toMatch(/--content-code-frame:\s*transparent/)
      expect(source).toMatch(/--content-code-frame:\s*var\(--color-hairline-dark\)/)
      expect(source).toMatch(/--content-code-edge:\s*var\(--color-accent-fill\)/)
      expect(source).toMatch(/--content-code-edge:\s*var\(--color-accent-dark\)/)
    })

    it('inverts for print rather than printing near-white text on white paper', () => {
      const printBlock = source.slice(source.indexOf('@media print {'))
      expect(printBlock).toMatch(/--content-code-block-ink:\s*#000/)
      expect(printBlock).toMatch(/--content-code-edge:\s*var\(--content-rule\)/)
      expect(printBlock).toMatch(/--content-code-string:\s*#0a3069/)
      expect(printBlock).toMatch(/--content-code-addition-wash:\s*transparent/)
      expect(printBlock).toMatch(/--content-code-deletion-wash:\s*transparent/)
    })
  })
})

/**
 * The two failures a source read cannot catch: a custom property that resolves to nothing because
 * the token it names does not exist, and a rule that loses the cascade to a more specific one.
 * Neither jsdom nor happy-dom resolves a `var()` chain or runs the cascade over real stylesheets,
 * so both report the source's intent back rather than the result -- hence a real headless Chromium
 * over `_page-contents.css` beside `tailwind.css`, which between them own every token in the chain.
 */
describe(
  '_page-contents.css rendered content beyond prose — real browser',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let light
    let dark
    let cobaltLight
    let cobaltDark

    /*
     * The markup the renderers actually emit: `markdown-it-task-lists` with `label: false`,
     * `markdown-it-footnote`, and highlight.js's own token classes inside `pre.codeblock`.
     */
    const SAMPLE = `
      <article class="page-contents">
        <ul class="contains-task-list">
          <li class="task-list-item">
            <input class="task-list-item-checkbox" disabled type="checkbox" checked><span>x</span> done
          </li>
          <li class="task-list-item">
            <input class="task-list-item-checkbox" disabled type="checkbox"><span> </span> still to do
          </li>
        </ul>
        <p>Press <kbd>Ctrl</kbd> and read <code>cardinal-ctl</code>.<sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup></p>
        <pre class="codeblock hljs"><code><span class="hljs-keyword">const</span> <span class="hljs-string">'x'</span> <span class="hljs-number">2</span> <span class="hljs-comment">// note</span></code></pre>
        <hr class="footnotes-sep">
        <section class="footnotes">
          <ol class="footnotes-list">
            <li id="fn1" class="footnote-item is-anchor-landed">
              <p>A landed note. <a href="#fnref1" class="footnote-backref">↩︎</a></p>
            </li>
            <li id="fn2" class="footnote-item"><p>An ordinary note.</p></li>
          </ol>
        </section>
      </article>`

    let stylesheets

    async function buildStylesheets() {
      const cssDir = dirname(fileURLToPath(import.meta.url))
      const contentCss = readFileSync(join(cssDir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      return { appCss, contentCss }
    }

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
          const at = (selector) => document.querySelector(selector)
          const styleOf = (selector) => getComputedStyle(at(selector))
          const boxOf = (selector) => at(selector).getBoundingClientRect()
          const checked = styleOf('.task-list-item-checkbox:checked')
          const unchecked = styleOf('.task-list-item-checkbox:not(:checked)')
          return {
            checkbox: {
              checkedFill: checked.backgroundColor,
              checkedBorder: checked.borderTopColor,
              checkedTick: checked.backgroundImage,
              checkedWidth: boxOf('.task-list-item-checkbox:checked').width,
              uncheckedFill: unchecked.backgroundColor,
              uncheckedBorder: unchecked.borderTopColor,
              uncheckedWidth: boxOf('.task-list-item-checkbox:not(:checked)').width,
              radius: checked.borderTopLeftRadius
            },
            kbd: {
              color: styleOf('kbd').color,
              background: styleOf('kbd').backgroundColor,
              topBorder: styleOf('kbd').borderTopWidth,
              bottomBorder: styleOf('kbd').borderBottomWidth,
              family: styleOf('kbd').fontFamily,
              radius: styleOf('kbd').borderTopLeftRadius
            },
            inlineCode: {
              color: styleOf('p code').color,
              background: styleOf('p code').backgroundColor
            },
            codeBlock: {
              background: styleOf('pre.codeblock').backgroundColor,
              color: styleOf('pre.codeblock').color,
              keyword: styleOf('.hljs-keyword').color,
              string: styleOf('.hljs-string').color,
              number: styleOf('.hljs-number').color,
              comment: styleOf('.hljs-comment').color,
              radius: styleOf('pre.codeblock').borderTopLeftRadius,
              leadingEdgeWidth: styleOf('pre.codeblock').borderInlineStartWidth
            },
            footnotes: {
              refFamily: styleOf('.footnote-ref > a').fontFamily,
              sepLeft: boxOf('.footnotes-sep').left,
              articleLeft: boxOf('.page-contents').left,
              itemRule: styleOf('.footnote-item').borderBottomColor,
              landedBackground: styleOf('.footnote-item.is-anchor-landed').backgroundColor,
              landedEdge: styleOf('.footnote-item.is-anchor-landed').borderInlineStartWidth,
              landedPadding: styleOf('.footnote-item.is-anchor-landed').paddingInlineStart,
              backrefFamily: styleOf('.footnote-backref').fontFamily,
              backrefColor: styleOf('.footnote-backref').color
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
      light = await measure({ dark: false })
      dark = await measure({ dark: true })
      cobaltLight = await measure({ dark: false, cobalt: true })
      cobaltDark = await measure({ dark: true, cobalt: true })
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('paints a done task as the accent fill and an undone one as a bare outline', () => {
      // -> `--color-accent-fill` / `--color-accent-dark`, resolved through `--content-tick`.
      expect(light.checkbox.checkedFill).toBe('rgb(228, 103, 107)')
      expect(dark.checkbox.checkedFill).toBe('rgb(240, 130, 135)')
      // -> `transparent`, not white: an empty box in this language is its outline and nothing else.
      expect(light.checkbox.uncheckedFill).toBe('rgba(0, 0, 0, 0)')
      expect(dark.checkbox.uncheckedFill).toBe('rgba(0, 0, 0, 0)')
      // -> `--color-slate-pale` / `--color-disabled-dark`.
      expect(light.checkbox.uncheckedBorder).toBe('rgb(169, 183, 208)')
      expect(dark.checkbox.uncheckedBorder).toBe('rgb(74, 84, 112)')
    })

    it('keeps a ticked and an unticked box the same size, and both square', () => {
      expect(light.checkbox.checkedWidth).toBeCloseTo(light.checkbox.uncheckedWidth, 5)
      expect(light.checkbox.checkedBorder).toBe(light.checkbox.checkedFill)
      expect(light.checkbox.radius).toBe('0px')
    })

    it('ticks in white on the light accent and in ink on the dark one', () => {
      expect(light.checkbox.checkedTick).toContain("stroke='%23fff'")
      expect(dark.checkbox.checkedTick).toContain("stroke='%2314171f'")
    })

    it('draws a kbd as an even square hairline plate in the mono face', () => {
      expect(light.kbd.topBorder).toBe(light.kbd.bottomBorder)
      expect(light.kbd.bottomBorder).toBe('1px')
      expect(light.kbd.radius).toBe('0px')
      expect(light.kbd.family).toMatch(/mono/i)
      // -> `--color-slate` on `--color-tint`, and the lightened chrome tone on the dark chip.
      expect(light.kbd.color).toBe('rgb(56, 70, 95)')
      expect(dark.kbd.color).toBe('rgb(142, 166, 207)')
    })

    it('gives an inline code chip the same theme-aware ink as the key plate', () => {
      expect(light.inlineCode.color).toBe(light.kbd.color)
      expect(dark.inlineCode.color).toBe(dark.kbd.color)
      expect(dark.inlineCode.background).not.toBe(light.inlineCode.background)
    })

    it('resolves every code token to a real colour on the ink the block is actually drawn on', () => {
      for (const theme of [light, dark]) {
        const { background, keyword, string, number, comment } = theme.codeBlock
        for (const token of [keyword, string, number, comment]) {
          expect(token).toMatch(/^rgb\(/)
          expect(token).not.toBe(background)
        }
        // -> The four are four different colours, not one inherited body ink four times over.
        expect(new Set([keyword, string, number, comment]).size).toBe(4)
      }
      expect(light.codeBlock.keyword).toBe('rgb(240, 130, 135)')
      expect(dark.codeBlock.keyword).toBe('rgb(255, 155, 160)')
    })

    it('rounds the code block and drops its accent edge under Cobalt, leaving Ledger square', () => {
      expect(light.codeBlock.radius).toBe('0px')
      expect(dark.codeBlock.radius).toBe('0px')
      expect(light.codeBlock.leadingEdgeWidth).toBe('2px')
      expect(dark.codeBlock.leadingEdgeWidth).toBe('2px')

      expect(cobaltLight.codeBlock.radius).toBe('8px')
      expect(cobaltDark.codeBlock.radius).toBe('8px')
      expect(cobaltLight.codeBlock.leadingEdgeWidth).toBe('0px')
      expect(cobaltDark.codeBlock.leadingEdgeWidth).toBe('0px')

      // -> `--color-ink`'s own Cobalt override, `#10194a`
      expect(cobaltLight.codeBlock.background).toBe('rgb(16, 25, 74)')
    })

    it('bleeds the footnote separator back past the article text, as the title rule does', () => {
      // -> `--content-bleed` defaults to 1rem here; the surface that sets 28px only sharpens it.
      expect(light.footnotes.sepLeft).toBeLessThan(light.footnotes.articleLeft)
    })

    it('sets the reference and the backref in the mono face, in the link tone', () => {
      expect(light.footnotes.refFamily).toMatch(/mono/i)
      expect(light.footnotes.backrefFamily).toMatch(/mono/i)
      // -> `--color-accent-strong`, the link tone on anything that is not white.
      expect(light.footnotes.backrefColor).toBe('rgb(168, 63, 69)')
    })

    /*
     * The cascade case: `.footnotes .footnote-item` sets `padding: 0.7em 0` and
     * `.footnote-item.is-anchor-landed` wins the leading edge back off it at equal specificity,
     * only because it is declared later in the file. Source-reading cannot see that.
     */
    it('gives a landed note the accent plate, and its edge room inside the row', () => {
      expect(light.footnotes.landedBackground).toBe('rgb(253, 236, 237)')
      expect(dark.footnotes.landedBackground).toBe('rgb(58, 43, 52)')
      expect(light.footnotes.landedEdge).toBe('2px')
      expect(Number.parseFloat(light.footnotes.landedPadding)).toBeGreaterThan(0)
    })

    it('rules the notes as rows', () => {
      expect(light.footnotes.itemRule).toBe('rgb(219, 225, 236)')
      expect(dark.footnotes.itemRule).toBe('rgb(42, 48, 64)')
    })
  }
)

/**
 * Its own sample and `measure()`: the describe above's markup carries no heading, paragraph or
 * link to read a colour off.
 */
describe(
  '_page-contents.css article role-table conformance — real browser (OpenProject #2977)',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let stylesheets
    let light
    let dark
    let cobaltLight
    let cobaltDark

    const SAMPLE = `
      <article class="page-contents">
        <h1>Title</h1>
        <h2>Section</h2>
        <h3>Subsection</h3>
        <h6>Label</h6>
        <p>Body copy with an <a href="/elsewhere">inline link</a> and <code>inline.code()</code>.</p>
        <pre class="codeblock"><code>plain text</code></pre>
      </article>`

    async function buildStylesheets() {
      const cssDir = dirname(fileURLToPath(import.meta.url))
      const contentCss = readFileSync(join(cssDir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      return { appCss, contentCss }
    }

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
          const styleOf = (selector) => getComputedStyle(document.querySelector(selector))
          return {
            h2: styleOf('h2').color,
            h3: styleOf('h3').color,
            h6: styleOf('h6').color,
            p: styleOf('p').color,
            link: styleOf('a').color,
            inlineCode: styleOf('code').color,
            codeBlock: styleOf('pre.codeblock').color
          }
        })
      } finally {
        await page.close()
      }
    }

    beforeAll(async () => {
      browser = await chromium.launch()
      stylesheets = await buildStylesheets()
      light = await measure({ dark: false })
      dark = await measure({ dark: true })
      cobaltLight = await measure({ dark: false, cobalt: true })
      cobaltDark = await measure({ dark: true, cobalt: true })
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('colors Cobalt h2 in the accent, distinct from h3/h6/paragraph ink -- the one heading level allowed to', () => {
      // -> `--color-heading-h2`
      expect(cobaltLight.h2).toBe('rgb(31, 79, 214)')
      expect(cobaltDark.h2).toBe('rgb(143, 176, 255)')
      expect(cobaltLight.h2).not.toBe(cobaltLight.h3)
      expect(cobaltDark.h2).not.toBe(cobaltDark.h3)
    })

    it('keeps h3 and the paragraph on the same body ink under Cobalt, not h1/h2’s navy or accent', () => {
      // -> `--color-text-body`, resolved through `--content-ink`/`--content-h2` inheritance, not
      //    `--color-ink`'s navy.
      expect(cobaltLight.h3).toBe('rgb(26, 32, 56)')
      expect(cobaltLight.p).toBe(cobaltLight.h3)
      expect(cobaltDark.h3).toBe('rgb(232, 236, 255)')
      expect(cobaltDark.p).toBe(cobaltDark.h3)
    })

    it('mutes h6 to the caption-adjacent secondary tone under Cobalt', () => {
      // -> `--color-text-secondary`
      expect(cobaltLight.h6).toBe('rgb(74, 85, 128)')
      expect(cobaltDark.h6).toBe('rgb(167, 179, 234)')
    })

    it('links prose in the strong accent under Cobalt, matching h2 in light and diverging in dark', () => {
      // -> `--color-accent-strong`: the same hex as `--color-heading-h2` in Cobalt light (#1f4fd6)
      //    but not in dark, where the dark-cobalt `--content-link` override points links at the
      //    cool #7fa0ff rather than the warm accent-dark a plain `.body--dark` cascade would give.
      expect(cobaltLight.link).toBe('rgb(31, 79, 214)')
      expect(cobaltDark.link).toBe('rgb(127, 160, 255)')
    })

    it('draws inline code ink from the fixed tag-chip-accent token, not the site-configurable accent color', () => {
      // -> `--color-tag-chip-accent-text`: #c8303c / #ff8f97, fixed per aesthetic regardless of a
      //    site's own `--q-accent` customization.
      expect(cobaltLight.inlineCode).toBe('rgb(200, 48, 60)')
      expect(cobaltDark.inlineCode).toBe('rgb(255, 143, 151)')
    })

    it('gives the code block its own Cobalt ink, one step off Ledger’s, unchanged between light and dark', () => {
      // -> `#e6eaff`, not Ledger's `--color-text-dark` (`#e6eaf2`) the generic token resolves to.
      expect(cobaltLight.codeBlock).toBe('rgb(230, 234, 255)')
      expect(cobaltDark.codeBlock).toBe(cobaltLight.codeBlock)
      expect(light.codeBlock).not.toBe(cobaltLight.codeBlock)
    })
  }
)

describe('_page-contents.css Cobalt table-head swap stays sentence-case with no tracking (§4.1)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
  const cobaltBlockStart = source.indexOf('body.body--cobalt &')
  const cobaltBlockEnd = source.indexOf('body.body--cobalt.body--dark &')
  const cobaltBlock = source.slice(cobaltBlockStart, cobaltBlockEnd)

  it('sets the Barlow sans head font, normal tracking and no case transform under Cobalt', () => {
    expect(cobaltBlockStart).toBeGreaterThan(-1)
    expect(cobaltBlock).toMatch(
      /--content-table-head-font:\s*600 0\.8125rem\/1\.4 var\(--font-sans\);/
    )
    expect(cobaltBlock).toMatch(/--content-table-head-tracking:\s*normal;/)
    expect(cobaltBlock).toMatch(/--content-table-head-transform:\s*none;/)
  })
})

describe('_page-contents.css cobalt numbered list (OpenProject #2883)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')

  function blockFor(selector) {
    const start = source.indexOf(selector)
    if (start === -1) {
      throw new Error(`\`${selector}\` not found in _page-contents.css -- has it moved?`)
    }
    let depth = 0
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '{') {
        depth += 1
      } else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          return source.slice(start, i + 1)
        }
      }
    }
    throw new Error(`\`${selector}\` block is unterminated in _page-contents.css`)
  }

  it("sizes the circle's box in `rem`, not `em` -- `em` on a property other than `font-size` resolves against the PSEUDO-ELEMENT's own (smaller, fixed 11px) computed font-size, not the list item's, which is what silently shrank the 24px handoff circle to 16.5px", () => {
    const block = blockFor('li > ol > li {')
    expect(block).toMatch(/inset-inline-start:\s*-2\.4rem/)
    expect(block).toMatch(/width:\s*1\.5rem/)
    expect(block).toMatch(/height:\s*1\.5rem/)
    expect(block).not.toMatch(/(?:width|height|inset-inline-start):\s*-?[\d.]+em\b/)
  })

  it("centers the numeral with a line-height equal to the box height, the handoff's own technique, rather than flexbox plus an unexplained positional nudge", () => {
    const block = blockFor('li > ol > li {')
    expect(block).toMatch(/font:\s*600 11px\/1\.5rem var\(--font-mono\)/)
    expect(block).not.toMatch(/display:\s*flex/)
    expect(block).not.toMatch(/top:\s*0\.05em/)
  })

  it('gives a sub-step ordered list its own counter scope, so its hidden nested numerals cannot steal values the top-level circles are still going to show', () => {
    const block = blockFor('    ol ol {')
    expect(block).toMatch(/counter-reset:\s*cobalt-step/)
    expect(block).not.toMatch(/counter-reset:\s*none/)
  })

  describe('real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser

    const SAMPLE = `
        <article class="page-contents">
          <ol>
            <li>first</li>
            <li>second</li>
            <li>third</li>
          </ol>
        </article>`

    async function measureCircle() {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body class="body--cobalt">${SAMPLE}</body></html>`
        )
        return await page.evaluate(() => {
          const li = document.querySelector('.page-contents > ol > li')
          const cs = getComputedStyle(li, '::before')
          return { width: cs.width, height: cs.height }
        })
      } finally {
        await page.close()
      }
    }

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it("resolves the circle to the handoff's 24px in both dimensions, not the 16.5px an `em`-relative-to-its-own-font-size box would compute to", async () => {
      const circle = await measureCircle()
      expect(circle.width).toBe('24px')
      expect(circle.height).toBe('24px')
    })
  })
})

describe('_page-contents.css cobalt numbered-step numeral is a fixed size (OpenProject #2965)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')

  it('does not size the numeral in `em`, which would resolve against the changing `.page-contents` base', () => {
    expect(source).toMatch(/font:\s*600 11px\/1\.5rem var\(--font-mono\)/)
    expect(source).not.toMatch(/font:\s*600 [\d.]+em\/1\.5rem var\(--font-mono\)/)
  })

  describe('real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it("keeps the numeral at 11px even when the article's own base font-size differs from 16px, proving the numeral no longer tracks it", async () => {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body class="body--cobalt"><article class="page-contents" style="font-size: 15.5px">` +
            '<ol><li>first</li><li>second</li></ol></article></body></html>'
        )
        const fontSize = await page.evaluate(() => {
          const li = document.querySelector('.page-contents > ol > li')
          return getComputedStyle(li, '::before').fontSize
        })
        expect(fontSize).toBe('11px')
      } finally {
        await page.close()
      }
    })
  })
})

/**
 * Three nested boxes: `.table-wrap` is the outer, non-scrolling frame the corner marks overhang;
 * `.table-clip` owns `overflow: hidden` plus the radius on its own, because a native scrollbar is
 * not reliably clipped by `border-radius` on the SAME element that produces it (a space-reserving
 * scrollbar squares off the very corner it sits against); `.table-scroll` is that scroller.
 */
describe('_page-contents.css table frame (OpenProject #2917)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
  // -> Anchors the searches below past the per-aesthetic token blocks earlier in the file.
  const tablesSectionStart = source.indexOf('\n  /* TABLES */\n')

  function blockFor(selector) {
    const start = source.indexOf(selector, tablesSectionStart)
    if (start === -1) {
      throw new Error(`\`${selector}\` not found in _page-contents.css -- has it moved?`)
    }
    let depth = 0
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '{') {
        depth += 1
      } else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          return source.slice(start, i + 1)
        }
      }
    }
    throw new Error(`\`${selector}\` block is unterminated in _page-contents.css`)
  }

  it('draws the body on the stated content surface rather than whatever sits behind the wrapper', () => {
    const block = blockFor('.table-wrap {')
    expect(block).toMatch(/background-color:\s*var\(--content-surface\)/)
  })

  it('thins the wide-table scrollbar via the standards properties, wrapped for the Chromium engine gotcha (OpenProject #3007)', () => {
    const block = blockFor('.table-scroll {')
    expect(block).toMatch(/overflow-x:\s*auto/)
    // -> Chromium 121+ ignores every `::-webkit-scrollbar*` rule on an element that also sets
    //    `scrollbar-width`/`scrollbar-color`, so the standards pair lives in its own
    //    `@supports not selector(::-webkit-scrollbar)` block instead, asserted below.
    expect(block).not.toMatch(/scrollbar-width/)
    expect(block).not.toMatch(/scrollbar-color/)

    const supportsBlock = blockFor('@supports not selector(::-webkit-scrollbar) {')
    expect(supportsBlock).toMatch(/scrollbar-width:\s*thin/)
    expect(supportsBlock).toMatch(
      /scrollbar-color:\s*var\(--content-table-scrollbar-thumb\)\s*var\(--content-table-scrollbar-track\)/
    )
  })

  it('never states scrollbar-width/scrollbar-color unwrapped alongside a ::-webkit-scrollbar* rule on the same selector, in the shared .table-scroll rule', () => {
    const scanSource = source.slice(tablesSectionStart)
    const lines = scanSource.split('\n')
    let depth = 0
    const supportsDepths = []
    for (const line of lines) {
      if (/@supports not selector\(::-webkit-scrollbar\)/.test(line)) {
        supportsDepths.push(depth)
      }
      const insideSupports = supportsDepths.length > 0
      if (/\b(scrollbar-width|scrollbar-color)\s*:/.test(line)) {
        expect(insideSupports, `"${line.trim()}" must be wrapped in @supports`).toBe(true)
      }
      depth += (line.match(/\{/g) || []).length
      depth -= (line.match(/\}/g) || []).length
      while (supportsDepths.length && depth <= supportsDepths[supportsDepths.length - 1]) {
        supportsDepths.pop()
      }
    }
  })

  it('gives the wide-table scrollbar the full webkit hover/drag treatment, off the same tokens, at a specificity that beats the aesthetic-scoped global rule regardless of file order', () => {
    expect(source).toMatch(
      /body \.table-scroll::-webkit-scrollbar-track\s*\{\s*background:\s*var\(--content-table-scrollbar-track\);/
    )
    expect(source).toMatch(
      /body \.table-scroll::-webkit-scrollbar-thumb\s*\{\s*background:\s*var\(--content-table-scrollbar-thumb\);/
    )
    expect(source).toMatch(
      /body \.table-scroll::-webkit-scrollbar-thumb:hover\s*\{\s*background-color:\s*var\(--content-table-scrollbar-thumb-hover\);/
    )
    expect(source).toMatch(
      /body \.table-scroll::-webkit-scrollbar-thumb:active\s*\{\s*background-color:\s*var\(--content-table-scrollbar-thumb-active\);/
    )
  })

  it('colours the table scrollbar off dedicated tokens per aesthetic, each with a rest/hover/drag triple, rather than the OS default', () => {
    // -> Ledger light
    expect(source).toMatch(/--content-table-scrollbar-thumb:\s*var\(--color-rule\);/)
    expect(source).toMatch(/--content-table-scrollbar-track:\s*var\(--color-tint-alt\);/)
    expect(source).toMatch(/--content-table-scrollbar-thumb-hover:\s*var\(--color-slate-faint\);/)
    expect(source).toMatch(
      /--content-table-scrollbar-thumb-active:\s*var\(--color-negative-fill\);/
    )
    // -> Ledger dark
    expect(source).toMatch(/--content-table-scrollbar-thumb:\s*var\(--color-hairline-dark\);/)
    expect(source).toMatch(/--content-table-scrollbar-track:\s*var\(--color-ink-dark\);/)
    expect(source).toMatch(/--content-table-scrollbar-thumb-hover:\s*var\(--color-border-dark\);/)
    expect(source).toMatch(/--content-table-scrollbar-thumb-active:\s*var\(--color-accent-dark\);/)
    // -> Cobalt light
    expect(source).toMatch(
      /--content-table-scrollbar-thumb:\s*var\(--color-sidebar-actions-text\);/
    )
    expect(source).toMatch(/--content-table-scrollbar-track:\s*var\(--color-paper\);/)
    expect(source).toMatch(/--content-table-scrollbar-thumb-hover:\s*var\(--color-slate-light\);/)
    expect(source).toMatch(
      /--content-table-scrollbar-thumb-active:\s*var\(--color-accent-strong\);/
    )
    // -> Cobalt dark -- drags to `--color-heading-h2`, not `--color-accent-strong`, which is a
    //    different, unrelated blue on this ground
    expect(source).toMatch(/--content-table-scrollbar-thumb:\s*rgba\(255,\s*255,\s*255,\s*0\.14\);/)
    expect(source).toMatch(/--content-table-scrollbar-track:\s*var\(--color-dark-3-5\);/)
    expect(source).toMatch(
      /--content-table-scrollbar-thumb-hover:\s*rgba\(255,\s*255,\s*255,\s*0\.3\);/
    )
    expect(source).toMatch(/--content-table-scrollbar-thumb-active:\s*var\(--color-heading-h2\);/)
    // -> No aesthetic sets a literal on a `.table-scroll` rule of its own; every colour flows
    //    through the shared token pair the `TABLES` section's rule consumes
    expect(source).not.toMatch(
      /\.table-scroll\s*\{\s*scrollbar-width:\s*thin;\s*scrollbar-color:\s*#c5cff5/
    )
    expect(source).not.toMatch(
      /\.table-scroll\s*\{\s*scrollbar-width:\s*thin;\s*scrollbar-color:\s*rgba\(255,\s*255,\s*255,\s*0\.14\)/
    )
  })

  it('gives the outer frame no overflow of its own, so it never clips a descendant that renders past its edge (OpenProject #2935)', () => {
    const block = blockFor('.table-wrap {')
    expect(block).not.toMatch(/overflow/)
  })

  it('puts the radius clip on .table-clip, an overflow:hidden box with nothing else on it, rather than on the scroller itself (OpenProject #2958)', () => {
    const clipBlock = blockFor('.table-clip {')
    expect(clipBlock).toMatch(/overflow:\s*hidden/)
    expect(clipBlock).toMatch(/border-radius:\s*var\(--content-table-radius\)/)
    // -> No scroll, no background, no border, no scrollbar tokens -- it exists purely to clip
    expect(clipBlock).not.toMatch(/overflow-x/)
    expect(clipBlock).not.toMatch(/scrollbar/)
    expect(clipBlock).not.toMatch(/background/)
    expect(clipBlock).not.toMatch(/border(?!-radius)/)
  })

  it("keeps the scroller's own radius off it now that .table-clip owns the clip -- an `overflow-x: auto` element's own border-radius doesn't reliably clip the native scrollbar it produces (OpenProject #2958)", () => {
    const scrollBlock = blockFor('.table-scroll {')
    expect(scrollBlock).toMatch(/overflow-x:\s*auto/)
    expect(scrollBlock).not.toMatch(/border-radius/)
  })

  it('gates the corner marks on the same --corner-marks token the page header plate and blockquote read, so Cobalt draws none', () => {
    const block = blockFor('.table-wrap::after {')
    expect(block).toMatch(/display:\s*var\(--content-table-corner-marks\)/)
    expect(source).toMatch(/--content-table-corner-marks:\s*var\(--corner-marks\)/)
  })

  it('draws exactly two opposite corners (top-left, bottom-right) in the blueprint mark colour, 7px long and 1px thick', () => {
    const block = blockFor('.table-wrap::after {')
    // -> Four gradient layers, not eight: only the two corners the spec names, never all four
    const gradientCount = (block.match(/linear-gradient\(var\(--color-slate-soft\)/g) || []).length
    expect(gradientCount).toBe(4)
    expect(block).toMatch(/0 0 \/ 7px 1px no-repeat/)
    expect(block).toMatch(/0 0 \/ 1px 7px no-repeat/)
    expect(block).toMatch(/100% 100% \/ 7px 1px\s*\n?\s*no-repeat/)
    expect(block).toMatch(/100% 100% \/ 1px 7px\s*\n?\s*no-repeat/)
    // -> Never the other diagonal (top-right / bottom-left)
    expect(block).not.toMatch(/100% 0/)
    expect(block).not.toMatch(/0 100%/)
  })

  it('positions the marks 4px outside the frame (OpenProject #2935), matching the page header plate and blockquote, and pointer-events:none so they never intercept a click', () => {
    const block = blockFor('.table-wrap::after {')
    // -> -5px against the frame's own 1px border is the 4px overhang, the same convention
    //    `.page-header-icon__marks` and the blockquote's `&::after` use
    expect(block).toMatch(/inset:\s*-5px;/)
    expect(block).toMatch(/pointer-events:\s*none/)
  })

  describe('real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser

    // -> Matches `renderers/markdown.js`'s output: every table token is a `<div>` carrying a
    //    `role`, and `thead`/`tbody` render as nothing, so a header row is just a row whose cells
    //    carry `role="columnheader"`.
    const SAMPLE = `
      <article class="page-contents">
        <div class="table-wrap">
          <div class="table-clip">
            <div class="table-scroll">
              <div role="table">
                <div role="row"><div role="columnheader">Key</div><div role="columnheader">Value</div></div>
                <div role="row"><div role="cell">alpha</div><div role="cell">1</div></div>
                <div role="row"><div role="cell">beta</div><div role="cell">2</div></div>
              </div>
            </div>
          </div>
        </div>
      </article>`

    // -> Wide enough that `.table-scroll` needs a horizontal scrollbar and, unscrolled, cuts the
    //    table off mid-content on the trailing edge -- the geometry that actually exercises the
    //    rounded-corner clip. A table that fits sits at its own natural edge either way.
    const WIDE_SAMPLE = `
      <article class="page-contents">
        <div class="table-wrap">
          <div class="table-clip">
            <div class="table-scroll">
              <div role="table">
                <div role="row">${Array.from({ length: 12 }, (_, i) => `<div role="columnheader">Column ${i + 1}</div>`).join('')}</div>
                <div role="row">${Array.from({ length: 12 }, (_, i) => `<div role="cell">Column ${i + 1} row1 value value</div>`).join('')}</div>
                <div role="row">${Array.from({ length: 12 }, (_, i) => `<div role="cell">Column ${i + 1} row2 value value</div>`).join('')}</div>
              </div>
            </div>
          </div>
        </div>
      </article>`

    async function measure({ dark: darkMode = false, cobalt = false, wide = false } = {}) {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        const bodyClasses = [darkMode ? 'body--dark' : '', cobalt ? 'body--cobalt' : '']
          .filter(Boolean)
          .join(' ')
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body class="${bodyClasses}">${wide ? WIDE_SAMPLE : SAMPLE}</body></html>`
        )
        return await page.evaluate(() => {
          const wrap = document.querySelector('.table-wrap')
          const clip = document.querySelector('.table-clip')
          const scroll = document.querySelector('.table-scroll')
          const wrapStyle = getComputedStyle(wrap)
          const clipStyle = getComputedStyle(clip)
          const scrollStyle = getComputedStyle(scroll)
          const afterStyle = getComputedStyle(wrap, '::after')
          const scrollThumbStyle = getComputedStyle(scroll, '::-webkit-scrollbar-thumb')
          const scrollTrackStyle = getComputedStyle(scroll, '::-webkit-scrollbar-track')
          return {
            background: wrapStyle.backgroundColor,
            scrollbarColor: scrollStyle.scrollbarColor,
            scrollbarWidth: scrollStyle.scrollbarWidth,
            // -> What real Chromium paints: with `::-webkit-scrollbar*` rules on `.table-scroll`,
            //    the standards `scrollbarColor`/`scrollbarWidth` above are not what it renders
            //    with -- colour resolves from the webkit pseudo-elements instead.
            scrollbarThumbColor: scrollThumbStyle.backgroundColor,
            scrollbarTrackColor: scrollTrackStyle.backgroundColor,
            marksDisplay: afterStyle.display,
            marksImage: afterStyle.backgroundImage,
            clipOverflow: clipStyle.overflow,
            clipRadius: clipStyle.borderRadius,
            scrollWidth: scroll.scrollWidth,
            clientWidth: scroll.clientWidth,
            scrollHeight: scroll.scrollHeight,
            clientHeight: scroll.clientHeight
          }
        })
      } finally {
        await page.close()
      }
    }

    /*
      `elementFromPoint` on a pixel inside the rounded corner's own arc is what proves the clip: a
      correctly-clipped corner resolves to `.table-wrap` or a page-content ancestor, never to a
      table role. A cell reaching that pixel means its square corner pokes past the rounded frame.
    */
    async function measureCornerContainment({
      dark: darkMode = false,
      cobalt = false,
      scrollToEnd = false
    } = {}) {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage({ viewport: { width: 500, height: 400 } })
      try {
        const bodyClasses = [darkMode ? 'body--dark' : '', cobalt ? 'body--cobalt' : '']
          .filter(Boolean)
          .join(' ')
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style>` +
            `<style>body{margin:0;padding:20px;}</style></head>` +
            `<body class="${bodyClasses}">${WIDE_SAMPLE}</body></html>`
        )
        return await page.evaluate((scrollAllTheWay) => {
          const wrap = document.querySelector('.table-wrap')
          const scroll = document.querySelector('.table-scroll')
          if (scrollAllTheWay) {
            scroll.scrollLeft = scroll.scrollWidth
          }
          const r = wrap.getBoundingClientRect()
          // -> Every element in the fixture is a `<div>`, so containment asks "does this pixel
          //    belong to a table role at all", not "which tag is here".
          function roleAt(x, y) {
            return document.elementFromPoint(x, y)?.getAttribute('role') ?? null
          }
          return {
            // -> Both guard a vacuous pass: the fixture must really overflow, and a `scrollToEnd`
            //    request must really have moved the scroller
            needsScroll: scroll.scrollWidth > scroll.clientWidth,
            scrolledToEnd: scroll.scrollLeft > 0,
            topRight: roleAt(r.x + r.width - 2, r.y + 2),
            bottomRight: roleAt(r.x + r.width - 2, r.y + r.height - 2)
          }
        }, scrollToEnd)
      } finally {
        await page.close()
      }
    }

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('paints the body surface white in light and the dark-3 panel rung in dark', async () => {
      const light = await measure({ dark: false })
      const dark = await measure({ dark: true })
      expect(light.background).toBe('rgb(255, 255, 255)')
      // -> `--color-dark-3` (`#1b1f2a`)
      expect(dark.background).toBe('rgb(27, 31, 42)')
    })

    it('colours the scrollbar thumb/track off the stated tokens in both themes, via the webkit pseudo-elements real Chromium actually paints (OpenProject #3007)', async () => {
      // -> `wide: true`: the narrow SAMPLE never overflows, so it grows no scrollbar for the
      //    webkit pseudo-elements to paint.
      const light = await measure({ dark: false, wide: true })
      const dark = await measure({ dark: true, wide: true })
      // -> `--color-rule` on `--color-tint-alt`
      expect(light.scrollbarThumbColor).toBe('rgb(201, 210, 226)')
      expect(light.scrollbarTrackColor).toBe('rgb(240, 242, 247)')
      // -> `--color-hairline-dark` on `--color-ink-dark`
      expect(dark.scrollbarThumbColor).toBe('rgb(42, 48, 64)')
      expect(dark.scrollbarTrackColor).toBe('rgb(20, 23, 31)')
    })

    it('never lets the standards scrollbar-width/-color apply in a browser that understands ::-webkit-scrollbar (the engine gotcha itself, proven against a real Chromium rather than only source-scanned)', async () => {
      // -> `@supports not selector(::-webkit-scrollbar)` is false in real Chromium, so the
      //    standards path is genuinely elided there, not merely superseded in the cascade.
      const light = await measure({ dark: false })
      expect(light.scrollbarWidth).toBe('auto')
    })

    it('draws the corner marks in Ledger and paints them in --color-slate-soft', async () => {
      const light = await measure({ dark: false })
      expect(light.marksDisplay).toBe('block')
      // -> #64789f
      expect(light.marksImage).toContain('rgb(100, 120, 159)')
    })

    it('draws no corner marks under Cobalt, which has its own rounded frame instead', async () => {
      const cobaltLight = await measure({ dark: false, cobalt: true })
      expect(cobaltLight.marksDisplay).toBe('none')
    })

    it("never inflates the scroller's own scrollable area for a table narrow enough to need no scrollbar -- the corner marks live on the outer frame now (OpenProject #2935), so their 4px overhang can never touch the scroller's scrollWidth/scrollHeight", async () => {
      const light = await measure({ dark: false })
      expect(light.scrollWidth).toBe(light.clientWidth)
      expect(light.scrollHeight).toBe(light.clientHeight)
    })

    it('resolves .table-clip to a real overflow:hidden box carrying the radius (OpenProject #2958)', async () => {
      const light = await measure({ dark: false, cobalt: true })
      expect(light.clipOverflow).toBe('hidden')
      // -> 8px, Cobalt's --radius-card
      expect(light.clipRadius).toBe('8px')
    })

    it("contains a wide, unscrolled Cobalt table's cell backgrounds to the frame's rounded corner rather than letting them poke a square corner past it (OpenProject #2958)", async () => {
      const cobaltLight = await measureCornerContainment({ dark: false, cobalt: true })
      const cobaltDark = await measureCornerContainment({ dark: true, cobalt: true })
      for (const result of [cobaltLight, cobaltDark]) {
        expect(result.needsScroll).toBe(true)
        // -> `roleAt` can return `null`, which a `.toMatch()` regex cannot take -- membership is
        //    the same check either way.
        expect(['columnheader', 'cell', 'row', 'table']).not.toContain(result.topRight)
        expect(['columnheader', 'cell', 'row', 'table']).not.toContain(result.bottomRight)
      }
    })

    /*
      The other end of the same table: scrolled to its trailing edge, the content sits at its own
      natural edge again rather than cut off mid-cell. Containment has to hold at both ends.
    */
    it("still contains a wide, fully-scrolled Cobalt table's cell backgrounds to the frame's rounded corner at the trailing edge, not just at the unscrolled position (OpenProject #3016)", async () => {
      const cobaltLight = await measureCornerContainment({
        dark: false,
        cobalt: true,
        scrollToEnd: true
      })
      const cobaltDark = await measureCornerContainment({
        dark: true,
        cobalt: true,
        scrollToEnd: true
      })
      for (const result of [cobaltLight, cobaltDark]) {
        expect(result.needsScroll).toBe(true)
        expect(result.scrolledToEnd).toBe(true)
        expect(['columnheader', 'cell', 'row', 'table']).not.toContain(result.topRight)
        expect(['columnheader', 'cell', 'row', 'table']).not.toContain(result.bottomRight)
      }
    })

    /*
      Proves the trailing column is actually draggable into view under `display: grid` +
      `grid-template-columns: subgrid`, not merely that `scrollWidth > clientWidth`.
    */
    it('actually scrolls a wide table horizontally: the last column is off-screen before scrolling and comes fully into view after', async () => {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage({ viewport: { width: 500, height: 400 } })
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body>${WIDE_SAMPLE}</body></html>`
        )
        const result = await page.evaluate(() => {
          const scroll = document.querySelector('.table-scroll')
          const lastCell = document.querySelector(
            '[role="row"]:last-child > [role="cell"]:last-child'
          )
          const before = lastCell.getBoundingClientRect()
          const scrollBox = scroll.getBoundingClientRect()
          scroll.scrollLeft = scroll.scrollWidth
          const after = lastCell.getBoundingClientRect()
          return {
            needsScroll: scroll.scrollWidth > scroll.clientWidth,
            cutOffBefore: before.right > scrollBox.right,
            // -> At or inside the scroller's own right edge: fully visible, not merely "moved some"
            visibleAfter: after.right <= scrollBox.right + 1
          }
        })
        expect(result.needsScroll).toBe(true)
        expect(result.cutOffBefore).toBe(true)
        expect(result.visibleAfter).toBe(true)
      } finally {
        await page.close()
      }
    })

    /*
      Measured at a fixed viewport width so "narrower than its container" is a real assertion
      rather than one that happens to pass at whatever width the runner gives it.
    */
    it("shrinks a narrow table's frame to its own content width instead of stretching to fill the container", async () => {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage({ viewport: { width: 800, height: 400 } })
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style>` +
            `<style>body{margin:0;padding:0;} .page-contents{width:700px;}</style></head>` +
            `<body>${SAMPLE}</body></html>`
        )
        const result = await page.evaluate(() => {
          const article = document.querySelector('.page-contents')
          const wrap = document.querySelector('.table-wrap')
          return {
            articleWidth: article.getBoundingClientRect().width,
            wrapWidth: wrap.getBoundingClientRect().width
          }
        })
        // -> Meaningfully narrower, not merely "not wider": the two short columns come nowhere
        //    near the 700px article width.
        expect(result.wrapWidth).toBeLessThan(result.articleWidth * 0.5)
      } finally {
        await page.close()
      }
    })

    it("still stretches a wide table to fill (and scroll past) the container, since fit-content never shrinks below the columns' natural width", async () => {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage({ viewport: { width: 800, height: 400 } })
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style>` +
            `<style>body{margin:0;padding:0;} .page-contents{width:700px;}</style></head>` +
            `<body>${WIDE_SAMPLE}</body></html>`
        )
        const result = await page.evaluate(() => {
          const article = document.querySelector('.page-contents')
          const wrap = document.querySelector('.table-wrap')
          const scroll = document.querySelector('.table-scroll')
          return {
            articleWidth: article.getBoundingClientRect().width,
            wrapWidth: wrap.getBoundingClientRect().width,
            needsScroll: scroll.scrollWidth > scroll.clientWidth
          }
        })
        expect(result.wrapWidth).toBeCloseTo(result.articleWidth, 0)
        expect(result.needsScroll).toBe(true)
      } finally {
        await page.close()
      }
    })
  })
})

describe('_page-contents.css table head/body (OpenProject #2916/#2919)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
  const tablesSectionStart = source.indexOf('\n  /* TABLES */\n')

  function blockFor(selector) {
    const start = source.indexOf(selector, tablesSectionStart)
    if (start === -1) {
      throw new Error(`\`${selector}\` not found in _page-contents.css -- has it moved?`)
    }
    let depth = 0
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '{') {
        depth += 1
      } else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          return source.slice(start, i + 1)
        }
      }
    }
    throw new Error(`\`${selector}\` block is unterminated in _page-contents.css`)
  }

  it('gives the wrapper no drop shadow at all -- `--content-table-shadow` is a single `none`, not a per-theme box-shadow', () => {
    const wrapBlock = blockFor('.table-wrap {')
    expect(wrapBlock).toMatch(/box-shadow:\s*var\(--content-table-shadow\)/)
    // -> Exactly once, at `none`: no aesthetic or dark override reintroduces a real shadow value.
    const shadowDeclarations = source.match(/--content-table-shadow:\s*[^;]+;/g) ?? []
    expect(shadowDeclarations).toHaveLength(1)
    expect(shadowDeclarations[0]).toMatch(/--content-table-shadow:\s*none;/)
  })

  it('paints the head as a plain tinted strip -- a flat `background-color`, never a `background-image`/gradient', () => {
    // -> There is no `thead` element to paint on, so the strip goes on each
    //    `[role="columnheader"]` cell; grid cells sit flush, so it still reads as one strip.
    const columnheaderBlock = blockFor("[role='columnheader'] {")
    expect(columnheaderBlock).toMatch(/background-color:\s*var\(--content-table-head\)/)
    expect(columnheaderBlock).toMatch(/color:\s*var\(--content-table-head-ink\)/)
    expect(columnheaderBlock).not.toMatch(/gradient/)
    expect(columnheaderBlock).not.toMatch(/background-image/)
  })

  it('bands the body on two stated row tones, with the plain row transparent rather than tinted', () => {
    const plainRowBlock = blockFor(
      "[role='row']:not(:has(> [role='columnheader'])) > [role='cell'] {"
    )
    expect(plainRowBlock).toMatch(/background-color:\s*var\(--content-table-row\)/)

    const bandedRowBlock = blockFor(
      "[role='row']:nth-child(even of [role='row']:not(:has(> [role='columnheader']))) > [role='cell'] {"
    )
    expect(bandedRowBlock).toMatch(/background-color:\s*var\(--content-table-row-alt\)/)

    // -> Ledger's plain-row token is `transparent`, not a wash.
    expect(source).toMatch(/--content-table-row:\s*transparent;/)
  })

  it('paints hover over the band, gated on a real hover capability, with the accent on the leading cell only', () => {
    const hoverStart = source.indexOf('@media (hover: hover) {', tablesSectionStart)
    expect(hoverStart).toBeGreaterThan(-1)
    const rowHoverBlock = blockFor(
      "[role='row']:not(:has(> [role='columnheader'])):not(:has(> [role='columnheader'])):hover\n      > [role='cell'] {"
    )
    expect(rowHoverBlock).toMatch(/background:\s*var\(--content-table-row-hover\)/)

    const hoverEdgeBlock = blockFor(
      "[role='row']:not(:has(> [role='columnheader'])):hover > [role='cell']:first-child {"
    )
    expect(hoverEdgeBlock).toMatch(/box-shadow:\s*var\(--content-table-hover-edge\)/)
  })

  it("ties the hover row selector to the zebra rule's specificity, so hover wins on a banded row (OpenProject #3039)", () => {
    // -> The zebra rule is `[role='row']` (1) + `:nth-child(even of S)` where S =
    //    `[role='row']:not(:has(>[role='columnheader']))` (2), so nth-child contributes 1+2=3, +
    //    `[role='cell']` (1) = 5. A single `:not(:has(...))` clause on the hover selector reaches
    //    only 4 and loses to the band whatever the source order. Duplicating the `:not()` clause
    //    (redundant, but valid) ties it at 5, and the later-declared hover rule then wins.
    const hoverSelectorOccurrences = source.match(
      /\[role='row'\]:not\(:has\(> \[role='columnheader'\]\)\):not\(:has\(> \[role='columnheader'\]\)\):hover\s*\n?\s*> \[role='cell'\] \{/g
    )
    expect(hoverSelectorOccurrences).toHaveLength(1)
  })

  it('would fail if the head went back to a dark title-bar gradient or the wrapper regained a real shadow', () => {
    // -> The assertions above are scoped to one block each, so a dark title-bar gradient or a real
    //    wrapper shadow could reappear elsewhere unseen; these two are checked file-wide.
    expect(source).not.toMatch(/--content-table-head-grade/)
    expect(source).not.toMatch(/--content-table-shadow:\s*0[^;]*rgba/)
  })
})

/**
 * Which cells get `data-table-selected`, and when, is `renderedContent.test.js`'s coverage; this
 * only proves the attribute paints something visible over both cell roles, in both themes.
 */
describe('_page-contents.css cell-range select mode highlight (OpenProject #3239)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')

  it('paints the selected-cell rule off the two dedicated select tokens, on both cell roles', () => {
    expect(source).toMatch(
      /\[role='columnheader'\](\[data-table-selected\]){5},\s*\n\s*\[role='cell'\](\[data-table-selected\]){5} \{/
    )
    expect(source).toMatch(
      /--content-table-select-bg:\s*color-mix\(in srgb, var\(--color-primary\)/
    )
    expect(source).toMatch(/--content-table-select-ring:\s*var\(--color-primary\)/)
  })

  describe('real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser

    const SAMPLE = `
      <article class="page-contents">
        <div class="table-wrap">
          <div class="table-scroll">
            <div role="table">
              <div role="row">
                <div role="columnheader" id="head-plain">Name</div>
                <div role="columnheader" id="head-selected" data-table-selected>Count</div>
              </div>
              <div role="row">
                <div role="cell" id="cell-plain">apples</div>
                <div role="cell" id="cell-selected" data-table-selected>3</div>
              </div>
            </div>
          </div>
        </div>
      </article>`

    async function measure({ dark: darkMode = false } = {}) {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body class="${darkMode ? 'body--dark' : ''}">${SAMPLE}</body></html>`
        )
        return await page.evaluate(() => {
          const styleOf = (id) => {
            const style = getComputedStyle(document.getElementById(id))
            return { background: style.backgroundColor, boxShadow: style.boxShadow }
          }
          return {
            cellPlain: styleOf('cell-plain'),
            cellSelected: styleOf('cell-selected'),
            headPlain: styleOf('head-plain'),
            headSelected: styleOf('head-selected')
          }
        })
      } finally {
        await page.close()
      }
    }

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('paints a visibly different background and an inset ring on a selected cell, over both a plain row and the head strip', async () => {
      const m = await measure()

      expect(m.cellSelected.background).not.toBe(m.cellPlain.background)
      expect(m.cellSelected.boxShadow).not.toBe('none')

      expect(m.headSelected.background).not.toBe(m.headPlain.background)
      expect(m.headSelected.boxShadow).not.toBe('none')
    })

    it('still paints the highlight in dark mode', async () => {
      const dark = await measure({ dark: true })

      expect(dark.cellSelected.background).not.toBe(dark.cellPlain.background)
      expect(dark.cellSelected.boxShadow).not.toBe('none')
    })
  })
})

/**
 * A source regex cannot tell a working subgrid from a broken one that declares the right
 * properties. Only real layout can prove the one thing it is there for: a column's width agreeing
 * across every row even though no selector knows the real column count.
 */
describe('_page-contents.css table CSS Grid column alignment (OpenProject #3015)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))

  const SAMPLE = `
    <article class="page-contents">
      <div class="table-wrap">
        <div class="table-clip">
          <div class="table-scroll">
            <div role="table">
              <div role="row">
                <div role="columnheader">A</div>
                <div role="columnheader">A much, much longer header for the second column</div>
                <div role="columnheader">C</div>
              </div>
              <div role="row">
                <div role="cell">A much longer first-column value than the header had</div>
                <div role="cell">short</div>
                <div role="cell">x</div>
              </div>
              <div role="row">
                <div role="cell">mid</div>
                <div role="cell">y</div>
                <div role="cell">z</div>
              </div>
              <div role="row">
                <div role="cell">bottom</div>
                <div role="cell">w</div>
                <div role="cell">z2</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>`

  describe('real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    async function measure() {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body>${SAMPLE}</body></html>`
        )
        return await page.evaluate(() => {
          const rows = [...document.querySelectorAll('[role="row"]')]
          const leftEdges = rows.map((row) => {
            const firstCell = row.firstElementChild
            return firstCell.getBoundingClientRect().x
          })
          const secondColLeftEdges = rows.map((row) => {
            const secondCell = row.children[1]
            return secondCell.getBoundingClientRect().x
          })
          const headerRow = rows[0]
          const bodyRows = rows.slice(1)
          return {
            leftEdges,
            secondColLeftEdges,
            headerBackground: getComputedStyle(headerRow.firstElementChild).backgroundColor,
            // -> First and third body rows are the plain band, the second the alt band.
            bodyRowBackgrounds: bodyRows.map(
              (row) => getComputedStyle(row.firstElementChild).backgroundColor
            )
          }
        })
      } finally {
        await page.close()
      }
    }

    it("lines every row's first column up on the same left edge, even though the rows' own content widths differ wildly", async () => {
      const { leftEdges } = await measure()
      // -> Had subgrid silently fallen back to independent per-row grids, the row with the long
      //    first-column value would push its own column 1 wider than the header's.
      expect(new Set(leftEdges).size).toBe(1)
    })

    it('lines every row up on the same second-column left edge too, sized off the longest content in that column across every row', async () => {
      const { secondColLeftEdges, leftEdges } = await measure()
      expect(new Set(secondColLeftEdges).size).toBe(1)
      // -> Confirms the columns are distinct tracks, not every cell collapsing onto the same one.
      expect(secondColLeftEdges[0]).toBeGreaterThan(leftEdges[0])
    })

    it('bands the first body row as plain and the second as alt, not the header row (nth-child(of S) skips it correctly)', async () => {
      const { headerBackground, bodyRowBackgrounds } = await measure()
      // -> `--content-table-head` in Ledger light, `#f0f2f7` -- the header row's own cell paints
      //    this directly, never the plain/alt body band, so the `:not(:has(> ...))` filter really
      //    does exclude it from the banding count.
      expect(headerBackground).toBe('rgb(240, 242, 247)')
      expect(bodyRowBackgrounds).toHaveLength(3)
      // -> `--content-table-row: transparent` -- `getComputedStyle` reports the declared value
      //    itself, not what shows through once composited against the wrapper's own white ground.
      expect(bodyRowBackgrounds[0]).toBe('rgba(0, 0, 0, 0)')
      // -> `--content-table-row-alt` in Ledger light, `#f7f8fb`
      expect(bodyRowBackgrounds[1]).toBe('rgb(247, 248, 251)')
      expect(bodyRowBackgrounds[2]).toBe('rgba(0, 0, 0, 0)')
    })

    it('lets a real :hover win over the band on a banded row, not just an unbanded one (OpenProject #3039)', async () => {
      // -> Only a real browser can tell a genuinely-tied specificity from one that merely looks
      //    tied. The second body row is the alt band (`--content-table-row-alt`, `#f7f8fb` in
      //    Ledger light), so an untied hover rule loses to it here regardless of the `:hover`.
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body>${SAMPLE}</body></html>`
        )
        const bandedRow = page.locator('[role="row"]').nth(2)
        await bandedRow.hover()
        const hoveredBackground = await bandedRow
          .locator('[role="cell"]')
          .first()
          .evaluate((cell) => getComputedStyle(cell).backgroundColor)
        // -> `--content-table-row-hover` in Ledger light, `#eef1f7` -- not the alt band's
        //    `rgb(247, 248, 251)` the un-hovered row asserts above.
        expect(hoveredBackground).toBe('rgb(238, 241, 247)')
      } finally {
        await page.close()
      }
    })
  })
})

/**
 * There is no real `<table>` element on a rendered page -- every table token is retagged to a
 * `<div>` -- and the WHATWG parser's "in body" insertion mode treats an orphan `<caption>` start
 * tag as a parse error and DROPS it, spilling its text out as a bare text node. No CSS selector can
 * match an element the parser never created, so `renderers/markdown.js` retags the caption to
 * `<div class="table-caption">` too; this covers what that depends on, the grid-column span and the
 * `order` fallback for bottom placement, which only real layout can prove.
 */
describe('_page-contents.css table caption spans the grid and honors caption-side (OpenProject #3023)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')

  it('spans the caption across every grid column, not just the first', () => {
    expect(source).toMatch(
      /\[role='table'\]\s*>\s*\.table-caption\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/s
    )
  })

  it("reorders a bottom-authored caption (the plugin's own inline caption-side: bottom) past the rows", () => {
    expect(source).toMatch(
      /\[role='table'\]\s*>\s*\.table-caption\[style\*=['"]caption-side: bottom['"]\]\s*\{\s*order:\s*1;/
    )
  })

  describe('real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    function sample(captionHtml) {
      return `
        <article class="page-contents">
          <div class="table-wrap">
            <div class="table-clip">
              <div class="table-scroll">
                <div role="table">
                  ${captionHtml}
                  <div role="row">
                    <div role="columnheader">A</div>
                    <div role="columnheader">B</div>
                  </div>
                  <div role="row">
                    <div role="cell">one</div>
                    <div role="cell">two</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </article>`
    }

    async function measure(captionHtml) {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body>${sample(captionHtml)}</body></html>`
        )
        return await page.evaluate(() => {
          const caption = document.querySelector('.table-caption')
          const firstColumnHeader = document.querySelector('[role="columnheader"]')
          const rows = [...document.querySelectorAll('[role="row"]')]
          return {
            // -> Confirms the parser kept the element at all, rather than dropping it the way it
            //    drops an orphan `<caption>`.
            captionFound: caption !== null,
            captionRect: caption.getBoundingClientRect(),
            firstColumnRect: firstColumnHeader.getBoundingClientRect(),
            // -> Compared against a row, which spans the same `1 / -1` area the caption should --
            //    not `[role="table"]`'s own box, which stretches to its container's full width
            //    regardless of the grid's content extent and would pass even if `grid-column` on
            //    the caption did nothing at all.
            rowRect: rows[0].getBoundingClientRect(),
            firstRowTop: rows[0].getBoundingClientRect().top,
            lastRowBottom: rows[rows.length - 1].getBoundingClientRect().bottom
          }
        })
      } finally {
        await page.close()
      }
    }

    it('spans the caption the same full width as a row, not just the first column', async () => {
      // -> The plugin only emits an inline style for a below-authored caption, so this is also the
      //    "no attribute selector to key off" case.
      const { captionFound, rowRect, captionRect, firstColumnRect } = await measure(
        '<div class="table-caption">A caption</div>'
      )
      expect(captionFound).toBe(true)
      expect(captionRect.width).toBeCloseTo(rowRect.width, 0)
      expect(captionRect.left).toBeCloseTo(rowRect.left, 0)
      expect(captionRect.width).toBeGreaterThan(firstColumnRect.width)
    })

    it('keeps a top-authored caption above the first row', async () => {
      const { captionRect, firstRowTop } = await measure(
        '<div class="table-caption">A caption</div>'
      )
      expect(captionRect.bottom).toBeLessThanOrEqual(firstRowTop)
    })

    it('moves a bottom-authored caption (inline caption-side: bottom) below the last row instead of on top of it', async () => {
      const { captionFound, captionRect, lastRowBottom } = await measure(
        '<div class="table-caption" style="caption-side: bottom">A caption</div>'
      )
      expect(captionFound).toBe(true)
      // -> `caption-side` has no effect on a grid child, so without `order` the caption stays the
      //    first DOM child and paints above the rows whatever the plugin's inline style says.
      expect(captionRect.top).toBeGreaterThanOrEqual(lastRowBottom)
    })

    it('still spans the full grid width once reordered to the bottom', async () => {
      const { rowRect, captionRect } = await measure(
        '<div class="table-caption" style="caption-side: bottom">A caption</div>'
      )
      expect(captionRect.width).toBeCloseTo(rowRect.width, 0)
    })
  })
})

describe('_page-contents.css article type scale (OpenProject #2963)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')

  it('sets the article base at 15.5px/1.72, not the old 16px/1.6', () => {
    expect(source).toMatch(/\.page-contents\s*\{[\s\S]*?font-size:\s*0\.96875rem;/)
    expect(source).toMatch(/\.page-contents\s*\{[\s\S]*?line-height:\s*1\.72;/)
  })

  it('pins h1/h3/h4 to their unchanged px sizes in `rem`, not the old `em` ratio against the base', () => {
    // -> `rem`, not `em`: em-relative to the 15.5px article base these would silently resolve to
    //    31px / 19.375px / 16.469px instead of the px sizes they are meant to hold.
    expect(source).toMatch(/h1\s*\{[\s\S]*?font-size:\s*2rem;/)
    expect(source).toMatch(/h3\s*\{\s*\n\s*\/\*[^*]*\*\/\s*\n\s*font-size:\s*1\.25rem;/)
    expect(source).toMatch(/h4\s*\{\s*\n\s*\/\*[^*]*\*\/\s*\n\s*font-size:\s*1\.0625rem;/)
  })

  it('moves h2 to the spec-drawn 26px, not the old 24px, and h6 to 13.5px, not the old 14px', () => {
    expect(source).toMatch(/h2\s*\{[\s\S]*?font-size:\s*1\.625rem;/)
    expect(source).toMatch(
      /h6\s*\{\s*\n\s*\/\*[^*]*\*\/\s*\n\s*font-size:\s*0\.84375rem;\s*\n\s*color:\s*var\(--content-ink-muted\)/
    )
  })

  it('leaves h5 as a bare `1em` -- it IS the base, so it tracks it exactly', () => {
    expect(source).toMatch(/h5\s*\{\s*\n\s*\/\*[^*]*\*\/\s*\n\s*font-size:\s*1em;\s*\n\s*\}/)
  })

  it('pins li to 15px/1.6 and inline code to 14px, in `rem`, not inherited-and-scaled from the base', () => {
    expect(source).toMatch(
      /li\s*\{\s*\n\s*\/\*[^*]*\*\/\s*\n\s*font-size:\s*0\.9375rem;\s*\n\s*line-height:\s*1\.6;/
    )
    expect(source).toMatch(/\bcode\s*\{[\s\S]*?font-size:\s*0\.875rem;\s*\n\s*\}/)
  })

  it('pins blockquote/callout to 14.5px/1.6, and leaves pre code at its already-correct 13px/1.75', () => {
    expect(source).toMatch(
      /blockquote\s*\{[\s\S]*?font-size:\s*0\.90625rem;[\s\S]*?line-height:\s*1\.6;/
    )
    expect(source).toMatch(/pre\s*\{[\s\S]*?font-size:\s*0\.8125rem;[\s\S]*?line-height:\s*1\.75;/)
  })

  it('never re-scopes any of this to `body.body--cobalt` -- the design handoff draws one ramp for both aesthetics', () => {
    const cobaltStart = source.indexOf('body.body--cobalt &')
    expect(cobaltStart).toBeGreaterThan(-1)
    // -> Proving the negative precisely would need a per-block parse; every `body.body--cobalt`
    //    block in this file is a short token/colour override, never a font-size declaration.
    const cobaltBlocks = [...source.matchAll(/body\.body--cobalt & \{/g)]
    expect(cobaltBlocks.length).toBeGreaterThan(0)
  })

  describe('real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser

    const SAMPLE = `
      <article class="page-contents">
        <h1>Heading one</h1>
        <h2>Heading two</h2>
        <h3>Heading three</h3>
        <h4>Heading four</h4>
        <h5>Heading five</h5>
        <h6>Heading six</h6>
        <p>A paragraph with <code>inline code</code> in it.</p>
        <ul><li>A list item</li></ul>
        <blockquote><p>A quoted line.</p></blockquote>
        <pre class="codeblock"><code>const x = 1</code></pre>
      </article>`

    async function measure({ dark: darkMode = false, cobalt = false } = {}) {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
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
          const sizeOf = (selector) => {
            const style = getComputedStyle(document.querySelector(selector))
            return { fontSize: style.fontSize, lineHeight: style.lineHeight }
          }
          return {
            article: sizeOf('.page-contents'),
            p: sizeOf('p'),
            li: sizeOf('li'),
            h1: sizeOf('h1'),
            h2: sizeOf('h2'),
            h3: sizeOf('h3'),
            h4: sizeOf('h4'),
            h5: sizeOf('h5'),
            h6: sizeOf('h6'),
            inlineCode: sizeOf('p code'),
            blockquote: sizeOf('blockquote'),
            preCode: sizeOf('pre.codeblock')
          }
        })
      } finally {
        await page.close()
      }
    }

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('resolves the whole ramp to the spec-drawn absolute px, in Ledger', async () => {
      const m = await measure()
      expect(m.article.fontSize).toBe('15.5px')
      expect(m.p.fontSize).toBe('15.5px')
      expect(m.li.fontSize).toBe('15px')
      expect(m.li.lineHeight).toBe('24px') // -> 15 * 1.6
      expect(m.h1.fontSize).toBe('32px')
      expect(m.h2.fontSize).toBe('26px')
      expect(m.h3.fontSize).toBe('20px')
      expect(m.h4.fontSize).toBe('17px')
      expect(m.h5.fontSize).toBe('15.5px')
      expect(m.h6.fontSize).toBe('13.5px')
      expect(m.inlineCode.fontSize).toBe('14px')
      expect(m.blockquote.fontSize).toBe('14.5px')
      expect(m.blockquote.lineHeight).toBe('23.2px') // -> 14.5 * 1.6
      expect(m.preCode.fontSize).toBe('13px')
    })

    it('resolves to the identical ramp under Cobalt -- this fix is deliberately not aesthetic-scoped', async () => {
      const [ledger, cobalt] = await Promise.all([measure(), measure({ cobalt: true })])
      for (const key of [
        'article',
        'p',
        'li',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'inlineCode',
        'blockquote',
        'preCode'
      ]) {
        expect(cobalt[key].fontSize).toBe(ledger[key].fontSize)
      }
    })

    it('holds the same ramp in dark mode -- this fix touches size, never colour or theme', async () => {
      const [light, dark] = await Promise.all([measure(), measure({ dark: true })])
      for (const key of [
        'article',
        'p',
        'li',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'inlineCode',
        'blockquote',
        'preCode'
      ]) {
        expect(dark[key].fontSize).toBe(light[key].fontSize)
      }
    })
  })
})

/**
 * Under Cobalt, h2 alone carries the accent and h1 takes plain body ink: a locked design decision,
 * and the reason `--content-h1` needs its own override rather than inheriting the Ledger default's
 * saturated `--color-ink`, which would put both headings in the same blue register.
 */
describe('_page-contents.css cobalt h1 ink (OpenProject #2964)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
  const cobaltBlockStart = source.indexOf('body.body--cobalt & {')
  const cobaltDarkBlockStart = source.indexOf('body.body--cobalt.body--dark & {')
  if (cobaltBlockStart === -1 || cobaltDarkBlockStart === -1) {
    throw new Error(
      'body.body--cobalt block(s) not found in _page-contents.css -- have they moved?'
    )
  }
  const cobaltBlock = source.slice(cobaltBlockStart, cobaltDarkBlockStart)

  it('overrides --content-h1 to the plain body-ink token inside the Cobalt block, not the saturated --color-ink h2 shares the register with', () => {
    expect(cobaltBlock).toMatch(/--content-h1:\s*var\(--color-text-body\);/)
    expect(cobaltBlock).not.toMatch(/--content-h1:\s*var\(--color-ink\);/)
  })

  it('leaves --content-h2 and its accent color completely untouched by this fix', () => {
    expect(cobaltBlock).toMatch(/--content-h2:\s*var\(--color-heading-h2\);/)
  })

  it("declares no --content-h1 override in the Cobalt-dark block -- --color-text-body is already re-declared for dark in tailwind.css, so the light block's var() is expected to re-resolve through the cascade with no second override needed here", () => {
    const cobaltDarkBlockEnd = source.indexOf('\n  }', cobaltDarkBlockStart)
    const cobaltDarkBlock = source.slice(cobaltDarkBlockStart, cobaltDarkBlockEnd)
    expect(cobaltDarkBlock).not.toMatch(/--content-h1:/)
  })

  describe('real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser

    const SAMPLE = `
      <article class="page-contents">
        <h1>Heading one</h1>
        <h2>Heading two</h2>
      </article>`

    async function measureHeadingColors({ dark: darkMode = false } = {}) {
      const contentCss = readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      const appCss = await buildAppCss()
      const page = await browser.newPage()
      try {
        const bodyClasses = ['body--cobalt', darkMode ? 'body--dark' : ''].filter(Boolean).join(' ')
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body class="${bodyClasses}">${SAMPLE}</body></html>`
        )
        return await page.evaluate(() => {
          const h1 = document.querySelector('.page-contents h1')
          const h2 = document.querySelector('.page-contents h2')
          return {
            h1Color: getComputedStyle(h1).color,
            h2Color: getComputedStyle(h2).color
          }
        })
      } finally {
        await page.close()
      }
    }

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('resolves h1 to Cobalt light body ink (#1a2038), distinct from h2 (#1f4fd6)', async () => {
      const { h1Color, h2Color } = await measureHeadingColors()
      expect(h1Color).toBe('rgb(26, 32, 56)') // #1a2038
      expect(h2Color).toBe('rgb(31, 79, 214)') // #1f4fd6
      expect(h1Color).not.toBe(h2Color)
      // -> Never the aesthetic's saturated navy `--color-ink` (#10194a)
      expect(h1Color).not.toBe('rgb(16, 25, 74)')
    })

    it('resolves h1 to Cobalt dark body ink (#e8ecff), distinct from h2 (#8fb0ff), via the cascade alone', async () => {
      const { h1Color, h2Color } = await measureHeadingColors({ dark: true })
      expect(h1Color).toBe('rgb(232, 236, 255)') // #e8ecff
      expect(h2Color).toBe('rgb(143, 176, 255)') // #8fb0ff
      expect(h1Color).not.toBe(h2Color)
    })
  })
})

describe('_page-contents.css definition lists (OpenProject #3585)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.css'), 'utf-8')

  function blockFor(selector) {
    const start = source.indexOf(selector)
    if (start === -1) {
      throw new Error(`\`${selector}\` not found in _page-contents.css -- has it moved?`)
    }
    let depth = 0
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
      if (source[i] === '{') {
        depth += 1
      } else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) {
          return source.slice(start, i + 1)
        }
      }
    }
    throw new Error(`\`${selector}\` block is unterminated in _page-contents.css`)
  }

  const dl = blockFor('\n  dl {')
  const dt = blockFor('\n  dt {')
  const dd = blockFor('\n  dd {')

  it('gives dl the same bottom margin as ul/ol', () => {
    expect(dl).toMatch(/margin:\s*0 0 1\.15em;/)
  })

  it('sets dt at weight 600 with a top margin, none on the first term', () => {
    expect(dt).toMatch(/font-weight:\s*600;/)
    expect(dt).toMatch(/margin-top:\s*0\.9em;/)
    expect(dt).toMatch(/&:first-child\s*\{\s*margin-top:\s*0;\s*\}/)
  })

  it('insets dd by the list inset via a logical property', () => {
    expect(dd).toMatch(/margin-inline-start:\s*1\.6em;/)
  })

  it('keeps one-paragraph definitions tight, spaces multi-paragraph ones and sits nested lists close', () => {
    expect(dd).toMatch(/>\s*p\s*\{\s*margin:\s*0;\s*\+\s*p\s*\{\s*margin-top:\s*0\.6em;/)
    expect(dd).toMatch(/>\s*ul,\s*>\s*ol\s*\{\s*margin:\s*0\.35em 0 0;/)
  })

  it('carries no physical margin/padding/border -left or -right', () => {
    for (const block of [dl, dt, dd]) {
      expect(block).not.toMatch(/(?:margin|padding|border)-(?:left|right)/)
    }
  })

  it('draws no rule down the definition and takes no colour of its own', () => {
    for (const block of [dl, dt, dd]) {
      expect(block).not.toMatch(/border/)
      expect(block).not.toMatch(/box-shadow/)
      expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    }
  })

  describe('real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser
    let stylesheets

    const SAMPLE = `
      <article class="page-contents">
        <dl>
          <dt>Term one</dt>
          <dd><p>First definition.</p></dd>
          <dt>Term two</dt>
          <dd><p>Para A.</p><p>Para B.</p></dd>
        </dl>
        <p>After.</p>
      </article>`

    async function measure({ dark = false, cobalt = false, rtl = false } = {}) {
      const { appCss, contentCss } = stylesheets
      const page = await browser.newPage()
      try {
        const bodyClasses = [dark ? 'body--dark' : '', cobalt ? 'body--cobalt' : '']
          .filter(Boolean)
          .join(' ')
        await page.setContent(
          `<!doctype html><html${rtl ? ' dir="rtl"' : ''}><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body class="${bodyClasses}">${SAMPLE}</body></html>`
        )
        return await page.evaluate(() => {
          const dts = document.querySelectorAll('dt')
          const dds = document.querySelectorAll('dd')
          const ps = dds[1].querySelectorAll('p')
          const proseP = getComputedStyle(document.querySelector('dd p'))
          return {
            dlMarginBottom: getComputedStyle(document.querySelector('dl')).marginBottom,
            dtWeight: getComputedStyle(dts[0]).fontWeight,
            dtColor: getComputedStyle(dts[0]).color,
            ddColor: getComputedStyle(dds[0]).color,
            dt1MarginTop: getComputedStyle(dts[0]).marginTop,
            dt2MarginTop: getComputedStyle(dts[1]).marginTop,
            ddMarginLeft: getComputedStyle(dds[0]).marginLeft,
            ddMarginRight: getComputedStyle(dds[0]).marginRight,
            ddBorderLeft: getComputedStyle(dds[0]).borderLeftWidth,
            ddBorderRight: getComputedStyle(dds[0]).borderRightWidth,
            tightParaMargin: proseP.marginBottom,
            secondParaMarginTop: getComputedStyle(ps[1]).marginTop
          }
        })
      } finally {
        await page.close()
      }
    }

    beforeAll(async () => {
      browser = await chromium.launch()
      stylesheets = {
        appCss: await buildAppCss(),
        contentCss: readFileSync(join(dir, '_page-contents.css'), 'utf-8')
      }
    })

    afterAll(async () => {
      await browser?.close()
    })

    it.each([
      ['Ledger light', {}],
      ['Ledger dark', { dark: true }],
      ['Cobalt light', { cobalt: true }],
      ['Cobalt dark', { cobalt: true, dark: true }]
    ])('draws a bold term and an inset, ruleless definition under %s', async (_name, opts) => {
      const m = await measure(opts)
      expect(m.dtWeight).toBe('600')
      expect(m.dtColor).toBe(m.ddColor)
      expect(m.dt1MarginTop).toBe('0px')
      expect(parseFloat(m.dt2MarginTop)).toBeGreaterThan(0)
      expect(parseFloat(m.ddMarginLeft)).toBeGreaterThan(0)
      expect(m.ddBorderLeft).toBe('0px')
      expect(m.ddBorderRight).toBe('0px')
      expect(m.tightParaMargin).toBe('0px')
      expect(parseFloat(m.secondParaMarginTop)).toBeGreaterThan(0)
      expect(parseFloat(m.dlMarginBottom)).toBeGreaterThan(0)
    })

    it('mirrors the definition inset under RTL', async () => {
      const m = await measure({ rtl: true })
      expect(m.ddMarginLeft).toBe('0px')
      expect(parseFloat(m.ddMarginRight)).toBeGreaterThan(0)
    })
  })
})
