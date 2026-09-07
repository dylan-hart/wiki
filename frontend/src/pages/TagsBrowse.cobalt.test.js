import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2777 ("Tags + Search + Graph: diff against Cobalt mockups, fix gaps"). Same rationale
 * as `css/cobaltTokens.test.js`: there is no compiled stylesheet or real layout engine in this test
 * environment, so the established pattern for pinning a hand-edited stylesheet's shape is asserting
 * against the SOURCE TEXT directly, not a mounted-and-computed style.
 *
 * `TagsBrowse.vue`'s own `<style lang="scss">` block styled every panel/text color with hardcoded
 * Ledger SCSS literals ($hairline, $surface, $primary, ...) scoped only by bare .body--light/
 * .body--dark -- never body.body--cobalt -- so the screen picked up no Cobalt color at all. This
 * suite pins the fix: the literals are gone, replaced by their var(--color-*) equivalents (which are
 * numerically identical under Ledger and carry real Cobalt values), and the card/chip surfaces that
 * should read as Cobalt's shadowed sheet now consume --radius-card/--shadow-card/--shadow-primary.
 */

const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'TagsBrowse.vue')
const source = readFileSync(SOURCE_PATH, 'utf-8')

describe('TagsBrowse.vue Cobalt diff (OpenProject #2777)', () => {
  it('introduces no hardcoded Ledger SCSS color literal in its style block', () => {
    const styleBlock = source.match(/<style lang="scss">([\s\S]*)<\/style>/)[1]
    // -> Strip comments first: several explain the fix by NAMING the literal they replaced
    //    (`$primary`, `$accent-dark`, ...), which would otherwise read as the regression itself.
    const withoutComments = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '')
    // -> `$plate-size`-style local SCSS variables the page declares for itself are fine; only the
    //    Ledger theme literals ($hairline, $surface, $primary, $slate, $ink, $tint, $dark-N, $text-*,
    //    $accent-*, $paper) are the regression this guards against.
    expect(withoutComments).not.toMatch(
      /\$(hairline|surface|primary|slate|ink|tint|dark-\d|text-(body|secondary|caption|dark)(-dark)?|accent-(fill|strong|dark|text)|paper)\b/
    )
  })

  it('colors "current selection" chips with the accent (white-text-fill) role, not primary', () => {
    const selectedChipBlock = source.match(/v-for="tag of state\.selectedTags"[\s\S]{0,200}/)[0]
    expect(selectedChipBlock).toMatch(/color="accent"/)
    expect(selectedChipBlock).toMatch(/text-color="white"/)
    expect(selectedChipBlock).not.toMatch(/color="primary"/)
  })

  it('gives the "current selection" chips Cobalt\'s accent glow', () => {
    expect(source).toMatch(
      /body\.body--cobalt \.tags-browse-chips--selected \.w-chip\s*\{\s*box-shadow:\s*var\(--shadow-primary\);/
    )
  })

  it('draws the "Current selection"/"Tags"/"Locale"/"Order by" subheaders in the accent role', () => {
    expect(source).toMatch(/&-subheader\s*\{[\s\S]*?color:\s*var\(--color-accent\);/)
    expect(source).toMatch(/@at-root \.body--dark & \{\s*color:\s*var\(--color-accent-dark\);/)
  })

  it("draws the results plate as Cobalt's shadowed sheet", () => {
    expect(source).toMatch(
      /@at-root body\.body--cobalt & \{\s*border:\s*0;\s*border-radius:\s*var\(--radius-card\);\s*box-shadow:\s*var\(--shadow-card\);\s*\}/
    )
  })
})
