import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Read out of the SFC's own CSS rather than off a rendered element: no media query or theme override
 * touches `.auth-logo img`, so a real layout engine would only report back the declared value. The
 * image sets no width, and scales by its own aspect ratio from this height.
 */

const frontendRoot = join(import.meta.dirname, '..', '..')

function sfcStyles(relativePath) {
  const source = readFileSync(join(frontendRoot, relativePath), 'utf8')
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
}

function compileSfcStyles(relativePath) {
  // -> No compile step: with Sass gone, every SFC `<style>` block is already plain, valid CSS.
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
