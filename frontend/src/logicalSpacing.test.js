import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #1601, closing out epic #1582 ("Convert physical spacing utilities and CSS
 * declarations to logical properties, shared library first").
 *
 * #1585 (`components/shared/`), #1594 (`pages/`) and #1596 (`components/`, excluding
 * `components/shared/`) each built their own tranche-scoped `logicalSpacing.test.js` -- a
 * non-recursive scan of one directory for the audit's SPACING population (Tailwind's
 * `ml-`/`mr-`/`pl-`/`pr-`, plus the equivalent `margin`/`padding-left/right` CSS declarations) --
 * per #1582's own sibling-task coordination note: a new sibling file per tranche rather than an
 * edit to a shared scan's scope, so parallel work packages never touch the same file.
 *
 * This is #1601's consolidation of those three into ONE recursive, repo-wide scan -- paths
 * relative to `frontend/src`, matching `physicalPositioning.test.js`'s own shape -- AND its
 * widening to the audit's full declared population
 * (`docs/audit-2026-08-24/accessibility-i18n.md` §15, `docs/variances.md`'s Feature 413 entry):
 * "223 physical `margin`/`padding`/`border-left|right`, bare `left:`/`right:`, and
 * `text-align: left|right` declarations". The three tranche scans covered only the first of those
 * four property groups (spacing); `border-left`/`border-right`, bare `left:`/`right:` positioning,
 * and `text-align: left|right` were explicitly left for `#1590`/`#1601` to pick up (see each
 * tranche file's own now-deleted header comment) -- this file is where that happens.
 *
 * `physicalPositioning.test.js` (#1590) stays a separate file: it covers a different population
 * (bare Tailwind `left-*`/`right-*` POSITION utilities -- anchoring an element to a screen edge --
 * not `margin`/`padding`/`border`/`text-align` declarations), already repo-wide and closed. Its own
 * ALLOWLIST is untouched here.
 *
 * `css/_page-contents.scss` is excluded from this scan: it has its own WP, and already carries its
 * own source-level regression test (`css/_page-contents.test.js`) for the one physical form it
 * once had (fixed there, not here).
 *
 * The bare `left:`/`right:` pattern requires its value to look like a real CSS length/keyword (a
 * digit, `calc(`, `var(`, or `auto`) rather than matching every `left`/`right` token in a file --
 * unlike the hyphenated properties (`margin-left`, `border-right`, ...), which have no JS/Vue
 * namesake, bare `left`/`right` collides with ordinary JS/Vue identifiers a source-level regex
 * cannot tell apart by name alone: a `DOMRect`'s `.left`, a `scrollTo()` option, ternary syntax
 * that happens to follow the word "left" (`rect.left : rect.top`), or a `:style` binding computed
 * from a template literal (`` `${toPercent(value)}%` ``, `WRange.vue`/`WColorPicker.vue`'s
 * colour-space/numeric-scale coordinates -- see `physicalPositioning.test.js`'s own header comment
 * on why those two files carry no ALLOWLIST entry here either: this guard is what keeps them out of
 * the pattern's reach in the first place, the same as it did for that scan). A declaration this
 * guard would still miss (a bare identifier value nobody has written) is not a real risk here: the
 * audit's own count was taken by hand against real source, not derived from this pattern.
 */
describe('frontend/src carries no unconverted physical spacing/border/position/alignment declarations', () => {
  const srcDir = dirname(fileURLToPath(import.meta.url))
  const EXCLUDED_FILES = new Set(['css/_page-contents.scss'])

  /**
   * Files with a physical form that is NOT a simple leading/trailing gutter, and so cannot be
   * swapped 1:1 for a logical property without a wider redesign or a coordinated change to a
   * paired property this scan does not itself check (`transform-origin`, `border-radius`'s
   * 4-value shorthand, ...). Each entry names the reason so a future pass knows what it is signing
   * up for before removing it -- and, where the file also carries its own inline comment (the
   * majority here), that comment is the fuller version of the same reasoning.
   */
  const ALLOWLIST = {
    'components/DevQuickMenu.vue':
      'centered dev-only debug tab (left: 50% + translateX(-50%)), not a reading-direction lean',
    'components/EditorWysiwyg.vue':
      "collaboration cursor label: a flag anchored to the caret's fixed left edge, its bottom-left border-radius corner cut square to touch the caret line -- border-radius's 4-value shorthand has no logical corner name that would follow `left` under RTL without a redesign",
    'components/LoadingGeneric.vue':
      'centered rotating spinner (top/left: 50% + margin-top/margin-left: -12px centring, border-top/border-right forming the rotation notch) -- decorative geometry, not a gutter',
    'components/NavItemEditor.vue':
      'nested nav item connector wedges: a border-left indent bar plus border-color/border-width 4-value physical shorthands (top/right/bottom/left order) cutting the diagonal corner nibs that join adjacent items -- no logical equivalent preserves this shape without a redesign',
    'components/PageHistoryOverlay.vue':
      'centered page title over the header (left: 50% + translateX(-50%)), not a reading-direction lean',
    'components/PageRelationDialog.vue':
      'physical left/center/right position picker preview, not a gutter (carried over from OpenProject #1596)',
    'components/TreeNav.vue':
      'compensates a physical border-left-driven nesting indent via --indent (carried over from OpenProject #1596)',
    'components/UtilCodeEditor.vue':
      "code-editor line-number gutter (right: calc(...)), conventionally fixed to one side regardless of UI direction -- the same convention Monaco's own gutter follows, since the edited content (CSS/HTML/JS/JSON/YAML) is always LTR even when the surrounding UI is not",
    'components/WelcomeOverlay.vue':
      'two centered decorative glow/content elements (left: 50% + translate), not a reading-direction lean',
    'components/shared/WSignal.vue':
      'centered ring/core (top/left: 50% + translate(-50%, -50%)), not a reading-direction lean',
    'pages/ErrorGeneric.vue':
      'two centered decorative elements (left: 50% + translate), not a reading-direction lean',
    'pages/Graph.vue':
      "two panels anchored to opposite screen corners (`.graph-view-right-rail`/`.graph-view-filters`, matching `physicalPositioning.test.js`'s own corner-panel precedent for this population) plus one centered notice (left: 50% + translateX(-50%))",
    'pages/Index.vue':
      "the TOC overlay panel, already documented physical (OpenProject #1590): paired with a fixed screen corner (the opener button), not with the reading direction -- see `physicalPositioning.test.js`'s own ALLOWLIST entry for this same file, and the inline comment here"
  }

  /** Every `.vue`/`.scss`/`.css` file under `src`, as paths relative to `src` with forward slashes. */
  function collectFiles(dir) {
    return readdirSync(dir, { recursive: true })
      .filter((entry) => /\.(vue|scss|css)$/.test(entry))
      .filter((entry) => statSync(join(dir, entry)).isFile())
      .map((entry) => entry.split(sep).join('/'))
      .filter((entry) => !EXCLUDED_FILES.has(entry))
      .sort()
  }

  // -> A physical Tailwind spacing utility: ml-/mr-/pl-/pr- followed by a size token (digit,
  //    fraction like 0.5, or an arbitrary-value bracket) -- margin/padding-left/right, never
  //    anything else in this codebase's Tailwind config.
  const UTILITY_PATTERN = /\b(ml|mr|pl|pr)-(?:\[[^\]]+\]|\d+(?:\.\d+)?)\b/

  // -> Physical CSS declarations: margin/padding/border-left|right, bare left:/right: (guarded to
  //    a CSS-shaped value -- see the module comment), and text-align: left|right. Guarded by a
  //    preceding non-word boundary so it matches the property itself, not prose mentioning it
  //    inside a comment string (stripped below regardless).
  const DECLARATION_PATTERN =
    /[\s;{](?:(?:margin|padding|border)-(?:left|right)\s*:|(?:left|right)\s*:\s*(?:-?[\d.]|calc\(|var\(|auto\b)|text-align\s*:\s*(?:left|right)\b)/

  function stripComments(source) {
    return source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1') // -> SCSS `//` line comments; guarded so it doesn't eat a `http://`/`https://` URL, which is never preceded by whitespace
  }

  const files = collectFiles(srcDir)

  it.each(files)('%s', (file) => {
    const source = stripComments(readFileSync(join(srcDir, file), 'utf-8'))
    const isAllowlisted = file in ALLOWLIST

    if (isAllowlisted) {
      expect(
        UTILITY_PATTERN.test(source) || DECLARATION_PATTERN.test(source),
        `${file} is allowlisted for a physical form but no longer has one — remove it from ALLOWLIST`
      ).toBe(true)
    } else {
      expect(
        source,
        `${file} uses a physical ml-/mr-/pl-/pr- utility — use ms-/me-/ps-/pe- instead`
      ).not.toMatch(UTILITY_PATTERN)
      expect(
        source,
        `${file} declares a physical margin/padding/border-left|right, left:/right:, or text-align: left|right — use the logical form instead, or add it to ALLOWLIST with a justification if it is genuinely not a reading-direction lean (see file header)`
      ).not.toMatch(DECLARATION_PATTERN)
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
