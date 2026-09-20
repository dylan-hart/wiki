import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A source-text scan rather than a mounted-and-computed style: what is pinned here is the shape of a
 * hand-edited `<style>` block, not what one selector resolves to.
 */

const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'Graph.vue')
const source = readFileSync(SOURCE_PATH, 'utf-8')

function styleBlock(src) {
  return src.match(/<style scoped>([\s\S]*)<\/style>/)[1]
}

describe('Graph.vue Cobalt diff (OpenProject #2777)', () => {
  it('introduces no hardcoded Ledger SCSS color literal in its style block', () => {
    // -> Strip comments first: a comment that names one of these literals would read as the
    //    regression itself.
    const withoutComments = styleBlock(source).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).not.toMatch(
      /\$(hairline|surface|primary|slate|ink|tint|dark-\d|text-(body|secondary|caption|dark)(-dark)?|accent-(fill|strong|dark|text)|paper)\b/
    )
  })

  it("gives the right-rail and filters panels (the shared .graph-panel class) Cobalt's shadowed-sheet treatment", () => {
    expect(styleBlock(source)).toMatch(
      /body\.body--cobalt & \{\s*border: 0;\s*border-radius: var\(--radius-card\);\s*box-shadow: var\(--shadow-card\);\s*\}/
    )
  })

  it("gives the truncation notice its own Cobalt override, matching the mockup's borderless pill", () => {
    const overrides = styleBlock(source).match(
      /body\.body--cobalt & \{\s*border: 0;\s*border-radius: var\(--radius-card\);\s*box-shadow: var\(--shadow-card\);\s*\}/g
    )
    // -> One for the shared .graph-panel class, one for the truncation notice.
    expect(overrides?.length).toBe(2)
  })

  it("draws the tooltip plate off --color-ink, which is Cobalt's own ink under body.body--cobalt", () => {
    expect(styleBlock(source)).toMatch(/background-color:\s*var\(--color-ink\);/)
  })
})
