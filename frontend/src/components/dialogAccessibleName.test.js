import { dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../../test/sourceFiles.js'

/**
 * `WDialog` takes `labelled-by` or `aria-label` to name its panel for assistive tech, and nothing
 * requires either at build time -- an unnamed dialog throws nothing and looks fine, so the
 * regression is silent. Scanned at source level rather than by mounting all 50+ dialogs: most take
 * required props or store state, and the defect class ("nobody wired the prop at all") is fully
 * visible in the source. `.test.js` files are excluded because their mock template strings contain
 * the literal tag without ever reaching `WDialog.vue`.
 */
const componentsDir = dirname(fileURLToPath(import.meta.url))

/**
 * Occurrences inside an HTML or block comment are skipped: several components mention the tag in an
 * explanatory note or usage example, and each would otherwise register as an unlabelled usage.
 *
 * Hand-rolled rather than a regex, because an attribute value can legitimately contain `>` (a
 * template expression like `count > 5`) and the naive `/<w-dialog[^>]*>/` would stop at the first
 * one. Quote state keeps a `>` inside an attribute value from ending the tag early.
 */
function extractDialogTags(source) {
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const tags = []
  let searchFrom = 0
  for (;;) {
    const start = withoutComments.indexOf('<w-dialog', searchFrom)
    if (start === -1) break
    // -> A longer tag name (`w-dialog-something`) must not match: the name ends here.
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
