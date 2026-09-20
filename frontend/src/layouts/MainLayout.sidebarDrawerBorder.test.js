import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `WDrawer.vue`'s generic `border-hairline` utilities resolve through `--color-hairline`, a pale
 * tone meant for light paper, but the sidebar is dark-toned even in Cobalt light mode. The override
 * belongs in `MainLayout.vue` rather than `WDrawer.vue`, which other, genuinely light-paper drawers
 * still use unchanged.
 *
 * `MainLayout.vue`'s `<style>` block is unscoped and there is no compiled stylesheet in this
 * environment to assert live values against, hence a direct source-text assertion.
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
