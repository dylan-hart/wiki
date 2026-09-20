import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The Cobalt aesthetic is token-based rather than per-screen: an admin page that paints itself
 * through the token layer -- a Tailwind utility backed by a `--color-*`/`--radius-*`/`--shadow-*`
 * custom property, or a shared component that already does -- inherits a correct rendering with no
 * page-specific fix. These six are a spot check across distinct UI patterns (settings toggles, a
 * list with an edit overlay, a module-config page, a tabbed job history, a filtered log, a tree
 * editor), not an exhaustive sweep of `pages/Admin*.vue`.
 *
 * Source-level rather than runtime: a re-introduced literal color is a static property of the
 * markup, and with no compiled stylesheet here nothing would surface the regression -- the page
 * would just quietly stop inheriting.
 */
const SPOTCHECK_PAGES = [
  'AdminSecurity',
  'AdminGroups',
  'AdminAuth',
  'AdminScheduler',
  'AdminAuditLog',
  'AdminNavigation'
]

const pagesDir = dirname(fileURLToPath(import.meta.url))

function sourceOf(name) {
  return readFileSync(join(pagesDir, `${name}.vue`), 'utf-8')
}

describe('unmocked admin pages inherit Cobalt tokens with no page-specific fix (OpenProject #2781)', () => {
  it('names 6 pages spanning distinct UI patterns, which is the Task resolved scope', () => {
    expect(SPOTCHECK_PAGES).toHaveLength(6)
    // -> An existence check, so a rename cannot retire one of these guards silently.
    for (const name of SPOTCHECK_PAGES) {
      expect(() => sourceOf(name), name).not.toThrow()
    }
  })

  it('declares no non-empty <style> block on any of the six', () => {
    const offenders = SPOTCHECK_PAGES.filter((name) => {
      const match = sourceOf(name).match(/<style[^>]*>([\s\S]*?)<\/style>/)
      return match !== null && match[1].trim() !== ''
    })

    expect(offenders).toEqual([])
  })

  /**
   * The required a-f digit keeps a `#NNNN`-shaped token (an issue reference in a comment, a numeric
   * anchor) from reading as a color. An all-decimal hex color is rare enough to accept the blind
   * spot, and the inline-style and arbitrary-value checks below need no such carve-out.
   */
  it('writes no literal hex color (a-f digit required) anywhere in the six files', () => {
    const offenders = []
    for (const name of SPOTCHECK_PAGES) {
      const matches = sourceOf(name).match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
      const hexColors = matches.filter((m) => /[a-fA-F]/.test(m.slice(1)))
      if (hexColors.length > 0) offenders.push(`${name}: ${hexColors.join(', ')}`)
    }

    expect(offenders).toEqual([])
  })

  it('carries no color in an inline style/:style attribute (sizing only)', () => {
    const offenders = []
    for (const name of SPOTCHECK_PAGES) {
      for (const match of sourceOf(name).matchAll(/:?style="([^"]*)"/g)) {
        if (/#[0-9a-fA-F]{3,8}|rgb\(|rgba\(|hsl\(|hsla\(/.test(match[1])) {
          offenders.push(`${name}: ${match[1]}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('uses no Tailwind arbitrary-value color (bypassing the token layer via `bg-[...]` etc.)', () => {
    const offenders = []
    const arbitraryColor = /\b(?:bg|text|border|from|to|via|ring|shadow|fill|stroke)-\[(#|rgb|hsl)/
    for (const name of SPOTCHECK_PAGES) {
      if (arbitraryColor.test(sourceOf(name))) offenders.push(name)
    }

    expect(offenders).toEqual([])
  })
})
