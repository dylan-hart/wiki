import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #1582/#1594 ("Convert `pages/Admin*.vue` and `pages/Profile*.vue` and widen the
 * scan to `pages/`"), the third tranche of "Convert physical spacing utilities and CSS
 * declarations to logical properties, shared library first" (#1582).
 *
 * #1585 built the first source-scan-plus-allowlist for the SPACING population (Tailwind's
 * `ml-`/`mr-`/`pl-`/`pr-`, plus the equivalent CSS declarations), scoped to `components/shared` --
 * see `components/shared/logicalSpacing.test.js`. This is the same scan widened to `pages/`, per
 * #1582's own coordination note: a new sibling file rather than an edit to the shared-library
 * scan's scope, and non-recursive so `pages/index/` is naturally excluded (`components/index/`'s
 * conversion is #1596's file, not this one's).
 *
 * Scope is spacing only -- margin/padding, both as Tailwind utility classes and as CSS
 * declarations (a literal `<style>` block or an inline `style:` string on a table-column config
 * object; both are genuine physical CSS, only one of them lexically inside a `<style>` tag) --
 * matching what this task converted. Physical `border-*`, `text-align`, and bare `left`/`right`
 * positioning are a different, wider sweep (OpenProject #1590's allowlist triage and #1601's
 * repo-wide CSS/SCSS pass), not asserted here -- `pages/Search.vue` in particular still carries a
 * `text-align: left` that compensates for an as-yet-unconverted physical Tailwind utility
 * elsewhere in the same rule; converting it here in isolation would be wrong ahead of that pass.
 */
describe('frontend/src/pages carries no physical spacing utilities or declarations', () => {
  const dir = dirname(fileURLToPath(import.meta.url))

  /**
   * Files with a physical margin/padding left/right that is NOT a simple leading/trailing gutter,
   * and so cannot be swapped 1:1 for a logical property without a wider redesign. Each entry names
   * the reason so a future pass knows what it is signing up for before removing it.
   */
  // Empty today: every physical spacing hit found under pages/ was an ordinary leading/trailing
  // gutter (an icon before a title, a header title's padding, a trailing chip's margin reset, a
  // column lined up under a stacked avatar) and was converted rather than allowlisted. Kept as the
  // documented place for the next such case, and guarded below so an entry naming a file that no
  // longer exists fails rather than lingering.
  const ALLOWLIST = {}

  const files = readdirSync(dir).filter((f) => f.endsWith('.vue') && !(f in ALLOWLIST))

  // -> A physical Tailwind spacing utility: ml-/mr-/pl-/pr- followed by a size token (digit,
  //    fraction like 0.5, or an arbitrary-value bracket) -- margin/padding-left/right, never
  //    anything else in this codebase's Tailwind config.
  const UTILITY_PATTERN = /\b(ml|mr|pl|pr)-(?:\[[^\]]+\]|\d+(?:\.\d+)?)\b/
  // -> A physical CSS margin/padding declaration, guarded by a preceding non-word boundary so it
  //    only matches the property itself, not prose mentioning it inside a comment string. Matches
  //    both a `<style>` block rule and an inline `style:` string (e.g. a table-column config's
  //    `style: 'width: 15px; padding-right: 0;'`) -- both are physical CSS either way.
  const DECLARATION_PATTERN = /[\s;{](margin|padding)-(left|right)\s*:/

  // -> Comments legitimately discuss the physical forms while explaining why the logical one was
  //    chosen instead (see Search.vue) -- strip HTML and block/`/**...*/` JS comments before
  //    scanning so documentation prose can't trip the same check it is explaining.
  function stripComments(source) {
    return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  }

  it.each(files)('%s', (file) => {
    const source = stripComments(readFileSync(join(dir, file), 'utf-8'))

    expect(
      source,
      `${file} uses a physical ml-/mr-/pl-/pr- utility — use ms-/me-/ps-/pe- instead`
    ).not.toMatch(UTILITY_PATTERN)
    expect(
      source,
      `${file} declares a physical margin/padding-left/right — use the *-inline-start/end form instead`
    ).not.toMatch(DECLARATION_PATTERN)
  })

  it('keeps the allowlist free of files that no longer need it', () => {
    for (const file of Object.keys(ALLOWLIST)) {
      expect(readdirSync(dir), `allowlisted file ${file} no longer exists under pages`).toContain(
        file
      )
    }
  })
})
