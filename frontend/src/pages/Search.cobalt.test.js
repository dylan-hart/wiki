import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A source-text scan rather than a mounted-and-computed style: pinning the shape of a hand-edited
 * `<style>` block is what these Cobalt-diff suites do, here and in `TagsBrowse.cobalt.test.js`.
 */

const SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'Search.vue')
const source = readFileSync(SOURCE_PATH, 'utf-8')

describe('Search.vue Cobalt diff (OpenProject #2777)', () => {
  it('introduces no hardcoded Ledger SCSS color literal in its style block', () => {
    const styleBlock = source.match(/<style>([\s\S]*)<\/style>/)[1]
    // -> Strip comments first: one naming the literal it replaced (`$primary`, `$accent-dark`, ...)
    //    would otherwise read as the regression itself.
    const withoutComments = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '')
    // -> Only a Ledger theme literal is the regression; the page's own layout constants are plain
    //    px values, not Sass variables.
    expect(withoutComments).not.toMatch(
      /\$(hairline|surface|primary|slate|ink|tint(-alt)?|dark-\d|text-(body|secondary|caption|dark)(-dark)?|accent-(fill|strong|dark|text)|paper)\b/
    )
  })

  it('draws the card, plate and truncation-adjacent surfaces as Cobalt shadowed sheets', () => {
    const cobaltOverrides = source.match(
      /body\.body--cobalt \.layout-search-(?:card|plate) \{\s*border: 0;\s*border-radius: var\(--radius-card\);\s*box-shadow: var\(--shadow-card\);\s*\}/g
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

describe('Search.vue empty-query prompt type role (OpenProject #2984)', () => {
  const styleBlock = source.match(/<style>([\s\S]*)<\/style>/)[1]

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
    const rule = extractRule('.layout-search-empty-prompt {')
    expect(rule).toMatch(/font-size:\s*14\.5px;/)
    expect(rule).toMatch(/line-height:\s*1\.6;/)
  })

  it('colors the empty-query prompt with the secondary-text token pair, not a literal', () => {
    const lightRule = extractRule('.body--light .layout-search-empty-prompt {')
    const darkRule = extractRule('.body--dark .layout-search-empty-prompt {')
    expect(lightRule).toMatch(/color:\s*var\(--color-text-secondary\);/)
    expect(darkRule).toMatch(/color:\s*var\(--color-text-secondary-dark\);/)
  })

  it('is not scoped under body.body--cobalt -- the metric is identical in both aesthetics', () => {
    const rule = extractRule('.layout-search-empty-prompt {')
    expect(rule).not.toMatch(/body\.body--cobalt/)
  })
})
