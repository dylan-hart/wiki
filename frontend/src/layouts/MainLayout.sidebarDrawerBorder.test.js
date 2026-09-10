import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #3009 ("Cobalt light: navbar drawer border-right is the wrong (near-white,
 * light-paper) hairline"): `WDrawer.vue`'s `borderClass` computed draws `.bg-sidebar`'s own
 * inline-end edge with the generic `border-hairline`/`dark:border-hairline-dark` Tailwind
 * utilities, which resolve through `--color-hairline` -- a pale tone meant for a light-paper
 * background. The sidebar itself is dark-toned even in Cobalt light mode, so the fix is a
 * targeted override in `MainLayout.vue` (not `WDrawer.vue`, which other, genuinely light-paper
 * drawers still use unchanged), matching `--color-sidebar-hairline` -- the same token
 * `.sidebar-footerbtns`'s own `border-top` already uses.
 *
 * `MainLayout.vue`'s `<style lang="scss">` block is global (unscoped), so this is plain SCSS
 * source with no compiled stylesheet in this test environment to assert live values against --
 * the established pattern for that (`MainLayout.cobaltDialogCorners.test.js`, `cobaltTokens.test.js`)
 * is a direct source-text assertion.
 */

const source = readFileSync(join(import.meta.dirname, 'MainLayout.vue'), 'utf-8')

describe('Cobalt light: sidebar drawer border-inline-end', () => {
  it('overrides the drawer edge to the sidebar-scoped hairline token, !important, Cobalt-light only', () => {
    expect(source).toMatch(
      /body\.body--cobalt:not\(\.body--dark\) \.bg-sidebar \{\s*border-inline-end-color: var\(--color-sidebar-hairline\) !important;\s*\}/
    )
  })

  it('does not touch WDrawer.vue', () => {
    const wdrawerSource = readFileSync(
      join(import.meta.dirname, '..', 'components', 'shared', 'WDrawer.vue'),
      'utf-8'
    )
    expect(wdrawerSource).not.toContain('--color-sidebar-hairline')
  })

  it('is scoped away from Cobalt dark mode, which was not reported as wrong', () => {
    const ruleStart = source.indexOf('body.body--cobalt:not(.body--dark) .bg-sidebar {')
    expect(ruleStart).toBeGreaterThan(-1)
    const ruleEnd = source.indexOf('}', ruleStart)
    const rule = source.slice(ruleStart, ruleEnd + 1)
    expect(rule).toContain(':not(.body--dark)')
  })
})
