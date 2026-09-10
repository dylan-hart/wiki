import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #3007 ("Reconcile existing per-surface scrollbar overrides with the new global
 * handoff-8 rules"). `.page-sidebar` (the page-view rail holding contents/tags/revision/watching)
 * used to carry its own hardcoded `scrollbar-width: thin; scrollbar-color: rgb(102 102 102 / 0.5)
 * transparent;`, unconditioned on either aesthetic -- a near-duplicate of the flat grey rule
 * `WScrollArea.vue` used to hardcode (see that component's own header comment and
 * `_base.test.js`'s "WScrollArea.vue carries no scrollbar rule of its own" describe, OpenProject
 * #3006). Since `scrollbar-color` is an inherited property and Chromium 121+ ignores every
 * `::-webkit-scrollbar*` rule on an element carrying a non-auto value of its own, that direct,
 * unwrapped declaration was actively defeating the global `.body--ledger`/`.body--cobalt`
 * scrollbar spec for this column in every engine -- not merely a specificity fight, so the fix is
 * deletion, not recolouring.
 *
 * Source-scan, not a mount/computed-style assertion, for the same reason `_base.test.js` and
 * `_page-contents.test.js` use one for their own scrollbar rules: nothing compiles Sass in this
 * test environment and jsdom has no `::-webkit-scrollbar` pseudo-element or `scrollbar-color`
 * computed style to read back at all.
 */
describe('Index.vue .page-sidebar carries no scrollbar rule of its own', () => {
  const source = readFileSync(join(import.meta.dirname, 'Index.vue'), 'utf8')

  it('has no scrollbar-width/scrollbar-color declaration left anywhere in the file', () => {
    expect(source).not.toMatch(/scrollbar-width/)
    expect(source).not.toMatch(/scrollbar-color/)
  })

  it('still scrolls its own overflow independently of the article column', () => {
    const start = source.indexOf('.page-sidebar {')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('\n}', start)
    const block = source.slice(start, end)
    expect(block).toMatch(/overflow-y:\s*auto/)
    expect(block).toMatch(/overscroll-behavior:\s*contain/)
  })
})
