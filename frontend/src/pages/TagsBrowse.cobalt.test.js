import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A scan of the SOURCE TEXT, not a mounted-and-computed style: there is no compiled stylesheet and
 * no layout engine in this test environment, so asserting against the source directly is the only
 * way to pin a hand-edited `<style>` block's shape.
 */

const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'TagsBrowse.vue')
const source = readFileSync(SOURCE_PATH, 'utf-8')

describe('TagsBrowse.vue Cobalt diff (OpenProject #2777)', () => {
  it('introduces no hardcoded Ledger SCSS color literal in its style block', () => {
    const styleBlock = source.match(/<style>([\s\S]*)<\/style>/)[1]
    // -> Strip comments first: a comment naming the literal it replaced would otherwise read as
    //    the regression itself.
    const withoutComments = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '')
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
    expect(source).toMatch(/\.tags-browse-subheader\s*\{[\s\S]*?color:\s*var\(--color-accent\);/)
    expect(source).toMatch(
      /\.body--dark \.tags-browse-subheader \{\s*color:\s*var\(--color-accent-dark\);/
    )
  })

  it("draws the results plate as Cobalt's shadowed sheet", () => {
    expect(source).toMatch(
      /body\.body--cobalt \.tags-browse-plate \{\s*border:\s*0;\s*border-radius:\s*var\(--radius-card\);\s*box-shadow:\s*var\(--shadow-card\);\s*\}/
    )
  })
})
