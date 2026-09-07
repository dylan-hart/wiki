import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2781 ("Spot-check token inheritance across 5+ unmocked admin settings pages").
 *
 * The Cobalt aesthetic is token-based (`css/tailwind.css`'s `body.body--cobalt` /
 * `body.body--cobalt.body--dark` blocks, OpenProject #2767/#2771) rather than per-screen: once the
 * shared `WSettingsCard`/`WSettingsRow` components (Feature #2757) and the admin chrome
 * (`AdminLayout.vue`, Task #2780) are Cobalt-correct, every OTHER admin page should inherit correct
 * rendering with no page-specific mockup or fix, provided it paints itself through the token layer
 * (a Tailwind utility class backed by a `--color-*`/`--radius-*`/`--shadow-*` custom property, or a
 * shared component that already does) rather than a literal color of its own.
 *
 * This is a spot check across six admin pages picked for distinct UI patterns, not an exhaustive
 * sweep of `pages/Admin*.vue` (that repo-wide grep is Feature #2763's job, and OpenProject #2783 --
 * see `css/_base.test.js` and `css/_page-contents.test.js` -- already retired the specific literal
 * hex values that sweep had found in shared CSS by the time this Task ran):
 *
 *   - `AdminSecurity` -- a `WSettingsCard`-heavy settings-toggle page.
 *   - `AdminGroups`   -- a list page with an edit overlay.
 *   - `AdminAuth`     -- a module-config page (`ModuleConfigForm`) with a strategy rail.
 *   - `AdminScheduler`-- a tabbed (Upcoming/Active/Failed) job-history page.
 *   - `AdminAuditLog` -- a filtered table/log page.
 *   - `AdminNavigation` -- a tree-editing page.
 *
 * Each was read in full (template + script + style) against `css/tailwind.css`'s token blocks: every
 * color/radius-bearing class it writes (`bg-*`, `text-*`, `border-*`, `rounded-*`) is a Tailwind
 * utility resolving through a `--color-*`/`--radius-*` custom property, and every one of those either
 * has its own `body.body--cobalt`/`body.body--cobalt.body--dark` override, or is a value the handoff
 * deliberately leaves aesthetic-independent (the generic Material ramp -- `grey-*`, `teal`, `brown`,
 * `orange`/`deep-orange` -- used here only for neutral banners and job-category color-coding, never
 * chrome). None of the six declares a literal color of its own: no `<style>` block has any rule
 * (all six are prop-driven Tailwind markup with zero scoped CSS), no inline `style`/`:style` carries
 * a color (only `min-width`/`max-width`/`height` sizing), and no class uses Tailwind's `[...]`
 * arbitrary-value escape hatch to smuggle one in either. Inheritance holds; no page-specific fix was
 * needed.
 *
 * One page surfaces an ALREADY-KNOWN, already-flagged gap rather than a new one:
 * `AdminSecurity.vue`'s `bg-negative`/`bg-info` banners resolve through `--q-negative`/`--q-info`,
 * which (per the epic-tree coordination note on Epic #2752, restating #2772/#2773's own findings)
 * are un-seeded for Cobalt -- there is no `body.body--cobalt` override for either, so both keep
 * their Ledger literal (`#c14a52` / `#38465f`) under Cobalt. This is not fixed here: it is the same
 * frozen-primitives gap already deferred to Feature #2763, not a new one this page introduces, and
 * fixing it per-page here is exactly what the coordination note asks the 7 parallel tasks not to do.
 *
 * This is a source-level regression test, not a runtime one, for the same reason
 * `adminSettingsPattern.test.js` and `css/_base.test.js` give: a re-introduced literal color is a
 * static property of the markup, and there is no compiled stylesheet here that would surface a
 * regression as a visible failure on its own -- it would just quietly stop inheriting.
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
   * A literal hex color always contains at least one a-f letter somewhere in a real color (pure
   * decimal hex colors exist but are rare vs. how often a `#NNNN`-shaped OpenProject issue reference
   * appears in this codebase's comments) -- requiring one avoids false-flagging every `#2337`/`#2557`
   * issue reference these files cite in their own comments. Combined with the inline-style and
   * arbitrary-value checks below, which need no such carve-out, a real literal has nowhere left to
   * hide.
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
