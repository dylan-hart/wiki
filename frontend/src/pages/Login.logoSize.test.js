import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #3107: the login page logo (`.auth-logo img`, the `&-logo` nesting under the `.auth`
 * root selector) was 72px tall, too small next to the rest of the panel. `Login.vue:135` is the only
 * place this size is declared — no width is set, so the image scales by its own aspect ratio, and no
 * Cobalt/dark-mode override exists for it.
 *
 * This reads the rule back out of the SFC's own plain CSS rather than asserting on a rendered
 * element: `Login.vue`'s `<style>` block has no layout-dependent behavior for this rule (no media
 * query touches it — only the panel's own padding/max-width changes at `599.98px`), so there is
 * nothing here a real layout engine would tell us that the declared value itself doesn't already
 * answer. `Index.pageHeaderHeight.test.js` documents the SFC-style-extraction mechanism this reuses.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}

function compileSfcStyles(relativePath) {
  // -> Sass is no longer part of the build (OpenProject #3254): every SFC `<style>` block is now
  //    plain, already-valid CSS (native nesting included, which real Chromium below parses natively),
  //    so this just returns the extracted text -- no compile step, no `_theme`/`_palette` prelude.
  return sfcStyles(relativePath)
}

describe('login page logo size', () => {
  it('is 192px tall, not the old 72px', () => {
    const css = compileSfcStyles(join('src', 'pages', 'Login.vue'))
    const rule = css.match(/\.auth-logo\s+img\s*\{([^}]*)\}/)

    expect(rule).not.toBeNull()
    expect(rule[1]).toMatch(/height:\s*192px/)
    expect(rule[1]).not.toMatch(/height:\s*72px/)
  })
})
