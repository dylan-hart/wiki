import { readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { listSourceFiles } from '../test/sourceFiles.js'

/**
 * Each of these surfaces names a concept this fork invented, with no page on the upstream Wiki.js
 * docs site behind it, so a `docsBase` help button there would point at a 404. `docsBase` stays
 * correct on the surfaces that do have an upstream doc page.
 */
const SRC_ROOT = dirname(fileURLToPath(import.meta.url))

const FORK_INVENTED_SURFACES = [
  ['components/TableEditorOverlay.vue', 'a table-editor concept'],
  ['pages/AdminAi.vue', 'an AI-provider concept'],
  ['pages/AdminApprovals.vue', 'a page-approval-rules concept'],
  ['pages/AdminClassification.vue', 'a classification-guardrail concept'],
  ['pages/AdminFlags.vue', 'a feature-flags concept'],
  ['pages/AdminLiveLog.vue', 'a structured-log-stream concept'],
  ['pages/AdminScheduler.vue', 'a job-scheduler concept'],
  ['pages/AdminSites.vue', 'a multi-site-administration concept']
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
