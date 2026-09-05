import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

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
