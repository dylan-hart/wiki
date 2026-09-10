import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2777 ("Tags + Search + Graph: diff against Cobalt mockups, fix gaps"). Same rationale
 * as `TagsBrowse.cobalt.test.js`: a source-text scan, not a mounted-and-computed style, is the
 * established pattern for pinning a hand-edited `<style>` block's shape in this test environment.
 *
 * `Search.vue`'s card, sidebar, section headers and result rows all styled themselves with hardcoded
 * Ledger SCSS literals scoped only by bare .body--light/.body--dark -- never body.body--cobalt --
 * so the screen picked up no Cobalt color, radius or shadow at all. This suite pins the fix.
 */

const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'Search.vue')
const source = readFileSync(SOURCE_PATH, 'utf-8')

describe('Search.vue Cobalt diff (OpenProject #2777)', () => {
  it('introduces no hardcoded Ledger SCSS color literal in its style block', () => {
    const styleBlock = source.match(/<style lang="scss">([\s\S]*)<\/style>/)[1]
    // -> Strip comments first: several explain the fix by NAMING the literal they replaced
    //    (`$primary`, `$accent-dark`, ...), which would otherwise read as the regression itself.
    const withoutComments = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '')
    // -> The page's own local layout variables ($filters-collapse-max, $plate-size, ...) are fine;
    //    only the Ledger theme literals are the regression this guards against.
    expect(withoutComments).not.toMatch(
      /\$(hairline|surface|primary|slate|ink|tint(-alt)?|dark-\d|text-(body|secondary|caption|dark)(-dark)?|accent-(fill|strong|dark|text)|paper)\b/
    )
  })

  it('draws the card, plate and truncation-adjacent surfaces as Cobalt shadowed sheets', () => {
    const cobaltOverrides = source.match(
      /@at-root body\.body--cobalt & \{\s*border: 0;\s*border-radius: var\(--radius-card\);\s*box-shadow: var\(--shadow-card\);\s*\}/g
    )
    // -> `.layout-search-card` and `.layout-search-plate` each get their own override.
    expect(cobaltOverrides?.length).toBe(2)
  })

  it('colors the icon plate and the "Sort by" active row with the accent role, not primary', () => {
    expect(source).toMatch(/color:\s*var\(--color-accent\);/)
    expect(source).toMatch(/`accent` : ``/)
    expect(source).toMatch(/color="accent"/)
    expect(source).not.toMatch(/`primary` : ``/)
  })

  it("section headers read Cobalt's accent-strong link color, not a fixed Ledger literal", () => {
    expect(source).toMatch(/color:\s*var\(--color-accent-strong\);/)
    expect(source).toMatch(/color:\s*var\(--color-accent-dark\);/)
  })
})

/**
 * OpenProject #2984 ("Cobalt typography: search"). The empty-query prompt's own type role (italic
 * 400 14.5px/1.6 sans, per the role table's "Empty-query prompt" row) -- a size/line-height fix that
 * applies identically to both aesthetics, so it is a plain rule rather than one scoped under
 * `body.body--cobalt`, and its color still goes through the same `--color-text-secondary(-dark)`
 * pair every other secondary-tier row in this file already uses.
 */
describe('Search.vue empty-query prompt type role (OpenProject #2984)', () => {
  const styleBlock = source.match(/<style lang="scss">([\s\S]*)<\/style>/)[1]

  /**
   * `&-empty-prompt`'s own rule nests two `@at-root … &` blocks, so a non-greedy `[\s\S]*?\}` regex
   * stops at the FIRST closing brace (the light-mode block's), not the rule's own -- brace-counting
   * from the selector's own opening `{` is what actually finds the matching close.
   */
  function extractRule(selector) {
    const start = styleBlock.indexOf(selector)
    expect(start).toBeGreaterThan(-1)
    const openBrace = styleBlock.indexOf('{', start)
    let depth = 0
    for (let i = openBrace; i < styleBlock.length; i++) {
      if (styleBlock[i] === '{') depth++
      if (styleBlock[i] === '}') {
        depth--
        if (depth === 0) return styleBlock.slice(start, i + 1)
      }
    }
    throw new Error(`unbalanced braces reading rule for ${selector}`)
  }

  it('sets the empty-query prompt to its own absolute size and line-height', () => {
    const rule = extractRule('&-empty-prompt')
    expect(rule).toMatch(/font-size:\s*14\.5px;/)
    expect(rule).toMatch(/line-height:\s*1\.6;/)
  })

  it('colors the empty-query prompt with the secondary-text token pair, not a literal', () => {
    const rule = extractRule('&-empty-prompt')
    expect(rule).toMatch(/color:\s*var\(--color-text-secondary\);/)
    expect(rule).toMatch(/color:\s*var\(--color-text-secondary-dark\);/)
  })

  it('is not scoped under body.body--cobalt -- the metric is identical in both aesthetics', () => {
    const rule = extractRule('&-empty-prompt')
    expect(rule).not.toMatch(/body\.body--cobalt/)
  })
})
