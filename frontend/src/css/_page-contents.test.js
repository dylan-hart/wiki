import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileStringAsync } from 'sass'

import { buildAppCss, chromium, hasChromium } from '../../test/realGridLayout.js'

/**
 * OpenProject #834 ("RTL regression pass: linklist rendering + zoom/toolbar mirroring").
 *
 * `ul.links-list` (added by commit aa279332, after Feature 413's RTL audit landed -- see
 * `docs/variances.md`'s "Feature 413" entry -- so it never went through that pass) rendered its
 * accent bar and description rule with physical `border-left`/`padding-left`/`margin-left`. Content
 * rendered from markdown reads whatever direction the active locale sets
 * (`composables/direction.js`), same as any other reader-facing content -- there is no separate
 * "content direction" concept, only the document's. Under `dir="rtl"` those physical properties stay
 * glued to the visual left, i.e. the TRAILING edge of an RTL row: the accent bar sits behind the
 * title instead of leading it in, and the description's rule/gap land on the wrong side of the
 * emphasis text -- this is upstream requarks/wiki #1639 ("link-list rendering breaks under RTL"),
 * reproduced directly by this fork's own `{.links-list}` markup.
 *
 * Fixed the same mechanical way as `.count-badge` (task 721/727, asserted by
 * `layouts/AdminLayout.test.js`): physical `-left` replaced with logical `-inline-start`, which
 * resolves against `dir` on its own with no JS involved. This is a source-level regression test in
 * the same style as that one -- `_page-contents.scss` is a plain stylesheet partial applied to raw
 * rendered markdown, not a mountable component, so there is no Vue tree to inspect computed styles
 * on; asserting the compiled-from source is the direct way to pin the fix down.
 */
describe('_page-contents.scss ul.links-list', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.scss'), 'utf-8')
  const start = source.indexOf('ul.links-list {')
  const end = source.indexOf('@media (prefers-reduced-motion: reduce) {', start)
  if (start === -1 || end === -1) {
    throw new Error(
      'ul.links-list block not found in _page-contents.scss -- has it moved or been renamed?'
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
 * OpenProject #1694 ("Convert `_page-contents.scss` to logical properties so rendered wiki content
 * works in RTL"), filed from the 2026-08-24 audit (`docs/audit-2026-08-24/accessibility-i18n.md`
 * §9) -- the same defect the `ul.links-list` suite above pins down for one construct
 * (`docs/variances.md`'s "Feature 413" entry explains why that one slipped through the original RTL
 * pass), applied here to the rest of the file: blockquotes, the five admonition severities, the
 * code line-number gutter, and multi-line tables, none of which went through that pass either.
 *
 * `.page-contents` styles RAW RENDERED MARKDOWN -- the one surface that always renders in the
 * content's own direction, never the app chrome's -- so every rule in this file has to resolve
 * against `dir`, not against a hardcoded screen side. This suite scans the WHOLE compiled source
 * rather than one selector's slice, because the bug class is "a physical property snuck back in
 * anywhere in this file", not "in one specific rule" -- the same reasoning the file's own governing
 * work package gives for widening the `ul.links-list` slice into a full-file scan.
 *
 * One deliberate exception: `pre { … direction: ltr … }` (see that rule's own header comment) pins
 * every code block to always read left-to-right, because there is no such thing as RTL source code.
 * Logical properties resolve against an element's OWN computed `direction`, so anything nested
 * inside that rule stays visually stable either way even if it happens to use a physical property --
 * this suite carves that one block out of the scan rather than special-casing selectors by name.
 */
describe('_page-contents.scss logical properties (whole file)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.scss'), 'utf-8')

  // -> The single rule that pins its subtree to `direction: ltr`; see its own comment for why a
  //    physical property inside it (there happen to be none left) would still be safe under RTL.
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
    // -> The quote is a framed box now, not a bare bar: the band down its leading edge is a
    //    `::before` sized in `inset-inline-start`, precisely so it follows `dir` -- an inset
    //    `box-shadow`, which is what a physical implementation would reach for, could not.
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

  it('rounds the admonition corners opposite the accent bar via logical corner properties', () => {
    expect(source).toMatch(/border-start-end-radius:\s*6px;\s*border-end-end-radius:\s*6px;/)
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
      /th,\s*td\s*\{[^}]*border-inline-end:\s*1px solid var\(--content-rule\)/s
    )
    expect(source).toMatch(/tr\s*>\s*:last-child\s*\{\s*border-inline-end:\s*0;\s*\}/)
    expect(source).toMatch(
      /thead th\s*\{\s*border-inline-end-color:\s*var\(--content-table-head-rule\)/
    )
  })

  it("aligns table cells and the caption to the logical start, leaving room for markdown's own explicit `---:` alignment", () => {
    expect(source).toMatch(/th,\s*td\s*\{[^}]*text-align:\s*start;/s)
    expect(source).toMatch(/caption\s*\{[^}]*text-align:\s*start;/s)
  })
})

/**
 * OpenProject #2783 ("Literal-color grep sweep"). `--content-info`, `--content-danger` and
 * `--content-important` used to restate `--color-info`/`--color-negative`/`--color-ink`'s hex
 * literally instead of referencing them, the one inconsistency in this block -- every sibling
 * status/tick/code property beside them (`--content-tick`, `--content-code-ink`,
 * `--content-code-edge`, ...) already resolves through `var(--color-*)`. A literal copy here would
 * silently stop following a re-themed/re-skinned value the token itself would pick up.
 *
 * `--content-success`/`--content-warning` are the same shape and are NOT part of this fix (see
 * OpenProject #2783's own comment log) -- left as a known, separately-tracked case rather than
 * silently folded into this pass.
 */
describe('_page-contents.scss admonition tones resolve through the color token', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.scss'), 'utf-8')

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
 * OpenProject #2630 ("Rendered content beyond prose: task lists, footnotes, keyboard keys and the
 * code-token palette") -- item 6 of `docs/cardinal-reskin-second-pass.md`'s "Still to do" list.
 *
 * The second pass brought the PROSE half of a rendered page onto Cardinal and left these four
 * constructs behind, each still drawn in the vocabulary that preceded it. Asserted from source for
 * the same reason the two suites above are: `_page-contents.scss` is a stylesheet partial over raw
 * rendered markdown, not a mountable component, and jsdom paints nothing -- there is no computed
 * style to read and no layout to measure. What CAN be pinned from source is that a specific
 * pre-Cardinal treatment is gone and the design's own one is in its place, which is exactly the
 * thing a later edit would silently undo.
 *
 * The colour half of the same work is pinned numerically instead, in
 * `helpers/accessibility.test.js` -- a hex in a stylesheet is only right relative to the ground it
 * lands on, and that is a contrast assertion, not a source one.
 */
describe('_page-contents.scss rendered content beyond prose', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.scss'), 'utf-8')

  /** The declarations of one selector's block, given the selector's own opening line. */
  function blockFor(selector) {
    const start = source.indexOf(selector)
    if (start === -1) {
      throw new Error(`\`${selector}\` not found in _page-contents.scss -- has it moved?`)
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
    throw new Error(`\`${selector}\` block is unterminated in _page-contents.scss`)
  }

  describe('task-list checkbox', () => {
    const block = blockFor('.task-list-item-checkbox {')

    it('draws a done item in the accent rather than the grey that was in no palette', () => {
      expect(block).toMatch(/background-color:\s*var\(--content-tick\)/)
      expect(source).toMatch(/--content-tick:\s*var\(--color-accent-fill\)/)
      expect(source).toMatch(/--content-tick:\s*var\(--color-accent-dark\)/)
      // -> `#5b616b` is a tone Cardinal does not have; it was the one thing on a rendered page
      //    saying "done" in a colour that appears nowhere else in the app. (The stylesheet still
      //    NAMES it, in the comment recording why it went, so this checks the declaration.)
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
     * The locked dark-theme rule -- an accent FILL carries dark ink, never white. A tick is a data
     * URI, so its stroke cannot be a custom property and the two themes need two URIs; a single one
     * recoloured by a filter is exactly what "dark mode is a second palette, not a filter" rules out.
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
      // -> The lip of a physical key. Cardinal has no bevelled or weighted object anywhere on it.
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
      // -> `--content-mark` is the author's own `<mark>` highlighter and keeps its yellow; being
      //    sent to a note is a different statement and takes the language's accent wash.
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

    /*
     * The block prints on white, so the print block is the one place the palette inverts: black ink,
     * a plain rule for the accent edge, and the white-ground token set the screen palette used to be
     * -- which is the same set `helpers/accessibility.test.js` proves is wrong on screen and right
     * on paper.
     */
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
 * OpenProject #2630, the other half: what a browser actually PAINTS for these four constructs.
 *
 * Everything above reads the stylesheet. That catches a treatment being replaced, and cannot catch
 * the two things most likely to go wrong here -- a custom property that resolves to nothing because
 * the token it names does not exist, and a rule that loses the cascade to a more specific one
 * (`.footnotes .footnote-item`'s padding against `.footnote-item.is-anchor-landed`'s is exactly
 * that shape). Neither jsdom nor happy-dom resolves a `var()` chain or runs the cascade over real
 * stylesheets, so both would report the source's intent back rather than the result.
 *
 * So this compiles the real `_page-contents.scss` beside the real `tailwind.css` -- the two files
 * that between them own every token in the chain -- and reads `getComputedStyle` off actual
 * rendered-markdown markup in a real headless Chromium, once light and once with `body--dark` on,
 * which is how the app itself switches theme. Same harness rule as every other real-browser suite
 * in this repo: `hasChromium`/`buildAppCss`/`chromium` are imported from `test/realGridLayout.js`
 * and nothing is added to it; see `components/ApiKeyCreateDialog.test.js` for why the timeout is
 * raised well past the 5s default.
 */
describe(
  '_page-contents.scss rendered content beyond prose — real browser',
  { skip: !hasChromium(), timeout: 60000 },
  () => {
    let browser
    let light
    let dark

    /*
     * One sample of each construct, in the markup the renderers actually emit:
     * `markdown-it-task-lists` (with `label: false`) for the checkbox, `markdown-it-footnote` for
     * the note apparatus, highlight.js's own token classes inside `pre.codeblock`, and a `<kbd>`.
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

    /*
      The two stylesheets that between them own every token in the chain: `tailwind.css` declares
      the Cardinal palette, `_page-contents.scss` maps it onto the article's own properties. Sass
      compiles the partial directly rather than through `app.scss`, with the same load path
      `vite.config.js` gives it -- `@use 'palette'` is the one module it reaches for.
    */
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

    /** Every computed value the assertions below need, read in one pass off one rendered page. */
    async function measure(darkMode) {
      const { appCss, contentCss } = stylesheets
      const page = await browser.newPage()
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${appCss}</style><style>${contentCss}</style></head>` +
            `<body class="${darkMode ? 'body--dark' : ''}">${SAMPLE}</body></html>`
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
              comment: styleOf('.hljs-comment').color
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
      light = await measure(false)
      dark = await measure(true)
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
     * The cascade case. `.footnotes .footnote-item` sets `padding: 0.7em 0`, and
     * `.footnote-item.is-anchor-landed` has to win the leading edge back off it at equal
     * specificity -- which it does only because it is declared later in the file. Source-reading
     * cannot see that; this is the assertion that catches it if either block ever moves.
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
