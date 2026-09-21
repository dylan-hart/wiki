import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `physicalPositioning.test.js` covers a different population (Tailwind's bare `left-*`/`right-*`
 * position utilities), and `css/_page-contents.css` is excluded because it carries its own scan
 * (`css/_page-contents.test.js`).
 *
 * The bare `left:`/`right:` pattern requires a CSS-shaped value (a digit, `calc(`, `var(` or
 * `auto`): unlike the hyphenated properties, bare `left`/`right` collides with ordinary JS -- a
 * `DOMRect`'s `.left`, a ternary (`rect.left : rect.top`), a `:style` binding computed from a
 * template literal.
 */
describe('frontend/src carries no unconverted physical spacing/border/position/alignment declarations', () => {
  const srcDir = dirname(fileURLToPath(import.meta.url))
  const EXCLUDED_FILES = new Set(['css/_page-contents.css'])

  /**
   * Files whose physical form is not a simple leading/trailing gutter, so it cannot be swapped 1:1
   * for a logical property without a wider redesign or a coordinated change to a paired property
   * this scan does not check (`transform-origin`, `border-radius`'s 4-value shorthand).
   */
  const ALLOWLIST = {
    'components/DevQuickMenu.vue':
      'centered dev-only debug tab (left: 50% + translateX(-50%)), not a reading-direction lean',
    'components/EditorWysiwyg.vue':
      "collaboration cursor label: a flag anchored to the caret's fixed left edge, its bottom-left border-radius corner cut square to touch the caret line -- border-radius's 4-value shorthand has no logical corner name that would follow `left` under RTL without a redesign",
    'components/LoadingGeneric.vue':
      'centered rotating spinner (top/left: 50% + margin-top/margin-left: -12px centring, border-top/border-right forming the rotation notch) -- decorative geometry, not a gutter',
    'components/PageHistoryOverlay.vue':
      'centered page title over the header (left: 50% + translateX(-50%)), not a reading-direction lean',
    'components/PageRelationDialog.vue':
      'physical left/center/right position picker preview, not a gutter (carried over from OpenProject #1596)',
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

  function collectFiles(dir) {
    return readdirSync(dir, { recursive: true })
      .filter((entry) => /\.(vue|css)$/.test(entry))
      .filter((entry) => statSync(join(dir, entry)).isFile())
      .map((entry) => entry.split(sep).join('/'))
      .filter((entry) => !EXCLUDED_FILES.has(entry))
      .sort()
  }

  const UTILITY_PATTERN = /\b(ml|mr|pl|pr)-(?:(?:auto|px|\d+(?:\.\d+)?)\b|\[[^\]]+\])/

  // -> The leading `[\s;{]` anchors on the property itself rather than the tail of a longer name
  const DECLARATION_PATTERN =
    /[\s;{](?:(?:margin|padding|border)-(?:left|right)\s*:|(?:left|right)\s*:\s*(?:-?[\d.]|calc\(|var\(|auto\b)|text-align\s*:\s*(?:left|right)\b)/

  function stripComments(source) {
    return source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1') // -> the `(^|\s)` guard keeps a URL's `//` from matching
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

  it.each(['ml-auto', 'mr-auto', 'pl-px', 'pr-px', '-ml-px', 'ml-2', 'pr-[3px]'])(
    'flags the physical utility %s',
    (utility) => {
      expect(`<div class="flex ${utility}">`).toMatch(UTILITY_PATTERN)
    }
  )

  it.each(['ms-auto', 'me-auto', 'ps-px', 'pe-px', 'ml-autofill', 'pl-pxl'])(
    'does not flag %s',
    (utility) => {
      expect(`<div class="flex ${utility}">`).not.toMatch(UTILITY_PATTERN)
    }
  )

  it('keeps the allowlist free of files that no longer exist', () => {
    const relFiles = new Set(files)
    for (const file of Object.keys(ALLOWLIST)) {
      expect(relFiles, `allowlisted file ${file} no longer exists under frontend/src`).toContain(
        file
      )
    }
  })

  it('is running against every allowlisted file relative to src, not some other base', () => {
    // -> The round trip is a no-op for any normalised key wherever this file lives, so it only
    //    catches a `./`-prefixed or backslashed one; the existence check above is the real guard
    for (const file of Object.keys(ALLOWLIST)) {
      expect(relative(srcDir, join(srcDir, file)).split(sep).join('/')).toBe(file)
    }
  })
})
