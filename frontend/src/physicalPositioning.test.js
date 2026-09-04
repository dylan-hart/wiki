import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #1590 ("Triage the ~30 deliberately-physical sites into the scan's allowlist"),
 * filed under #1582/#1585 ("Convert physical spacing utilities and CSS declarations to logical
 * properties, shared library first").
 *
 * #1585 built the first source-scan-plus-allowlist for the SPACING population (Tailwind's
 * `ml-`/`mr-`/`pl-`/`pr-`, scoped to `components/shared` at the time -- #1594/#1596/#1601 later
 * widened it to a single repo-wide scan, `frontend/src/logicalSpacing.test.js`). This is the same
 * idea for a different, smaller
 * population the audit flagged separately: bare `left-*`/`right-*` Tailwind POSITION utilities,
 * which anchor an element to a physical screen edge rather than gutter it against a neighbour.
 * Most of the 422 `ml-`/`mr-`/`pl-`/`pr-` occurrences are ordinary leading/trailing spacing and
 * belong to #1594/#1596/#1601's directory-by-directory conversion; this scan is scoped to the
 * much smaller `left-*`/`right-*` population precisely because those two categories answer
 * different questions -- "which side is this gutter on" (almost always convertible) versus "which
 * corner of the SCREEN is this pinned to" (occasionally genuinely physical).
 *
 * Repo-wide from the start, unlike #1585's `components/shared`-only scan: the total population is
 * nine sites app-wide (found by exhaustively grepping every `.vue` file under `src` for the
 * pattern below), not hundreds, so there is no unconverted backlog to grow into -- every site
 * either already uses the logical form or is allowlisted below, and #1590's own "Done when" is
 * exactly that: closed now, not widened tranche by tranche the way the spacing scan is.
 *
 * A genuinely physical site pairs its `left-*`/`right-*` with ANOTHER fixed screen position (a
 * sibling corner button, a symmetric centering transform, a colour-space or numeric-scale
 * coordinate) rather than with "the content" or "the next element" -- the corner-button pairs
 * below (`WPageScroller` / `MainLayout` / `AdminLayout` / `pages/Index.vue`'s TOC opener), the
 * centering tricks (`WNotifications`'s toast stack, `WRange`'s handle label), and the
 * corner-straddling transform (`WBadge`'s floating status dot) are the recurring shapes this
 * triage found. `WMenu.vue`/`WTooltip.vue`'s dynamic pixel positioning and
 * `WColorPicker.vue`/`WRange.vue`'s colour-space/numeric-scale coordinates are the same kind of
 * "must stay physical" site, but expressed as `:style` bindings rather than Tailwind classes, so
 * they never matched this scan's pattern in the first place -- each carries its own one-line
 * justification at the call site instead (see `WMenu.vue`, `WTooltip.vue`, `WColorPicker.vue`,
 * `WRange.vue`), for the same "record a reviewed physical site" purpose without an inert allowlist
 * entry for a pattern that can never trip here.
 *
 * `WNotifications.vue`'s notification-timeout bar and `WLinearProgress.vue`'s determinate fill
 * were the one pair that turned out to be MISCLASSIFIED, not genuinely physical: both anchored a
 * shrinking/growing bar to `left-0`, which is a leading/trailing question (which edge does
 * progress read as advancing FROM) wearing a position utility's clothes -- fixed to `start-0`
 * rather than allowlisted, alongside `NavSidebar.vue`'s current-page dent, which this triage found
 * already correctly `sidebarPosition`-aware (predates #1590; no change needed there).
 */
describe('frontend/src carries no unjustified physical left-*/right-* positioning', () => {
  const srcDir = dirname(fileURLToPath(import.meta.url))

  /**
   * Sites where a bare `left-*`/`right-*` Tailwind utility is deliberate, keyed by path relative
   * to `frontend/src`. Each reason is a summary; the full justification lives as a comment at the
   * call site itself (OpenProject #1590's "Done when": every allowlisted site carries one).
   */
  const ALLOWLIST = {
    'components/shared/WBadge.vue':
      'floating status dot straddling its host’s top-right corner (right-0 paired with a physical translate-x-1/2) — see OpenProject #1590',
    'components/shared/WNotifications.vue':
      'toast stack centered on the viewport (left-1/2 paired with a physical -translate-x-1/2) — see OpenProject #1590',
    'components/shared/WPageScroller.vue':
      'default scroll-to-top corner, paired with the sidebar-opener corner button — see OpenProject #1590',
    'components/shared/WRange.vue':
      'handle label centered under its handle (left-1/2 paired with a physical -translate-x-1/2) — see OpenProject #1590',
    'layouts/MainLayout.vue':
      'sidebar-opener corner button, paired with WPageScroller’s corner — see OpenProject #1590',
    'layouts/AdminLayout.vue':
      'sidebar-opener corner button, matching MainLayout’s — see OpenProject #1590',
    'pages/Index.vue':
      'table-of-contents panel opener, paired with the scroll-to-top corner — see OpenProject #1590'
  }

  // -> A bare Tailwind position utility: left-/right- followed by a size token (digit, fraction
  //    like 1/2, `full`, `auto`, or an arbitrary-value bracket) -- inset-left/right, never
  //    anything else in this codebase's Tailwind config. Excludes `-left-`/`-right-` so it does not
  //    also match unrelated BEM modifiers like `corner-btn--left` or `text-align: left`, neither of
  //    which take this form.
  const UTILITY_PATTERN = /(?<![-\w])(left|right)-(\[[^\]]+\]|\d+(?:\/\d+)?|full|auto|px)\b/

  function stripComments(source) {
    return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  }

  /** Every `.vue` file under `src`, as paths relative to `src` with forward slashes. */
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
    // -> Cheap guard against the allowlist keys silently going stale if this file ever moves:
    //    `relative(srcDir, join(srcDir, file))` should be a no-op round trip for every key.
    for (const file of Object.keys(ALLOWLIST)) {
      expect(relative(srcDir, join(srcDir, file)).split(sep).join('/')).toBe(file)
    }
  })
})
