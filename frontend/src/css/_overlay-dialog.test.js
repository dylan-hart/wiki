import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `router/routes.js` lazy-loads `MainLayout.vue` and `AdminLayout.vue` separately, so Vite
 * code-splits each layout's `<style>` into its own async chunk: `.main-overlay` styling kept inside
 * `MainLayout.vue` never reaches an admin route, which mounts the very same `MainOverlayDialog.vue`
 * via its own hardcoded `class="main-overlay"`. Living in `css/_overlay-dialog.css`, `@import`ed by
 * `app.css`, makes it present regardless of which layout's chunk loaded.
 *
 * Asserted against the source rather than a mounted component because the bug is about WHICH CSS
 * CHUNK loads, not about any single layout's own rendering.
 */
describe('shared .main-overlay styling lives outside any one layout chunk', () => {
  const cssDir = dirname(fileURLToPath(import.meta.url))
  const partial = readFileSync(join(cssDir, '_overlay-dialog.css'), 'utf-8')
  const appScss = readFileSync(join(cssDir, 'app.css'), 'utf-8')
  const mainLayoutDir = join(cssDir, '..', 'layouts')
  const mainLayout = readFileSync(join(mainLayoutDir, 'MainLayout.vue'), 'utf-8')
  const adminLayout = readFileSync(join(mainLayoutDir, 'AdminLayout.vue'), 'utf-8')

  it('is loaded globally by app.css, not by a per-layout <style> chunk', () => {
    expect(appScss).toMatch(/@import\s+'\.\/_overlay-dialog\.css';/)
  })

  it('carries the base light/dark panel background', () => {
    expect(partial).toMatch(/\.body--light\s*&\s*\{\s*background-color:\s*var\(--color-surface\);/)
    expect(partial).toMatch(/\.body--dark\s*&\s*\{\s*background-color:\s*var\(--color-dark-5\);/)
  })

  it('carries the full Cobalt treatment: no ink strip, dialog radius, transparent panel', () => {
    expect(partial).toMatch(/\.body--cobalt\s*&\s*\{[^}]*border-top:\s*0;/s)
    expect(partial).toMatch(/\.body--cobalt\s*&\s*\{[^}]*border-radius:\s*var\(--radius-dialog\);/s)
    expect(partial).toMatch(/\.body--cobalt\s*&\s*\{[^}]*background:\s*transparent;/s)
  })

  it('rounds the card-header and fills the body wrapper with --float-bg under Cobalt', () => {
    expect(partial).toMatch(/\.body--cobalt\s*&\s*\.card-header\s*\{/)
    expect(partial).toMatch(
      /\.body--cobalt\s*&\s*\.card-header \+ \*\s*\{[^}]*background:\s*var\(--float-bg\);/s
    )
    expect(partial).toMatch(
      /\.body--cobalt\s*&\s*\.card-header ~ \*:last-child\s*\{[^}]*background:\s*var\(--float-bg\);/s
    )
  })

  it('is native CSS with no Sass-specific syntax left (OpenProject #3249)', () => {
    // -> Comments are stripped first so prose naming the old Sass syntax cannot fail the check.
    const withoutComments = partial.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).not.toMatch(/@use\s+'palette'/)
    expect(withoutComments).not.toMatch(/\$breakpoint-sm-max/)
    // -> A literal, not a token: a media query cannot read a custom property.
    expect(withoutComments).toMatch(/@media \(max-width: 1023\.98px\)/)
  })

  it('is no longer duplicated inside MainLayout.vue, so it cannot drift from the shared copy', () => {
    expect(mainLayout).not.toMatch(/\.main-overlay\s*\{/)
  })

  it('AdminLayout.vue still mounts MainOverlayDialog with the shared class, and keeps its own distinct .admin-overlay untouched', () => {
    expect(adminLayout).toMatch(/class="admin-overlay"/)
    expect(adminLayout).toMatch(/<main-overlay-dialog\s*\/>/)
    // -> .admin-overlay is AdminLayout's own separate class for its own distinct overlays, so its
    //    styling belongs in AdminLayout.vue itself.
    expect(adminLayout).toMatch(/\.admin-overlay\s*\{/)
  })
})
