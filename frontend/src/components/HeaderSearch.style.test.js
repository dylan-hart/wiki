import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Vitest runs no layout engine, so these assert against the raw `<style>` source text. The
 * aesthetic-scoped focused-field rules have to stay flat: nested inside a `.header-search` wrapper,
 * a `&-field` shorthand flattens the aesthetic class to a DESCENDANT of `.is-focused`, backwards
 * from the real DOM where `body.body--*` is always the top-level ancestor, so it can never match.
 */
/** Brace-balanced, so a rule's nested `&:hover` block does not truncate the extracted body. */
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

  it('carries no `body.body--cobalt .header-search {` wrapper for a future edit to re-nest inside', () => {
    expect(styleBlock).not.toContain('body.body--cobalt .header-search {')
  })

  it('carries no `.body--dark:not(.body--cobalt) .header-search {` wrapper for a future edit to re-nest inside', () => {
    expect(styleBlock).not.toContain('.body--dark:not(.body--cobalt) .header-search {')
  })
})

/**
 * The field and the tags button docked to it have to read as one lit ring when the row is focused,
 * so the button's focused border color must match the field's rather than staying transparent.
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
 * `.header-search-mode-btn` is a `<button>`, which gets no pointer cursor from the UA stylesheet --
 * unlike its `<router-link>` sibling `.header-search-tags-btn`, which does.
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
 * The buttons and the field they dock to make up one lit ring, so the buttons' focused border has
 * to ease in step with the field's rather than snapping.
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
