import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * A source scan rather than a mounted assertion: the depth cue is a `background-image` tiled per
 * lane and lit only on `:hover`, and jsdom runs no layout engine to render or measure either.
 */

const componentDir = dirname(fileURLToPath(import.meta.url))
const componentSource = readFileSync(join(componentDir, 'TreeNav.vue'), 'utf-8')

const styleMatch = componentSource.match(/<style>([\s\S]*?)<\/style>/)
if (!styleMatch) {
  throw new Error('TreeNav.vue should still carry a `<style>` block')
}
const styleSource = styleMatch[1]

/** A comment in that stylesheet is free to name a declaration the rules no longer carry, so the
 *  assertions below must not see comment prose. */
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
