import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2859 ("Cobalt button-group gaps + square editor toolbar band"). Same source-text
 * approach as `cobaltTokens.test.js`: `tailwind.css` is plain CSS with no compiled stylesheet or
 * layout engine in this test environment, so the rule shape is pinned by reading the file directly
 * rather than asserting against a resolved cascade.
 *
 * Two shape corrections from `ui-iteration/README.md` Part 1.1, both scoped to `body.body--cobalt`
 * only (never Ledger, which keeps `WBtnGroup.vue`'s single hairline seam and a square, unrounded
 * button):
 *   1. `.w-btn-group` takes a gap instead of a seam, so adjacent buttons keep their own radius
 *      rather than one keeping a rounded corner butted against a square one.
 *   2. The editor's markup toolbar (`.editor-markdown-toolbar`) squares its buttons, so the band
 *      reads as one continuous strip rather than a row of individually rounded pills.
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
  it('squares the markup toolbar buttons under body.body--cobalt', () => {
    const rule = source.match(/body\.body--cobalt \.editor-markdown-toolbar \.w-btn\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule[1]).toMatch(/border-radius:\s*0\s*;/)
  })
})
