import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Repo-wide scan for bare `left-*`/`right-*` Tailwind position utilities, which pin an element to a
 * physical screen edge -- unlike leading/trailing spacing utilities (`ml-`/`mr-`/`pl-`/`pr-`,
 * covered separately by `logicalSpacing.test.js`), which answer "which side is this gutter on" and
 * are almost always convertible to the logical `start-*`/`end-*` form. A genuinely physical site
 * pairs its `left-*`/`right-*` with another fixed screen position (a sibling corner button, a
 * symmetric centering transform, a colour-space coordinate) rather than with "the content" or "the
 * next element".
 *
 * A site using dynamic pixel positioning via `:style` bindings instead of a Tailwind class
 * (`WMenu.vue`, `WTooltip.vue`, `WColorPicker.vue`, `WRange.vue`) never matches this scan's pattern
 * in the first place, so it carries its own one-line justification at the call site instead of an
 * allowlist entry here.
 */
describe('frontend/src carries no unjustified physical left-*/right-* positioning', () => {
  const srcDir = dirname(fileURLToPath(import.meta.url))

  /**
   * Sites where a bare `left-*`/`right-*` Tailwind utility is deliberate, keyed by path relative
   * to `frontend/src`. Each reason is a summary; the full justification lives as a comment at the
   * call site itself.
   */
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

  // Matches a bare Tailwind left-/right- position utility (digit, `n/n` fraction, `full`, `auto`,
  // or an arbitrary-value bracket) but excludes `-left-`/`-right-` so BEM modifiers like
  // `corner-btn--left` or `text-align: left` don't false-positive.
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
    // Guards against the allowlist keys going stale if this file ever moves: the round trip
    // below should be a no-op for every key.
    for (const file of Object.keys(ALLOWLIST)) {
      expect(relative(srcDir, join(srcDir, file)).split(sep).join('/')).toBe(file)
    }
  })
})
