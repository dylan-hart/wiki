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
    // -> OpenProject #2916 split the single `--content-rule` table border into its own
    //    `--content-table-col-rule`/`--content-table-rule` pair (see that WP), so the cell rule
    //    itself moved off `--content-rule` -- the logical-property shape this test guards is
    //    unchanged either way. OpenProject #2997/#3014/#3015 moved the markup from
    //    `<table>`/`<th>`/`<td>`/`<thead>` to `div[role="table"]`/`[role="columnheader"]`/
    //    `[role="cell"]`, which is the selector shape below, not the table-element one.
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

  /*
   * OpenProject #870/#2789: `.glossary-term` is `renderers/modules/markdown-it-glossary.js`'s own
   * class, put on BOTH forms it can emit -- an unlinked `<abbr class="glossary-term">` and a linked
   * `<a class="glossary-term">`. The unlinked form happened to already get a dotted underline from
   * the pre-existing `abbr[title]` rule (both share the `abbr` tag), which is why this went
   * unnoticed for the linked form: the generic `a` rule sets `text-decoration: none` and nothing
   * overrode it for this class specifically, until this rule was added.
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
    let cobaltLight
    let cobaltDark

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

    /**
     * Every computed value the assertions below need, read in one pass off one rendered page.
     *
     * `cobalt` (OpenProject #2774) stacks `body--cobalt` alongside `body--dark` the same way the app
     * itself does (`composables/aesthetic.js`) -- both classes on the one `<body>`, not a separate
     * page per combination beyond what `dark` already gives this function.
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

    /**
     * OpenProject #2774: the code block gains an 8px rounded panel and drops its accent leading edge
     * under Cobalt (`Page View 3x - Cobalt`/`Editor 3x - Cobalt`), while Ledger keeps its own square,
     * accent-edged treatment unchanged in both themes.
     */
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

/**
 * OpenProject #2977 ("Cobalt typography: article remainder"). `cobalt-typography.md` §3's Article
 * role table, for every role that Task's sibling Bugs (#2963 base/heading sizes, #2964 h1 color,
 * #2965 numbered-step em sizing, #2958 table corner-clipping) don't already own. Reading the source
 * against `tailwind.css`'s Cobalt token blocks found two genuine gaps -- inline code ink and the code
 * block's own ink -- and confirmed every other role in the table (h2, h3-h5, h6, paragraph,
 * numbered-step text, code block background, the syntax tones, links in prose) already resolves
 * correctly through existing tokens with no Cobalt-scoped size/weight/tracking property needed
 * anywhere in this file. Same real-browser harness shape as the describe above: a fresh `measure()`
 * over its own minimal sample, since that one's `SAMPLE` has no headings, paragraph or `<a>` to read.
 */
describe(
  '_page-contents.scss article role-table conformance — real browser (OpenProject #2977)',
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
      const [appCss, content] = await Promise.all([
        buildAppCss(),
        compileStringAsync(readFileSync(join(cssDir, '_page-contents.scss'), 'utf-8'), {
          loadPaths: [cssDir]
        })
      ])
      return { appCss, contentCss: content.css }
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
      // -> `--color-text-body`, resolved through `--content-ink`/`--content-h2` inheritance -- not
      //    `--color-ink`'s navy, which is what "all blue" (#0.2) was.
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
      // -> `--color-accent-strong`: same hex as `--color-heading-h2` in Cobalt light (both #1f4fd6),
      //    but NOT in dark -- the dedicated dark-cobalt `--content-link` override this file already
      //    carries points links at the cool #7fa0ff, not the warm accent-dark a plain `.body--dark`
      //    cascade would otherwise give them.
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
      // -> `#e6eaff`, not Ledger's `--color-text-dark` (`#e6eaf2`) the generic token would otherwise
      //    resolve to.
      expect(cobaltLight.codeBlock).toBe('rgb(230, 234, 255)')
      expect(cobaltDark.codeBlock).toBe(cobaltLight.codeBlock)
      expect(light.codeBlock).not.toBe(cobaltLight.codeBlock)
    })
  }
)

/**
 * OpenProject #2977, re-verifying §4 role swap #1 (table head) as part of this sweep: already
 * tokenized before this Task, but the WP calls for a direct check that the Cobalt block actually
 * sets sentence case with no tracking, not just that the tokens exist. Source-level, matching
 * `cobaltTokens.test.js`'s own "assert against the declared text" pattern for a hand-edited
 * property list with no compiled stylesheet in this environment to read a `var()` cascade off of.
 */
describe('_page-contents.scss Cobalt table-head swap stays sentence-case with no tracking (§4.1)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.scss'), 'utf-8')
  const cobaltBlockStart = source.indexOf('@at-root body.body--cobalt &')
  const cobaltBlockEnd = source.indexOf('@at-root body.body--cobalt.body--dark &')
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

/**
 * OpenProject #2883 ("Cobalt list rendering (numbered steps, bullets, nested lists, task lists)
 * doesn't fully match mockups"). Two independent regressions in the numbered-step circle, both
 * invisible to reading the rule and caught only by measuring what a real browser actually resolves
 * -- see the rule's own header comments in `_page-contents.scss` for the mechanism of each. The
 * source-level checks below pin the exact declarations the fix depends on; the real-browser check
 * pins the thing neither a source read nor jsdom/happy-dom can confirm, the actual computed pixel
 * size of a `::before` pseudo-element.
 */
describe('_page-contents.scss cobalt numbered list (OpenProject #2883)', () => {
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
      const [{ css: contentCss }, appCss] = await Promise.all([
        compileStringAsync(readFileSync(join(dir, '_page-contents.scss'), 'utf-8'), {
          loadPaths: [dir]
        }),
        buildAppCss()
      ])
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

/**
 * OpenProject #2965 ("Cobalt numbered-step numeral sized in em will drift once the article base
 * font-size fix lands"). Sibling to #2883 above, which fixed the plate's own BOX geometry; this
 * pins the numeral's own `font-size`, previously `0.6875em` (resolving against the `li`'s inherited,
 * `.page-contents`-derived font-size, so it would silently shrink any time that base changes), now a
 * fixed `11px` per the design handoff's literal `600 11px/24px`. The real-browser check proves the
 * decoupling directly: the numeral stays 11px even when the surrounding article's own font-size
 * differs from `.page-contents`'s default.
 */
describe('_page-contents.scss cobalt numbered-step numeral is a fixed size (OpenProject #2965)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.scss'), 'utf-8')

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
      const [{ css: contentCss }, appCss] = await Promise.all([
        compileStringAsync(readFileSync(join(dir, '_page-contents.scss'), 'utf-8'), {
          loadPaths: [dir]
        }),
        buildAppCss()
      ])
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
 * OpenProject #2917 ("Tables: Ledger styling, light + dark"). The frame, mono eyebrow head, rules
 * and hover accent are `#2916`'s own token wiring (`--content-table-*`, already covered by that
 * WP's tests) — this suite covers what #2917 itself added on top: the body's own surface colour,
 * the thinned/coloured scrollbar, and Ledger's two-corner blueprint marks. OpenProject #2935 later
 * split the single `.table-wrap` box into `.table-wrap` (the outer, non-scrolling frame) and
 * `.table-scroll` (the inner scroller), specifically so the marks could move from flush with the
 * frame to the spec's own 4px overhang — the scrollbar assertions below moved to `.table-scroll`
 * with them, and the "flush" variance this suite used to also assert is deleted from
 * `docs/variances.md` along with the deviation itself. OpenProject #2958 split the boxes a second
 * time — `.table-clip` now sits between the two, owning `overflow: hidden` plus the radius on its
 * own, because `.table-scroll`'s own `overflow-x: auto` produces a native scrollbar that is not
 * reliably clipped by `border-radius` on that SAME element (a classic, space-reserving scrollbar
 * squares off the very corner it sits against) — see `_page-contents.scss`'s own `// TABLES` header
 * comment for the full mechanism.
 */
describe('_page-contents.scss table frame (OpenProject #2917)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.scss'), 'utf-8')
  // -> The shared `.table-wrap`/`.table-clip`/`.table-scroll` mechanics this describe covers live in
  //    the `// TABLES` section (see that section's own header comment). Since OpenProject #3007,
  //    the per-aesthetic sections earlier in the file set only the `--content-table-scrollbar-*`
  //    tokens the `// TABLES` section's own `.table-scroll` rule consumes -- they no longer declare
  //    a `.table-scroll` selector of their own, so a plain search finding one of those instead is no
  //    longer a risk, but the explicit `tablesSectionStart` anchor stays regardless.
  const tablesSectionStart = source.indexOf('\n  // TABLES\n')

  /** The declarations of one selector's block, given the selector's own opening line. */
  function blockFor(selector) {
    const start = source.indexOf(selector, tablesSectionStart)
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

  it('draws the body on the stated content surface rather than whatever sits behind the wrapper', () => {
    const block = blockFor('.table-wrap {')
    expect(block).toMatch(/background-color:\s*var\(--content-surface\)/)
  })

  it('thins the wide-table scrollbar via the standards properties, wrapped for the Chromium engine gotcha (OpenProject #3007)', () => {
    const block = blockFor('.table-scroll {')
    expect(block).toMatch(/overflow-x:\s*auto/)
    // -> The standards pair must NOT sit in this same unwrapped block (the engine gotcha every
    //    other scrollbar rule in this codebase already respects) -- they live in their own
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
    // -> Same source-scan shape as `_base.scss`'s own equivalent test, applied to the one place in
    //    this file that sets the standards properties.
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
    // -> Ledger light: subtler than the global scrollbar at rest, stepping up to the global rule's
    //    own resting tone on hover, and its exact drag colour when dragging.
    expect(source).toMatch(/--content-table-scrollbar-thumb:\s*var\(--color-rule\);/)
    expect(source).toMatch(/--content-table-scrollbar-track:\s*var\(--color-tint-alt\);/)
    expect(source).toMatch(/--content-table-scrollbar-thumb-hover:\s*var\(--color-slate-faint\);/)
    expect(source).toMatch(
      /--content-table-scrollbar-thumb-active:\s*var\(--color-negative-fill\);/
    )
    // -> Ledger dark, same relationship
    expect(source).toMatch(/--content-table-scrollbar-thumb:\s*var\(--color-hairline-dark\);/)
    expect(source).toMatch(/--content-table-scrollbar-track:\s*var\(--color-ink-dark\);/)
    expect(source).toMatch(/--content-table-scrollbar-thumb-hover:\s*var\(--color-border-dark\);/)
    expect(source).toMatch(/--content-table-scrollbar-thumb-active:\s*var\(--color-accent-dark\);/)
    // -> Cobalt light: blends into the page ground rather than the global rule's transparent track,
    //    but drags to the exact same accent colour the global rule drags to
    expect(source).toMatch(
      /--content-table-scrollbar-thumb:\s*var\(--color-sidebar-actions-text\);/
    )
    expect(source).toMatch(/--content-table-scrollbar-track:\s*var\(--color-paper\);/)
    expect(source).toMatch(/--content-table-scrollbar-thumb-hover:\s*var\(--color-slate-light\);/)
    expect(source).toMatch(
      /--content-table-scrollbar-thumb-active:\s*var\(--color-accent-strong\);/
    )
    // -> Cobalt dark, same relationship -- drags to `--color-heading-h2`, NOT `--color-accent-
    //    strong` (a different, unrelated blue on this ground)
    expect(source).toMatch(/--content-table-scrollbar-thumb:\s*rgba\(255,\s*255,\s*255,\s*0\.14\);/)
    expect(source).toMatch(/--content-table-scrollbar-track:\s*var\(--color-dark-3-5\);/)
    expect(source).toMatch(
      /--content-table-scrollbar-thumb-hover:\s*rgba\(255,\s*255,\s*255,\s*0\.3\);/
    )
    expect(source).toMatch(/--content-table-scrollbar-thumb-active:\s*var\(--color-heading-h2\);/)
    // -> No aesthetic keeps its own literal-valued `.table-scroll` override any more -- every
    //    colour flows through the shared token pair the `// TABLES` section's rule consumes
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
    // -> `inset: -5px` against the frame's own 1px border -- the same convention
    //    `.page-header-icon__marks` and the blockquote's `&::after` use
    expect(block).toMatch(/inset:\s*-5px;/)
    expect(block).toMatch(/pointer-events:\s*none/)
  })

  describe('real browser', { skip: !hasChromium(), timeout: 60000 }, () => {
    let browser

    // -> `div[role="table"]`/`[role="row"]`/`[role="columnheader"]`/`[role="cell"]`, matching
    //    `renderers/markdown.js`'s renderer output (OpenProject #2997/#3014) -- there is no `<table>`,
    //    `<thead>` or `<tbody>` any more; `thead_open`/`thead_close`/`tbody_open`/`tbody_close`
    //    render as nothing, so a header row is just a row whose cells carry `role="columnheader"`.
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
    //    table off mid-content on the trailing edge rather than at the table's own natural edge --
    //    the case that actually exercises the rounded-corner clip (OpenProject #2958). A table that
    //    fits within its container needs no scrolling at all, so its corners sit at the table's own
    //    natural edge regardless of which box owns the radius. 12 columns, matching the 16-column
    //    cap `[role="table"]` reserves (OpenProject #3015) with headroom to spare.
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
      const [{ css: contentCss }, appCss] = await Promise.all([
        compileStringAsync(readFileSync(join(dir, '_page-contents.scss'), 'utf-8'), {
          loadPaths: [dir]
        }),
        buildAppCss()
      ])
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
            // -> What real Chromium actually paints (OpenProject #3007): once `.table-scroll` also
            //    carries `::-webkit-scrollbar*` rules, Chromium 121+'s own engine gotcha means the
            //    standards `scrollbarColor`/`scrollbarWidth` above stop being what it renders with --
            //    the webkit pseudo-elements are the ones a real browser resolves colour from now.
            scrollbarThumbColor: scrollThumbStyle.backgroundColor,
            scrollbarTrackColor: scrollTrackStyle.backgroundColor,
            marksDisplay: afterStyle.display,
            marksImage: afterStyle.backgroundImage,
            clipOverflow: clipStyle.overflow,
            clipRadius: clipStyle.borderRadius,
            // -> Measured on the inner scroller (OpenProject #2935) -- that's the box with
            //    `overflow-x: auto` now, not the outer frame, which no longer scrolls at all.
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
      OpenProject #2958's actual regression check: a table too wide for its column, UNSCROLLED, so
      `.table-scroll` cuts it off mid-content on the trailing edge -- the geometry that actually
      exercises the rounded-corner clip (a table that fits needs no clip at all; a table scrolled all
      the way to either end sits at the table's own natural edge, which coincides with the frame's
      edge regardless of which box owns the radius). `elementFromPoint`, a pixel inside the rounded
      corner's own arc, is what proves the clip: a correctly-clipped corner resolves to `.table-wrap`
      itself (its own background showing through, nothing painted over it there) or a page-content
      ancestor, never a `td`/`th`/`thead` -- if a cell's own background reached that pixel, its
      square corner would be visibly poking past the frame's rounded one, exactly OpenProject #2958's
      report.
    */
    async function measureCornerContainment({
      dark: darkMode = false,
      cobalt = false,
      scrollToEnd = false
    } = {}) {
      const [{ css: contentCss }, appCss] = await Promise.all([
        compileStringAsync(readFileSync(join(dir, '_page-contents.scss'), 'utf-8'), {
          loadPaths: [dir]
        }),
        buildAppCss()
      ])
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
          // -> OpenProject #3016: re-verifying the #2958 regression didn't isolate whether the
          //    corner-bleed was scroll-position dependent -- scrolled all the way to the trailing
          //    edge, the table's own content stops being cut off mid-cell (it sits at its own
          //    natural edge again), which is exactly the OTHER geometry `measure()`'s own comment
          //    already calls out as "needs no clip at all" for a table that fits. If containment
          //    only held at the unscrolled position, this is where it would break.
          if (scrollAllTheWay) {
            scroll.scrollLeft = scroll.scrollWidth
          }
          const r = wrap.getBoundingClientRect()
          // -> Every element in the fixture is a `<div>` now (OpenProject #2997/#3014), so the
          //    corner-containment question is no longer "which tag is here" but "does this pixel
          //    belong to a table role at all" -- a cell/columnheader/row/table `role` attribute
          //    poking past the frame is exactly OpenProject #2958's regression, restated for the
          //    new markup.
          function roleAt(x, y) {
            return document.elementFromPoint(x, y)?.getAttribute('role') ?? null
          }
          return {
            // -> Confirms the fixture actually needs a scrollbar -- otherwise this test would pass
            //    vacuously by never exercising the mid-content cut at all
            needsScroll: scroll.scrollWidth > scroll.clientWidth,
            // -> Confirms a `scrollToEnd` request actually moved the scroller, so a passing test
            //    below isn't vacuously true from never having scrolled at all
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
      // -> `--color-dark-3` (`#1b1f2a`), the WP's own "body surface" value
      expect(dark.background).toBe('rgb(27, 31, 42)')
    })

    it('colours the scrollbar thumb/track off the stated tokens in both themes, via the webkit pseudo-elements real Chromium actually paints (OpenProject #3007)', async () => {
      // -> `wide: true`: the narrow SAMPLE table never overflows, so it never actually grows a
      //    scrollbar for the webkit pseudo-elements to paint -- same reason
      //    `measureCornerContainment` reaches for `WIDE_SAMPLE` instead of `measure()`'s default.
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
      // -> `@supports not selector(::-webkit-scrollbar)` is false in real Chromium, so nothing sets
      //    these two any more once `.table-scroll` also carries webkit rules -- they revert to the
      //    browser default. This is the flip side of the previous test: the standards path is
      //    genuinely elided, not merely superseded in the cascade.
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
        // -> `roleAt` returns `null` for a pixel with no element/role there at all, which a
        //    `.toMatch()` regex can't take directly -- membership is the same check either way.
        expect(['columnheader', 'cell', 'row', 'table']).not.toContain(result.topRight)
        expect(['columnheader', 'cell', 'row', 'table']).not.toContain(result.bottomRight)
      }
    })

    /*
      OpenProject #3016: "whether the original corner-bleed was scroll-related was never isolated
      before this redesign was chosen." The test above only exercises the unscrolled, mid-content-cut
      position -- this is the other end of the same table, scrolled all the way to its trailing edge,
      which is the position the pre-#2958 regression report itself never distinguished from the
      unscrolled one. Containment has to hold at both ends, not just the one already covered.
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
      OpenProject #3016: a plain functional check that `.table-scroll` genuinely scrolls under the
      new `display: grid` + `grid-template-columns: subgrid` layout, not merely that
      `scrollWidth > clientWidth` (already asserted elsewhere in this describe) -- subgrid is a
      newer, less battle-tested layout mode than the plain block/table layout it replaced, so this
      proves the trailing column is actually draggable into view rather than stuck off-screen.
    */
    it('actually scrolls a wide table horizontally: the last column is off-screen before scrolling and comes fully into view after', async () => {
      const [{ css: contentCss }, appCss] = await Promise.all([
        compileStringAsync(readFileSync(join(dir, '_page-contents.scss'), 'utf-8'), {
          loadPaths: [dir]
        }),
        buildAppCss()
      ])
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
            // -> Before scrolling, the last column's cell extends past the scroller's own right
            //    edge -- cut off, exactly the geometry that exercises the corner clip above
            cutOffBefore: before.right > scrollBox.right,
            // -> After scrolling all the way, that same cell's right edge sits at or inside the
            //    scroller's own right edge -- fully visible now, not merely "moved some"
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
  })
})

/**
 * OpenProject #2919 ("Tables: update regression tests and contrast pins"). Before OpenProject #2916
 * a table's head was a dark title bar -- `--content-table-head` painted a `linear-gradient` down to
 * `--content-table-head-grade` and white-ish ink, with `--content-table-shadow` a real two-layer
 * `box-shadow` under the whole wrapper -- and the body's two row tones (`--content-table-row`/
 * `-row-alt`) were both a tinted wash over that dark surface. None of that shape had a regression
 * test guarding it (`--content-table-head-grade` and a real `--content-table-shadow` value never
 * appeared in this file), so there is nothing stale to rewrite here -- but there was also no POSITIVE
 * test yet for what replaced it: a plain tinted STRIP head (no gradient, no dark-title-bar ink), no
 * wrapper shadow at all, and a body whose plain row is the bare surface with only the alternating row
 * tinted. This pins that shape down the same way `NavSidebar.test.js` pins the depth-cue-dot fix --
 * asserting the new rule AND the absence of the pattern it replaced, from source.
 */
describe('_page-contents.scss table head/body (OpenProject #2916/#2919)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.scss'), 'utf-8')
  const tablesSectionStart = source.indexOf('\n  // TABLES\n')

  /** The declarations of one selector's block, given the selector's own opening line. */
  function blockFor(selector) {
    const start = source.indexOf(selector, tablesSectionStart)
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

  it('gives the wrapper no drop shadow at all -- `--content-table-shadow` is a single `none`, not a per-theme box-shadow', () => {
    const wrapBlock = blockFor('.table-wrap {')
    expect(wrapBlock).toMatch(/box-shadow:\s*var\(--content-table-shadow\)/)
    // -> Declared exactly once in the whole file, at `none` -- no aesthetic or dark override
    //    reintroduces a real shadow value.
    const shadowDeclarations = source.match(/--content-table-shadow:\s*[^;]+;/g) ?? []
    expect(shadowDeclarations).toHaveLength(1)
    expect(shadowDeclarations[0]).toMatch(/--content-table-shadow:\s*none;/)
  })

  it('paints the head as a plain tinted strip -- a flat `background-color`, never a `background-image`/gradient', () => {
    // -> OpenProject #2997/#3014/#3015: there is no `thead` element any more (the renderer's
    //    `thead_open`/`thead_close` render as nothing), so the strip is painted directly on each
    //    `[role="columnheader"]` cell rather than on a `thead` ancestor -- grid cells sit flush
    //    with no gap, so per-cell painting still reads as one continuous strip.
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

    // -> Ledger's own plain-row token is `transparent`, not a wash -- the removal the WP names.
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
    //    `[role='row']:not(:has(>[role='columnheader']))` (specificity 2) -- nth-child contributes
    //    1+2=3 -- + `[role='cell']` (1) = 5. A single `:not(:has(...))` clause on the hover selector
    //    only reaches 4 and loses to the band regardless of source order or a real `:hover` match.
    //    Duplicating the `:not()` clause (redundant, but valid) is what brings hover to 5 too, and
    //    with the tie, the hover rule -- declared after the zebra rule -- wins via cascade order.
    const hoverSelectorOccurrences = source.match(
      /\[role='row'\]:not\(:has\(> \[role='columnheader'\]\)\):not\(:has\(> \[role='columnheader'\]\)\):hover\s*\n?\s*> \[role='cell'\] \{/g
    )
    expect(hoverSelectorOccurrences).toHaveLength(1)
  })

  it('would fail if the head went back to a dark title-bar gradient or the wrapper regained a real shadow', () => {
    // -> Guards the guard: if either removed pattern reappeared verbatim, the assertions above
    //    would still pass a loose "no gradient anywhere in the file" check bypassed by scoping to
    //    one block, so this asserts directly against the two literal patterns that used to exist.
    expect(source).not.toMatch(/--content-table-head-grade/)
    expect(source).not.toMatch(/--content-table-shadow:\s*0[^;]*rgba/)
  })
})

/**
 * OpenProject #2997/#3014/#3015 ("Redesign rendered markdown tables as CSS Grid"). The two describes
 * above pin the token wiring and the head/band/hover rules from source -- what they CANNOT catch is
 * whether the CSS Subgrid technique those rules depend on actually does its one job: making a
 * column's width agree across every row even though no selector anywhere knows the real column
 * count (see `_page-contents.scss`'s own "Column sizing, CSS Grid style" comment for the full
 * mechanism). A source regex can't tell a working subgrid from a broken one that happens to declare
 * the right properties -- only real layout can, which is what this describe is for.
 */
describe('_page-contents.scss table CSS Grid column alignment (OpenProject #3015)', () => {
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
      const [{ css: contentCss }, appCss] = await Promise.all([
        compileStringAsync(readFileSync(join(dir, '_page-contents.scss'), 'utf-8'), {
          loadPaths: [dir]
        }),
        buildAppCss()
      ])
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
            // -> First and third body rows are the "plain" band, the second is the "alt" band --
            //    OpenProject #2919's two-tone banding, now counted with the header row excluded.
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
      // -> Subgrid is what this proves: if it had silently fallen back to independent per-row grids
      //    (or `display: contents` had let cells drift into the wrong grid row entirely), the data
      //    row with the long first-column value would push its OWN column 1 wider than the header's,
      //    and the edges below would disagree.
      expect(new Set(leftEdges).size).toBe(1)
    })

    it('lines every row up on the same second-column left edge too, sized off the longest content in that column across every row', async () => {
      const { secondColLeftEdges, leftEdges } = await measure()
      expect(new Set(secondColLeftEdges).size).toBe(1)
      // -> Column 2 starts to the right of column 1 -- confirms the columns are real, distinct grid
      //    tracks, not every cell collapsing onto the same track.
      expect(secondColLeftEdges[0]).toBeGreaterThan(leftEdges[0])
    })

    it('bands the first body row as plain and the second as alt, not the header row (nth-child(of S) skips it correctly)', async () => {
      const { headerBackground, bodyRowBackgrounds } = await measure()
      // -> `--content-table-head` in Ledger light, `#f0f2f7` -- the header row's own cell paints
      //    this directly, never the plain/alt body band, confirming the `:not(:has(> ...))` filter
      //    correctly excludes it from the banding rules' count.
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
      // -> A source-level check can pin the selector text, but only a real browser can tell a
      //    genuinely-tied specificity from one that merely looks tied -- this is that check. The
      //    SECOND body row is the "alt" band (`--content-table-row-alt`, `#f7f8fb` in Ledger
      //    light); before the fix its zebra rule (specificity 5) beat the hover rule (specificity
      //    4) regardless of the real `:hover` match below, so the assertion would have failed on
      //    the pre-fix selector.
      const [{ css: contentCss }, appCss] = await Promise.all([
        compileStringAsync(readFileSync(join(dir, '_page-contents.scss'), 'utf-8'), {
          loadPaths: [dir]
        }),
        buildAppCss()
      ])
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
        // -> `--content-table-row-hover` in Ledger light, `#eef1f7` -- and explicitly not the alt
        //    band's `rgb(247, 248, 251)` the un-hovered row already asserts above.
        expect(hoveredBackground).toBe('rgb(238, 241, 247)')
      } finally {
        await page.close()
      }
    })
  })
})

/**
 * OpenProject #2963 ("Article type scale too large: 16px/24px base+h2 instead of spec'd 15.5px/26px").
 * `ui-iteration-cobalt-typography/cobalt-typography.md` §0.1 pins the article's whole type ramp in
 * absolute px, identical in Ledger and Cobalt -- deliberately not scoped to a `body.body--cobalt`
 * block. Source-level checks pin the declarations the fix depends on; the real-browser check pins
 * what a source read cannot -- the actual computed `font-size`/`line-height` once the em/rem chain
 * (`.page-contents`'s own base, then whatever each element is set relative to) has resolved, and
 * that it resolves to the same numbers whether or not Cobalt is active.
 */
describe('_page-contents.scss article type scale (OpenProject #2963)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.scss'), 'utf-8')

  it('sets the article base at 15.5px/1.72, not the old 16px/1.6', () => {
    expect(source).toMatch(/\.page-contents\s*\{[\s\S]*?font-size:\s*0\.96875rem;/)
    expect(source).toMatch(/\.page-contents\s*\{[\s\S]*?line-height:\s*1\.72;/)
  })

  it('pins h1/h3/h4 to their unchanged px sizes in `rem`, not the old `em` ratio against the base', () => {
    // -> `rem`, not `em`: had these stayed em-relative to the new 15.5px base they would have
    //    silently shrunk (32em -> 31px, 20em -> 19.375px, 17em -> 16.469px) despite being unchanged.
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
    // -> Already matched the target before this WP; asserted so a future edit can't regress it unseen.
    expect(source).toMatch(/pre\s*\{[\s\S]*?font-size:\s*0\.8125rem;[\s\S]*?line-height:\s*1\.75;/)
  })

  it('never re-scopes any of this to `body.body--cobalt` -- the design handoff draws one ramp for both aesthetics', () => {
    const cobaltStart = source.indexOf('@at-root body.body--cobalt &')
    expect(cobaltStart).toBeGreaterThan(-1)
    // -> None of the type-scale properties this WP owns appear inside a Cobalt-scoped block anywhere
    //    in the file; a real per-block parse would be needed to prove a NEGATIVE precisely, but every
    //    `body.body--cobalt` block in this file is a short, self-contained token/color override (see
    //    #2964's own `--content-h1`/`--content-h2` block), never a font-size declaration.
    const cobaltBlocks = [...source.matchAll(/@at-root body\.body--cobalt & \{/g)]
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
      const [{ css: contentCss }, appCss] = await Promise.all([
        compileStringAsync(readFileSync(join(dir, '_page-contents.scss'), 'utf-8'), {
          loadPaths: [dir]
        }),
        buildAppCss()
      ])
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
 * OpenProject #2964 ("Cobalt: in-content h1 shares --color-ink with h2, reading 'all blue' instead
 * of body ink"). The Ledger-default `--content-h1: var(--color-ink)` (L68 of this file) carried
 * through into Cobalt with no override, so in-content h1 rendered in Cobalt's saturated navy
 * `--color-ink` (`#10194a`) -- the same "blue" register h2 uses via its own accent-colored
 * `--content-h2` -- rather than the aesthetic's plain body ink. The fix scopes a `--content-h1`
 * override to the `body.body--cobalt &` block, pointing it at `--color-text-body` (`#1a2038` light /
 * `#e8ecff` dark) instead. `--content-h2` and its accent color are untouched -- that split (h2
 * alone carries the accent) is the locked design decision this fix must not disturb.
 */
describe('_page-contents.scss cobalt h1 ink (OpenProject #2964)', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_page-contents.scss'), 'utf-8')
  const cobaltBlockStart = source.indexOf('@at-root body.body--cobalt & {')
  const cobaltDarkBlockStart = source.indexOf('@at-root body.body--cobalt.body--dark & {')
  if (cobaltBlockStart === -1 || cobaltDarkBlockStart === -1) {
    throw new Error(
      'body.body--cobalt block(s) not found in _page-contents.scss -- have they moved?'
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
      const [{ css: contentCss }, appCss] = await Promise.all([
        compileStringAsync(readFileSync(join(dir, '_page-contents.scss'), 'utf-8'), {
          loadPaths: [dir]
        }),
        buildAppCss()
      ])
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
      // -> Never the aesthetic's saturated navy --color-ink (#10194a) that made h1 read "all blue"
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
