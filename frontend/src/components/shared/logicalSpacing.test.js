import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #1585 ("Convert `components/shared/*.vue` and add the logical-property source
 * scan"), part of epic #1582 ("Convert physical spacing utilities and CSS declarations to logical
 * properties, shared library first" -- 2026-08-24 audit, `accessibility-i18n.md` §15).
 *
 * This is the shared component library's own `WInput` asterisk gutter (`pr-1`), its password
 * reveal button (`mr-1`), and the rest of its ~15 physical-spacing occurrences all fixed the same
 * mechanical way `.links-list` was in `_page-contents.test.js`: a Tailwind `ml-`/`mr-`/`pl-`/`pr-`
 * margin or padding utility -- and the `text-left`/`text-right` alignment utility, the one other
 * physical direction Tailwind exposes at the class level -- resolves against the visual left/right,
 * not the reader's leading/trailing edge, so it stays glued to the wrong side of an RTL row. The
 * fix is Tailwind's own logical utilities (`ms-`/`me-`/`ps-`/`pe-`, `text-start`/`text-end`), which
 * resolve against `dir` with no JS involved -- Tailwind v4 here has no remapping of the physical
 * utilities onto logical output (`src/css/tailwind.css` adds none), so `ml-4` really does mean
 * `margin-left`, not "whichever side is currently leading".
 *
 * This is a source-level regression test in the same style as `_page-contents.test.js`: it scans
 * every `components/shared/*.vue` file's raw source for a physical utility token, rather than
 * mounting each component and reading computed styles, because the thing being pinned down is which
 * Tailwind class shipped, not any one component's particular rendered layout. Unlike that single-
 * file test, this one scans a whole directory -- new shared components are added often, and a
 * physical utility slipping into one should fail this suite the same day, not wait for someone to
 * remember to write it a bespoke check.
 *
 * `<!-- -->` and `/* *\/` comments are stripped before matching, since a couple of these components
 * document the fix in prose that itself needs to say the physical class name (`WBreadcrumbs.vue`'s
 * "`me-2`, not `mr-2`" note, `WToolbar.vue`'s "the items' own margins (`ml-4` and friends)" note
 * about how *consumers* of this component space their own toolbar items) -- those are explanatory
 * text about a physical utility, not a shipped one, and would otherwise be indistinguishable from a
 * real regression to a naive substring scan.
 */
const SHARED_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Files where a physical side is genuinely intended, not an oversight -- e.g. a rotating spinner's
 * `border-r-transparent`, which creates the illusion of motion off a fixed physical edge and has
 * nothing to do with reading direction. Keyed by filename, each value is the exact list of physical
 * tokens that file is allowed to carry; anything else still fails. Empty today -- every real
 * occurrence in the library was a genuine RTL bug and got converted -- but the mechanism stays here
 * for the next component that has an actual case for one.
 */
const ALLOWLIST = {}

function stripComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Matches a physical margin/padding utility (`ml-`, `mr-`, `pl-`, `pr-`, including a negative
 * `-ml-2` and an arbitrary `pr-[10px]`), or the bare `text-left`/`text-right` alignment utility --
 * the only other physical-direction utility this library's markup reaches for at the class level.
 * The required character immediately before the token (start-of-string, whitespace, a quote, `(`,
 * `[`, `,` or `:`) is what keeps this from matching a token that merely contains the same letters,
 * e.g. `html-`, mid-word.
 */
const PHYSICAL_UTILITY =
  /(?:^|[\s"'`([,:])(-?(?:ml|mr|pl|pr)-[\w./%[\]-]+|text-(?:left|right)(?![\w-]))/g

function findPhysicalUtilities(source) {
  const matches = []
  for (const match of stripComments(source).matchAll(PHYSICAL_UTILITY)) {
    matches.push(match[1])
  }
  return matches
}

const files = readdirSync(SHARED_DIR).filter((name) => name.endsWith('.vue'))

describe('components/shared physical spacing/alignment utility scan', () => {
  it('found at least one component to scan', () => {
    // -> A guard against a path/glob mistake silently turning this into a scan of nothing.
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file} carries no un-allowlisted physical spacing or text-align utility`, () => {
      const source = readFileSync(join(SHARED_DIR, file), 'utf-8')
      const allowed = ALLOWLIST[file] ?? []
      const found = findPhysicalUtilities(source).filter((token) => !allowed.includes(token))
      expect(found).toEqual([])
    })
  }
})
