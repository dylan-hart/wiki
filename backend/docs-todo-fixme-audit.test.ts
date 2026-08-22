import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Regression coverage for the original TODO/FIXME audit (feature #425, task #780): the one durable,
 * still-load-bearing outcome of that pass -- `backend/types/global.d.ts`'s `WIKI.sites` comment no
 * longer claiming `db/schema.ts` still needs converting to Drizzle (it has been a real table for a
 * while), while still flagging the field's loose `Record<string, any>` typing for the real reason.
 *
 * Everything else the original docs/todo-fixme-audit.test.mjs locked down -- specific OpenProject
 * ids (#422, #781), a hard-coded single-entry `entryHeadings` list -- described a one-off snapshot of
 * docs/variances.md that the file has long since grown past (20+ further entries, an actual
 * "## TODO/FIXME audit" section this task, #959, adds). Re-deriving those from the current file would
 * just re-describe what's already there rather than guard anything; the section's actual
 * completeness is what backend/docs-todo-fixme-drift.test.ts continuously re-checks against a live
 * scan of the tree, which is the durable version of what that old test was reaching for.
 *
 * Was docs/todo-fixme-audit.test.mjs, unrun by anything (OpenProject #959). Moved into backend/ so
 * `npm run test` actually runs it.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const globalDts = readFileSync(path.join(REPO_ROOT, 'backend/types/global.d.ts'), 'utf8')
const schemaTs = readFileSync(path.join(REPO_ROOT, 'backend/db/schema.ts'), 'utf8')

describe('backend/types/global.d.ts WIKI.sites comment', () => {
  test('sites is in fact a real Drizzle table (precondition for the stale-comment fix)', () => {
    assert.match(schemaTs, /export const sites = pgTable\('sites'/)
  })

  test('no longer claims db/schema.ts still needs converting', () => {
    assert.doesNotMatch(globalDts, /once db\/schema\.ts is converted/i)
  })

  test('still flags the field as loosely typed, just for the real reason', () => {
    const sitesFieldIdx = globalDts.indexOf('sites: Record<string, any>')
    assert.notEqual(sitesFieldIdx, -1, 'expected the `sites: Record<string, any>` field to remain')
    const precedingComment = globalDts.slice(Math.max(0, sitesFieldIdx - 200), sitesFieldIdx)
    assert.match(precedingComment, /TODO/)
  })
})
