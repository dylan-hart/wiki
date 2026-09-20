import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * A bare `left-*`/`right-*` utility pins an element to a physical screen edge, where the logical
 * `start-*`/`end-*` form is almost always what was meant. What earns an `ALLOWLIST` entry: a
 * genuinely physical site pairs its `left-*`/`right-*` with another fixed screen position (a
 * sibling corner button, a symmetric centering transform, a colour-space coordinate) rather than
 * with "the content" or "the next element".
 */
describe('frontend/src carries no unjustified physical left-*/right-* positioning', () => {
  const srcDir = dirname(fileURLToPath(import.meta.url))

  /** Each reason is a summary; the full justification lives as a comment at the call site. */
  const ALLOWLIST = {
    'components/shared/WBadge.vue':
      'floating status dot straddling its host’s top-right corner (right-0 paired with a physical translate-x-1/2) — see OpenProject #1590',
    'components/shared/WNotifications.vue':
      'toast stack centered on the viewport (left-1/2 paired with a physical -translate-x-1/2) — see OpenProject #1590',
    'components/shared/WRange.vue':
      'handle label centered under its handle (left-1/2 paired with a physical -translate-x-1/2) — see OpenProject #1590',
    'layouts/AdminLayout.vue':
      'sidebar-opener corner button (MainLayout’s own moved inline into the header bar, OpenProject #2928) — see OpenProject #1590',
    'pages/Index.vue':
      'table-of-contents panel opener in a fixed screen corner (OpenProject #2894 retired the scroll-to-top disc and #2928 the sidebar opener it used to pair with) — see OpenProject #1590'
  }

  // -> The lookbehind also excludes the negative form, so a `-left-*`/`-right-*` offset goes
  //    unflagged.
  const UTILITY_PATTERN = /(?<![-\w])(left|right)-(\[[^\]]+\]|\d+(?:\/\d+)?|full|auto|px)\b/

  function stripComments(source) {
    return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  }

  function collectVueFiles(dir) {
    return readdirSync(dir, { recursive: true })
      .filter((entry) => entry.endsWith('.vue'))
      .filter((entry) => statSync(join(dir, entry)).isFile())
      .map((entry) => entry.split(sep).join('/'))
      .sort()
  }

  const files = collectVueFiles(srcDir)

  it.each(files)('%s', (file) => {
    const source = stripComments(readFileSync(join(srcDir, file), 'utf-8'))
    const isAllowlisted = file in ALLOWLIST

    if (isAllowlisted) {
      expect(
        source,
        `${file} is allowlisted for a physical left-*/right-* utility but no longer has one — remove it from ALLOWLIST`
      ).toMatch(UTILITY_PATTERN)
    } else {
      expect(
        source,
        `${file} uses a physical left-*/right-* position utility — use start-*/end-* instead, or add it to ALLOWLIST with a justification if it is genuinely screen-edge-anchored (see file header)`
      ).not.toMatch(UTILITY_PATTERN)
    }
  })

  it('keeps the allowlist free of files that no longer exist', () => {
    const relFiles = new Set(files)
    for (const file of Object.keys(ALLOWLIST)) {
      expect(relFiles, `allowlisted file ${file} no longer exists under frontend/src`).toContain(
        file
      )
    }
  })

  it('is running against every allowlisted file relative to src, not some other base', () => {
    // -> Guards the allowlist keys against this file moving: the round trip must stay a no-op.
    for (const file of Object.keys(ALLOWLIST)) {
      expect(relative(srcDir, join(srcDir, file)).split(sep).join('/')).toBe(file)
    }
  })
})
