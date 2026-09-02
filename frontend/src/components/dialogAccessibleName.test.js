import { dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../../test/sourceFiles.js'

/**
 * OpenProject #1620 ("Thread an accessible name through the 60 dialog and overlay consumers"),
 * part of the "Implement the modal contract in `WDialog`" epic (#1606, 2026-08-24 audit --
 * `accessibility-i18n.md` §2, `ux-flows.md` §10).
 *
 * `WDialog` renders `role="dialog"` + `aria-modal="true"` on its panel, and accepts `labelled-by`
 * (an id, typically a `WCardHeader`'s minted heading id) or `aria-label` (a literal string) to name
 * that dialog for assistive tech -- see `shared/WDialog.vue`'s own prop docs. Neither is required by
 * Vue or by anything at build time, so a screen reader announcing "dialog" with no name is a silent
 * regression: nothing breaks visually, nothing throws, the dialog simply has no name.
 *
 * This is a source-level regression test in the same style as `css/_page-contents.test.js`: it scans
 * every `.vue` file under this directory (recursively -- dialogs and overlays are a flat pile of
 * `components/*Dialog.vue` / `*Overlay.vue` files, with a couple of nested `<w-dialog>` usages inside
 * a dialog's own template, e.g. `PagePropertiesDialog.vue`'s relation sub-dialog) for every
 * `<w-dialog` opening tag, and asserts each one carries `labelled-by` or `aria-label`. It deliberately
 * does NOT try to mount every dialog and inspect the rendered DOM -- most of these take required
 * props or store state that would make 50+ individual mounts its own maintenance burden, and the
 * defect class here ("nobody wired the prop at all") is fully visible in the source.
 *
 * `.test.js` files are excluded from the scan on purpose: several dialogs' own test fixtures contain
 * the literal string `<w-dialog` in mock template strings, which would otherwise produce false
 * negatives (a `.test.js` "usage" that never reaches `WDialog.vue` at all) or mask a real one.
 */
const componentsDir = dirname(fileURLToPath(import.meta.url))

/**
 * Extracts every `<w-dialog ...>` opening tag (attributes included) from a component's source,
 * skipping `<w-dialog` occurrences inside an HTML comment (`WCardHeader.vue`'s header doc shows a
 * `<w-dialog>` usage example) or a `<script setup>` block comment (`WDialog.vue` and
 * `PageSaveConflictDialog.vue` both mention `` `<w-dialog>` `` in a block-comment explanatory note)
 * -- neither is a real usage, and both would otherwise register as an unlabelled one.
 *
 * A small hand-rolled tag scanner rather than a regex, because attribute values legitimately contain
 * `>` (a template expression like `count > 5`, though none currently do) and the naive
 * `/<w-dialog[^>]*>/` would stop at the first one. Tracks quote state so a `>` inside a `"..."` /
 * `'...'` / `` `...` `` attribute value doesn't end the tag early.
 */
function extractDialogTags(source) {
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const tags = []
  let searchFrom = 0
  for (;;) {
    const start = withoutComments.indexOf('<w-dialog', searchFrom)
    if (start === -1) break
    // -> Guard against `<w-dialog-something-else>` matching by accident: the tag name must end
    //    here with whitespace or `>`.
    const afterName = withoutComments[start + '<w-dialog'.length]
    if (afterName !== undefined && !/[\s/>]/.test(afterName)) {
      searchFrom = start + '<w-dialog'.length
      continue
    }
    let i = start
    let quote = null
    let end = -1
    while (i < withoutComments.length) {
      const ch = withoutComments[i]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
      } else if (ch === '>') {
        end = i
        break
      }
      i++
    }
    if (end === -1) {
      throw new Error(`Unterminated <w-dialog tag starting at offset ${start}`)
    }
    tags.push(withoutComments.slice(start, end + 1))
    searchFrom = end + 1
  }
  return tags
}

describe('every <w-dialog usage under components/ supplies an accessible name', () => {
  const files = listSourceFiles(componentsDir, { ext: ['.vue'] })

  const violations = []
  for (const file of files) {
    const source = readFileSync(file, 'utf-8')
    const tags = extractDialogTags(source)
    tags.forEach((tag, idx) => {
      if (!/\blabelled-by\b|\baria-label\b/.test(tag)) {
        violations.push(`${relative(componentsDir, file)} (usage #${idx + 1}): ${tag}`)
      }
    })
  }

  it('found at least one <w-dialog usage to check (sanity check for the scan itself)', () => {
    const total = files.reduce(
      (sum, file) => sum + extractDialogTags(readFileSync(file, 'utf-8')).length,
      0
    )
    expect(total).toBeGreaterThan(0)
  })

  it('supplies labelled-by or aria-label on every <w-dialog usage', () => {
    expect(violations).toEqual([])
  })
})
