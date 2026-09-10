import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #3000: `.main-overlay > .w-dialog-panel`'s styling (base light/dark background, AND
 * the whole Cobalt treatment -- no ink title strip, `border-radius: var(--radius-dialog)`, a
 * transparent panel with `--float-bg` supplied by the header/body wrapper instead) used to live only
 * inside `layouts/MainLayout.vue`'s own `<style>` block, scoped by CSS class name rather than by any
 * Vue component boundary. `router/routes.js` lazy-loads `MainLayout.vue` and `AdminLayout.vue`
 * separately, so Vite code-splits each layout's `<style>` into its own async chunk -- a direct load
 * of an admin route never imports `MainLayout.vue`'s chunk, even though `AdminLayout.vue` mounts the
 * very same `MainOverlayDialog.vue` (Inbox, Profile, File Manager, History, ...) via its own hardcoded
 * `class="main-overlay"`.
 *
 * The fix moves the styling into `css/_overlay-dialog.scss`, `@use`d by `app.scss`, which `main.js`
 * imports unconditionally at boot -- not per-route -- so it is present regardless of which layout's
 * chunk happens to be loaded. This is a source-level regression test in the same style as
 * `_page-contents.test.js`: asserting the compiled-from source rather than mounting a component,
 * since the bug is about WHICH CSS CHUNK loads, not about any single layout's own rendering.
 */
describe('shared .main-overlay styling lives outside any one layout chunk', () => {
  const cssDir = dirname(fileURLToPath(import.meta.url))
  const partial = readFileSync(join(cssDir, '_overlay-dialog.scss'), 'utf-8')
  const appScss = readFileSync(join(cssDir, 'app.scss'), 'utf-8')
  const mainLayoutDir = join(cssDir, '..', 'layouts')
  const mainLayout = readFileSync(join(mainLayoutDir, 'MainLayout.vue'), 'utf-8')
  const adminLayout = readFileSync(join(mainLayoutDir, 'AdminLayout.vue'), 'utf-8')

  it('is loaded globally by app.scss, not by a per-layout <style> chunk', () => {
    expect(appScss).toMatch(/@use\s+'overlay-dialog';/)
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

  it('resolves its own $breakpoint-sm-max rather than relying on per-SFC injection', () => {
    expect(partial).toMatch(/@use\s+'palette'\s+as\s+\*;/)
    expect(partial).toMatch(/\$breakpoint-sm-max/)
  })

  it('is no longer duplicated inside MainLayout.vue, so it cannot drift from the shared copy', () => {
    expect(mainLayout).not.toMatch(/\.main-overlay\s*\{/)
  })

  it('AdminLayout.vue still mounts MainOverlayDialog with the shared class, and keeps its own distinct .admin-overlay untouched', () => {
    expect(adminLayout).toMatch(/class="admin-overlay"/)
    expect(adminLayout).toMatch(/<main-overlay-dialog\s*\/>/)
    // -> .admin-overlay is AdminLayout's own separate class for its own distinct overlays -- out of
    //    scope for #3000 -- so its styling must still live in AdminLayout.vue itself, unmoved.
    expect(adminLayout).toMatch(/\.admin-overlay\s*\{/)
  })
})
