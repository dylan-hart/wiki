import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The one recursive source walker for this workspace's source-scanning suites.
 *
 * Seven of them had copied the same readdir-recurse-filter loop: `src/autofocusUsage.test.js` ≡
 * `src/buttonAccessibility.test.js`, `src/imgAlt.test.js` ≡ `src/adminIconHeaderSize.test.js`, plus
 * `src/components/dialogAccessibleName.test.js`, `src/i18nSourceGate.test.js`, `src/css/_base.test.js`,
 * `src/physicalPositioning.test.js` and `src/i18nUnexpectedErrorLiteral.test.js` -- differing only in
 * which extensions they kept and whether they skipped test files.
 *
 * `ext` is a list of extensions to keep; `skip` is either a list of substrings or a predicate over
 * the absolute path (the scanners that exclude `.test.js`, or their own file, want one or the
 * other). The result is sorted, so a scanner's failure message names the same file first on every
 * machine regardless of readdir order.
 */
export function listSourceFiles(root, { ext = ['.vue', '.js'], skip = [] } = {}) {
  const rejects =
    typeof skip === 'function' ? skip : (full) => skip.some((fragment) => full.includes(fragment))
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (rejects(full)) continue
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full, { ext, skip }))
    } else if (ext.some((suffix) => entry.name.endsWith(suffix))) {
      out.push(full)
    }
  }
  return out.sort()
}
