import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Regression test for OpenProject #2994: the searchbar's focused-field highlight never applied in
 * Ledger dark mode (only the docked tags button did) or in Cobalt, because the aesthetic-scoped
 * `.header-search-row-inline.is-focused &-field` rules were nested one level too deep, inside the
 * `body.body--cobalt .header-search { ... }` / `.body--dark:not(.body--cobalt) .header-search { ... }`
 * blocks. SCSS's `&` substitution there flattens to
 * `.header-search-row-inline.is-focused <aesthetic-selector> .header-search-field` -- requiring the
 * aesthetic class to appear as a DESCENDANT of `.is-focused`, backwards from the real DOM where
 * `body.body--*` is always the top-level ancestor, so the rule could never match.
 *
 * Vitest doesn't run a real SCSS compiler or a layout engine (see CLAUDE.md's "Testing (frontend)"),
 * so this asserts against the raw `<style lang="scss">` source text itself: the two flat, correctly
 * scoped selectors must be present, and the backwards-nesting pattern that produced the bug must not
 * reappear.
 */
/**
 * Extracts the body of a top-level (brace-balanced) rule starting at `selector {`, so a nested
 * rule can be checked in isolation from the file's other, legitimately-flat use of the same
 * `.header-search-row-inline.is-focused &-field` shorthand (the un-scoped base rule, nested one
 * level inside a bare `.header-search { ... }` block, which flattens correctly and is not part of
 * this bug).
 */
function ruleBody(styleBlock, selector) {
  const start = styleBlock.indexOf(`${selector} {`)
  if (start === -1) {
    throw new Error(`selector not found: ${selector}`)
  }
  let depth = 0
  let i = styleBlock.indexOf('{', start)
  const bodyStart = i + 1
  do {
    if (styleBlock[i] === '{') depth++
    else if (styleBlock[i] === '}') depth--
    i++
  } while (depth > 0)
  return styleBlock.slice(bodyStart, i - 1)
}

describe('HeaderSearch.vue focused-field selectors', () => {
  const componentDir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(componentDir, 'HeaderSearch.vue'), 'utf8')
  const styleBlock = source.slice(source.indexOf('<style lang="scss">'))

  it('has a flat, top-level Cobalt focused-field selector', () => {
    expect(styleBlock).toContain(
      'body.body--cobalt .header-search-row-inline.is-focused .header-search-field {'
    )
  })

  it('has a flat, top-level Ledger dark-mode focused-field selector', () => {
    expect(styleBlock).toContain(
      '.body--dark:not(.body--cobalt) .header-search-row-inline.is-focused .header-search-field {'
    )
  })

  // -> The bug: `.header-search-row-inline.is-focused &-field` nested INSIDE these two
  //    aesthetic-scoped blocks compiles backwards -- `&` resolves to the enclosing
  //    `body.body--cobalt .header-search` / `.body--dark:not(.body--cobalt) .header-search`
  //    selector, landing it AFTER `.is-focused` in the flattened selector instead of before it, so
  //    it can never match the real DOM (`body.body--*` is always the top-level ancestor).
  it.each([
    ['Cobalt', 'body.body--cobalt .header-search'],
    ['Ledger dark mode', '.body--dark:not(.body--cobalt) .header-search']
  ])('never re-nests the focused-field rule inside the %s block', (_label, selector) => {
    expect(ruleBody(styleBlock, selector)).not.toContain(
      '.header-search-row-inline.is-focused &-field'
    )
  })
})
