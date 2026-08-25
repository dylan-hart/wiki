import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #1582/#1585 ("Convert physical spacing utilities and CSS declarations to logical
 * properties, shared library first").
 *
 * Feature 413's RTL audit fixed a named set of components and stopped there -- the rest of the app,
 * `components/shared/` included, was never swept. A physical margin/padding gutter (Tailwind's
 * `ml-`/`mr-`/`pl-`/`pr-`, or a raw `margin-left`/`margin-right`/`padding-left`/`padding-right`
 * declaration) stays glued to the visual left/right in an RTL layout instead of following the
 * reading direction, which is wrong wherever the physical side was standing in for "leading" or
 * "trailing" -- exactly what a spacing gutter next to an icon, a label or a sibling element usually
 * means.
 *
 * This is a source-level regression test in the same style as `css/_page-contents.test.js`: it
 * scans every `.vue` file directly under `components/shared` (the whole shared library, not one
 * named block) for the physical forms and fails if any turn up outside the allowlist below.
 *
 * Scope is spacing only -- margin/padding, both as Tailwind utility classes and as CSS
 * declarations -- matching what this task converted. Physical `border-*`, `text-align`, and bare
 * `left`/`right` positioning are a different, wider sweep (OpenProject #1590's allowlist triage and
 * #1601's repo-wide CSS/SCSS pass), not asserted here.
 */
describe('components/shared carries no physical spacing utilities or declarations', () => {
  const dir = dirname(fileURLToPath(import.meta.url))

  /**
   * Files with a physical margin/padding left/right that is NOT a simple leading/trailing gutter,
   * and so cannot be swapped 1:1 for a logical property without a wider redesign. Each entry names
   * the reason so a future pass knows what it is signing up for before removing it.
   */
  const ALLOWLIST = {
    // The elbow/vertical-run tree connectors are drawn with absolutely positioned pseudo-elements
    // whose `left`/`border-left` offsets are geometrically paired with these padding/margin values
    // (e.g. `.w-tree__node { padding: 0 0 3px 22px }` lines up with `.w-tree__node::after`'s
    // `left: -13px`). Converting the padding/margin alone would desync the indentation from the
    // connector lines under RTL, which is worse than leaving both physical -- the whole geometry
    // needs a single coordinated redesign, tracked by OpenProject #1590's deliberately-physical
    // triage, not a mechanical spacing-only swap.
    'WTreeNode.vue': 'connector-line geometry — needs a coordinated redesign, see OpenProject #1590'
  }

  const files = readdirSync(dir).filter((f) => f.endsWith('.vue') && !(f in ALLOWLIST))

  // -> A physical Tailwind spacing utility: ml-/mr-/pl-/pr- followed by a size token (digit,
  //    fraction like 0.5, or an arbitrary-value bracket) -- margin/padding-left/right, never
  //    anything else in this codebase's Tailwind config.
  const UTILITY_PATTERN = /\b(ml|mr|pl|pr)-(?:\[[^\]]+\]|\d+(?:\.\d+)?)\b/
  // -> A physical CSS margin/padding declaration, guarded by a preceding non-word boundary so it
  //    only matches the property itself, not prose mentioning it inside a comment string.
  const DECLARATION_PATTERN = /[\s;{](margin|padding)-(left|right)\s*:/

  // -> Comments legitimately discuss the physical forms while explaining why the logical one was
  //    chosen instead (see WBreadcrumbs.vue, WToolbar.vue) -- strip HTML and block/`/**...*/` JS
  //    comments before scanning so documentation prose can't trip the same check it is explaining.
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
      expect(
        readdirSync(dir),
        `allowlisted file ${file} no longer exists under components/shared`
      ).toContain(file)
    }
  })
})
