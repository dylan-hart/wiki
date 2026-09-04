import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #1582/#1596 ("Convert physical spacing utilities and CSS declarations to logical
 * properties, shared library first" -- the `components/` tranche).
 *
 * #1585 converted `components/shared/` (see the sibling `shared/logicalSpacing.test.js`); this is
 * the same sweep widened to `components/` itself -- every `.vue` file directly under it (dialogs,
 * overlays, editors, nav/tree components), not `components/shared/`, which keeps its own scan.
 * `PageHistoryOverlay.vue` and `PageNewMenu.vue` were the named concentrations, but the physical
 * forms turned up across the majority of the directory.
 *
 * Scope is spacing only -- margin/padding, both as Tailwind utility classes and as CSS
 * declarations. Physical `border-*`, `text-align`, and bare `left`/`right` positioning are a
 * different, wider sweep (OpenProject #1590's allowlist triage and #1601's repo-wide CSS/SCSS
 * pass), not asserted here. This file is deliberately its own scan rather than a merge into
 * `shared/logicalSpacing.test.js`'s scope or `physicalPositioning.test.js` (which covers a
 * different population -- left/right position utilities, not spacing) -- consolidating the two
 * `logicalSpacing.test.js` scans into one repo-wide check is OpenProject #1601's job.
 */
describe('components/ carries no physical spacing utilities or declarations', () => {
  const dir = dirname(fileURLToPath(import.meta.url))

  /**
   * Files with a physical margin/padding left/right that is NOT a simple leading/trailing gutter,
   * and so cannot be swapped 1:1 for a logical property without a wider redesign. Each entry names
   * the reason so a future pass knows what it is signing up for before removing it. Every other
   * physical spacing occurrence in each of these files (if any) has already been converted --
   * these are the sole holdouts.
   */
  const ALLOWLIST = {
    // The centring trick's `margin-left: -12px` pairs with a physical `left: 50%` on the same
    // element (a classic "position at 50%, pull back by half the size" centred spinner). Converting
    // only the margin to a logical property while `left` stays a bare physical offset (out of this
    // spacing-only scan's scope -- see the module comment) would decentre the spinner under RTL
    // rather than fix anything, since the two halves of the trick would then read from opposite
    // axes.
    'LoadingGeneric.vue': 'negative margin paired with a physical `left: 50%` centring offset',
    // `pl-4`/`pr-4` sit inside the preview of an explicit physical `left`/`center`/`right` position
    // picker (`state.pos`, persisted as `rel.position`) alongside forced `text-left`/`text-right` on
    // the same elements -- a genuine physical-position feature (which side of the page a related-page
    // card is anchored to), not a reading-direction-relative gutter. Same category as the text-align
    // sweep this scan's scope excludes.
    'PageRelationDialog.vue': 'physical left/center/right position picker preview, not a gutter',
    // `.treeview-node`'s `border-left` (guide line) and its parent `.treeview-level`'s
    // `padding-left` (nesting indent) compound once per depth level, physically, and
    // `.treeview-label`'s `padding-left`/`margin-left` exist purely to undo that accumulated
    // physical drift via the `--indent` custom property (see TreeNode.vue's own comment on it) so
    // the row's highlight always reaches the tree's true left edge, flush with the guide lines.
    // Converting only the label's compensating declarations to logical properties while the drift
    // they undo (the guide line's border-left, out of this scan's scope) stays physical would
    // decouple the two under RTL and reintroduce the exact "highlight pokes out past the guide
    // line" bug (OpenProject #853) this code exists to prevent.
    'TreeNav.vue': 'compensates a physical border-left-driven nesting indent via --indent',
    // The rendered blockquote's `padding-left` is paired on the same element with its own
    // `border-left` rule (the classic quote-mark decoration) -- both physical, out of this scan's
    // scope for the border half. Converting only the padding would separate the indent from the
    // rule under RTL content.
    'EditorWysiwyg.vue': 'blockquote padding-left is paired with its own physical border-left rule'
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
  //    chosen instead -- strip HTML and block/`/**...*/` JS comments before scanning so
  //    documentation prose can't trip the same check it is explaining.
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
        `allowlisted file ${file} no longer exists under components/`
      ).toContain(file)
    }
  })
})
