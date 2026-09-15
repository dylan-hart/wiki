import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * OpenProject #3064 ("Bring File Manager tree visual styling to parity with the main navbar"):
 * pins the ONE named discrepancy the parent Feature's own scope called out by name -- "Indentation
 * style (dots vs. lines)" -- against `TreeNav.vue`'s own stylesheet source. A mounted-component
 * assertion can't verify this: the depth cue is a `background-image` tiled per lane and only lit on
 * `:hover`, and jsdom runs no layout engine to render either, the same reason `TreeNode.test.js`'s
 * own header comment gives for not asserting the rendered geometry there either. A source scan is
 * what the rest of this codebase reaches for in exactly this situation (see e.g.
 * `PageToc.typography.test.js`'s own `--page-toc-*` token-wiring describe).
 *
 * The tree used to carry an always-on `border-left` guide line on every `.treeview-node` (a LINE),
 * next to the main navbar's own hover-only radial-dot cue (`NavSidebar.vue`'s `.w-item::before`
 * rule, OpenProject #2906/#2932/#2951) -- this is regression coverage for the swap to that same
 * dot mechanism, not a fix still pending.
 */

const componentDir = dirname(fileURLToPath(import.meta.url))
const componentSource = readFileSync(join(componentDir, 'TreeNav.vue'), 'utf-8')

const styleMatch = componentSource.match(/<style>([\s\S]*?)<\/style>/)
if (!styleMatch) {
  throw new Error('TreeNav.vue should still carry a `<style>` block')
}
const styleSource = styleMatch[1]

/** Strips comments the same way `logicalSpacing.test.js` does, so a comment's own prose (which
 *  freely mentions the retired `border-left` line by name, in the past tense) can never be
 *  mistaken for a live declaration. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
}

const liveStyleSource = stripComments(styleSource)

describe('TreeNav.vue: indentation is a hover-only dot cue, not an always-on line (OpenProject #3064)', () => {
  it('no longer declares a `border-left` guide line anywhere in its stylesheet', () => {
    expect(liveStyleSource).not.toMatch(/border-left/)
  })

  it('drives its own per-row indentation off `--tree-depth`, the same custom property `TreeNode.vue#indentStyle` sets', () => {
    expect(liveStyleSource).toMatch(
      /padding-inline-start:\s*calc\(12px \+ var\(--tree-depth,\s*0\)\s*\*\s*10px\)/
    )
  })

  it("ports the main navbar's own hover-only radial-dot depth cue verbatim (6px inset, 10px lanes, `max()`-floored width, `@media (hover: hover)`-guarded)", () => {
    expect(liveStyleSource).toMatch(/::before/)
    expect(liveStyleSource).toMatch(/inset-inline-start:\s*6px/)
    expect(liveStyleSource).toMatch(
      /width:\s*max\(0px,\s*var\(--tree-depth,\s*0\)\s*\*\s*10px\s*-\s*4px\)/
    )
    expect(liveStyleSource).toMatch(/radial-gradient\(circle,\s*var\(--color-slate-faint\)/)
    expect(liveStyleSource).toMatch(/opacity:\s*0;/)
    expect(liveStyleSource).toMatch(/@media \(hover: hover\)/)
    expect(liveStyleSource).toMatch(/:hover::before\s*\{\s*opacity:\s*0\.5;/)
  })
})
