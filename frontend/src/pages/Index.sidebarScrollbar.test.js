import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A scrollbar declaration on this column would defeat the global `.body--ledger`/`.body--cobalt`
 * spec outright rather than merely outrank it: `scrollbar-color` is inherited, and Chromium 121+
 * ignores every `::-webkit-scrollbar*` rule on an element carrying a non-auto value of its own. The
 * fix for one appearing here is deletion, not recolouring.
 *
 * A source scan, because the DOM emulator has no `::-webkit-scrollbar` pseudo-element and no
 * `scrollbar-color` computed style to read back.
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
