import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Source-text assertions: `tailwind.css` is plain CSS with no compiled stylesheet or layout engine
 * in this environment, so the rule shape is pinned by reading the file rather than by resolving a
 * cascade. The gap rules are scoped to `body.body--cobalt`; Ledger keeps `WBtnGroup.vue`'s single
 * hairline seam and its square, unrounded buttons.
 */

const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'tailwind.css')
const source = readFileSync(CSS_PATH, 'utf-8')

describe('Cobalt button-group gap', () => {
  it('gives .w-btn-group a gap under body.body--cobalt', () => {
    const rule = source.match(/body\.body--cobalt \.w-btn-group\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule[1]).toMatch(/gap:\s*\d+px/)
  })

  it('removes the Ledger seam border between grouped buttons under body.body--cobalt', () => {
    const rule = source.match(
      /body\.body--cobalt \.w-btn-group > \.w-btn:not\(:last-child\)\s*\{([^}]*)\}/
    )
    expect(rule).not.toBeNull()
    expect(rule[1]).toMatch(/border-inline-end:\s*none\s*!important/)
  })

  it('does not touch .w-btn-group outside a body.body--cobalt selector', () => {
    // Every top-level (non-Cobalt-scoped) occurrence of the class lives in WBtnGroup.vue, not here.
    expect(source).not.toMatch(/(?<!body\.body--cobalt )\.w-btn-group\s*\{/)
  })
})

describe('Cobalt editor toolbar band', () => {
  // -> Squaring the markup toolbar's buttons belongs to the shared `flush-hover-btn` primitive;
  //    `EditorMarkdown.flushHover.test.js` covers it. Only the rule's absence is pinned here.
  it('no longer squares the markup toolbar buttons with a toolbar-specific rule', () => {
    expect(source).not.toMatch(/body\.body--cobalt \.editor-markdown-toolbar \.w-btn\s*\{/)
  })
})
