import { readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * OpenProject #1929. Seven admin/editor surfaces name a concept THIS FORK invented -- there is no
 * page on the upstream Wiki.js docs site that could describe them -- so each one's `docsBase`-based
 * "help"/"view docs" button was deleted rather than left pointing at a URL that 404s. `docsBase`
 * itself is alive and correct on the ~20 surfaces that DO have an upstream doc page behind them;
 * what this gate asserts is that these seven, specifically, never grow one back.
 *
 * Seven suites used to carry a byte-identical `expect(source).not.toContain('docsBase')` against one
 * component each (`components/TableEditorOverlay.test.js`, `pages/{AdminFlags,AdminScheduler,
 * AdminApprovals,AdminTerminal,AdminClassification,AdminSites}.test.js`) -- the same assertion and
 * the same seven-paragraph rationale copied seven times, each invisible from the others. Gathered
 * here as one `describe.each` over the list, in the source-scanner style of `i18nSourceGate.test.js`,
 * it is also strictly more coverage than the seven were: a renamed or moved component used to make
 * its own suite fail with a `readFileSync` ENOENT that reads as a broken test rather than a missing
 * guard, and a NEW fork-invented surface can now be covered by adding one line here instead of a
 * whole file.
 *
 * The five rendered-DOM `docsBase` assertions elsewhere (`components/BlockPickerOverlay.test.js`,
 * `pages/{AdminCluster,AdminMetrics,AdminGlossary,AdminApi}.test.js`) are a different property --
 * that a surface which DOES have a doc page renders the link correctly -- and stay where they are.
 */
const SRC_ROOT = dirname(fileURLToPath(import.meta.url))

const FORK_INVENTED_SURFACES = [
  ['components/TableEditorOverlay.vue', 'a table-editor concept'],
  ['pages/AdminApprovals.vue', 'a page-approval-rules concept'],
  ['pages/AdminClassification.vue', 'a classification-guardrail concept'],
  ['pages/AdminFlags.vue', 'a feature-flags concept'],
  ['pages/AdminScheduler.vue', 'a job-scheduler concept'],
  ['pages/AdminSites.vue', 'a multi-site-administration concept'],
  ['pages/AdminTerminal.vue', 'an in-browser-shell concept']
]

describe('docsBase help links on fork-invented surfaces (OpenProject #1929)', () => {
  it('still has every listed component on disk, so a rename cannot silently retire its guard', () => {
    const present = new Set(
      listSourceFiles(SRC_ROOT, { ext: ['.vue'] }).map((file) =>
        relative(SRC_ROOT, file).split(sep).join('/')
      )
    )
    const missing = FORK_INVENTED_SURFACES.map(([path]) => path).filter(
      (path) => !present.has(path)
    )
    expect(missing).toEqual([])
  })

  describe.each(FORK_INVENTED_SURFACES)('%s', (path, concept) => {
    it(`has no docsBase-based help/docs button -- it names ${concept} with no upstream doc page`, () => {
      expect(readFileSync(join(SRC_ROOT, path), 'utf-8')).not.toContain('docsBase')
    })
  })
})
