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
