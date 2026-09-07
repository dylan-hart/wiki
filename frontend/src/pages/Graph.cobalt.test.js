import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2777 ("Tags + Search + Graph: diff against Cobalt mockups, fix gaps"). Same rationale
 * as `TagsBrowse.cobalt.test.js`/`Search.cobalt.test.js`: a source-text scan, not a mounted-and-
 * computed style, is the established pattern for pinning a hand-edited `<style>` block's shape here.
 *
 * `Graph.vue`'s floating panels, legend and tooltip all styled themselves with hardcoded Ledger
 * SCSS literals scoped only by bare .body--light/.body--dark -- never body.body--cobalt -- so the
 * screen picked up no Cobalt color, radius or shadow at all. This suite pins the fix.
 */

const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'Graph.vue')
const source = readFileSync(SOURCE_PATH, 'utf-8')

function styleBlock(src) {
  return src.match(/<style lang="scss" scoped>([\s\S]*)<\/style>/)[1]
}

describe('Graph.vue Cobalt diff (OpenProject #2777)', () => {
  it('introduces no hardcoded Ledger SCSS color literal in its style block', () => {
    // -> Strip comments first: several explain the fix by NAMING the literal they replaced
    //    (`$ink`, ...), which would otherwise read as the regression itself.
    const withoutComments = styleBlock(source).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).not.toMatch(
      /\$(hairline|surface|primary|slate|ink|tint|dark-\d|text-(body|secondary|caption|dark)(-dark)?|accent-(fill|strong|dark|text)|paper)\b/
    )
  })

  it("gives the right-rail and filters panels (the graph-panel mixin) Cobalt's shadowed-sheet treatment", () => {
    expect(styleBlock(source)).toMatch(
      /@at-root body\.body--cobalt & \{\s*border: 0;\s*border-radius: var\(--radius-card\);\s*box-shadow: var\(--shadow-card\);\s*\}/
    )
  })

  it("gives the truncation notice its own Cobalt override, matching the mockup's borderless pill", () => {
    const overrides = styleBlock(source).match(
      /@at-root body\.body--cobalt & \{\s*border: 0;\s*border-radius: var\(--radius-card\);\s*box-shadow: var\(--shadow-card\);\s*\}/g
    )
    // -> One for the graph-panel mixin (shared by both floating panels), one for the truncation notice.
    expect(overrides?.length).toBe(2)
  })

  it("draws the tooltip plate off --color-ink, which is Cobalt's own ink under body.body--cobalt", () => {
    expect(styleBlock(source)).toMatch(/background-color:\s*var\(--color-ink\);/)
  })
})
