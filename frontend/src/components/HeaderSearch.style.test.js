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
 * Vitest doesn't run a layout engine, so this asserts against the raw `<style>` source text itself:
 * the two flat, correctly
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
  const styleBlock = source.slice(source.indexOf('<style>'))

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

  // -> The bug: `.header-search-row-inline.is-focused &-field` nested INSIDE a
  //    `body.body--cobalt .header-search { ... }` / `.body--dark:not(.body--cobalt) .header-search
  //    { ... }` wrapper block compiled backwards -- `&` resolved to the enclosing selector, landing
  //    it AFTER `.is-focused` in the flattened selector instead of before it, so it could never match
  //    the real DOM (`body.body--*` is always the top-level ancestor). The fix (and OpenProject
  //    #3254's later flattening of this file's remaining nesting) both leave no such wrapper for a
  //    regression to re-nest inside any more -- these two flat selectors above ARE the guard now.
  it('carries no `body.body--cobalt .header-search {` wrapper for a future edit to re-nest inside', () => {
    expect(styleBlock).not.toContain('body.body--cobalt .header-search {')
  })

  it('carries no `.body--dark:not(.body--cobalt) .header-search {` wrapper for a future edit to re-nest inside', () => {
    expect(styleBlock).not.toContain('.body--dark:not(.body--cobalt) .header-search {')
  })
})

/**
 * Regression test for OpenProject #3037: in Cobalt, focusing the search bar lit up the field but
 * left the adjacent "browse by tags" button visually unchanged, because a second, cobalt-only rule
 * immediately reset the button's border back to `transparent` after the shared `.is-focused` class
 * would otherwise have colored it -- cancelling the grouped-ring effect Ledger's equivalent rule
 * already produces. The fix matches the tags button's focused border color to the field's own
 * (`rgb(255 255 255 / 0.4)`) so the two controls read as one lit ring when the row is focused.
 */
describe('HeaderSearch.vue Cobalt focused-tags-btn selector', () => {
  const componentDir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(componentDir, 'HeaderSearch.vue'), 'utf8')
  const styleBlock = source.slice(source.indexOf('<style>'))

  it('gives the tags button a real focused border color, matching the field, in Cobalt', () => {
    const body = ruleBody(
      styleBlock,
      'body.body--cobalt .header-search-row-inline.is-focused .header-search-tags-btn'
    )
    expect(body).not.toContain('border-color: transparent')
    expect(body).toContain('border-color: rgb(255 255 255 / 0.4)')
  })
})

/**
 * Regression test for OpenProject #3226: the semantic search mode toggle button
 * (`.header-search-mode-btn`, a `<button>`, OpenProject #3138) showed no `cursor: pointer` on
 * hover, unlike its sibling `.header-search-tags-btn` (a `<router-link>`, which gets a pointer
 * cursor from the browser's own anchor default even without one). Buttons don't reliably get a
 * pointer cursor from the UA stylesheet, which is why every other clickable control in this file
 * (`.header-search-clear`, `.header-search-kbd`) already sets it explicitly.
 */
describe('HeaderSearch.vue search mode button cursor', () => {
  const componentDir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(componentDir, 'HeaderSearch.vue'), 'utf8')
  const styleBlock = source.slice(source.indexOf('<style>'))

  it('gives the shared tags/mode button rule an explicit pointer cursor', () => {
    const body = ruleBody(styleBlock, '.header-search-tags-btn,\n.header-search-mode-btn')
    expect(body).toContain('cursor: pointer;')
  })
})

/**
 * Regression test for OpenProject #3291: the tags/semantic-toggle buttons' focused border-color
 * change (`.header-search-row-inline.is-focused .header-search-tags-btn`/`.header-search-mode-btn`,
 * light/dark/Cobalt variants) snapped instantly instead of easing, because the shared
 * `.header-search-tags-btn, .header-search-mode-btn` base rule's own `transition` list only named
 * `background-color` and `color` -- `border-color` was never added, unlike the adjacent search
 * field's own transition list, which already eases its `border-color` change on the same
 * `.is-focused` state. The two are meant to read as one continuous "lit ring" (see the comment
 * above the focused-border rules), so their border transitions need to match too.
 */
describe('HeaderSearch.vue tags/mode button border-color transition', () => {
  const componentDir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(componentDir, 'HeaderSearch.vue'), 'utf8')
  const styleBlock = source.slice(source.indexOf('<style>'))

  it('eases border-color on the shared tags/mode button rule, matching the search field', () => {
    const body = ruleBody(styleBlock, '.header-search-tags-btn,\n.header-search-mode-btn')
    expect(body).toContain('border-color 0.2s var(--ease-standard)')
  })
})
