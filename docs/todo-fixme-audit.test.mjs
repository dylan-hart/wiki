// Regression coverage for the TODO/FIXME audit (feature #425, task #780).
//
// This is not a scanner that re-derives the marker list at test time -- the task description is
// explicit that the list drifts between research passes, so hard-coding an expected count would
// make this test flaky by design. Instead it locks down the two durable outcomes of the audit:
//
//   1. The one stale comment this task owns (`backend/types/global.d.ts`'s `WIKI.sites` field)
//      stays fixed -- regression guard against the false "not yet converted" claim reappearing.
//   2. `docs/variances.md` keeps a citable record of the classification pass, so the excluded
//      backlog TODOs and the (already-independently-fixed) #422 bugs are reasoned about rather
//      than silently dropped, per Feature #425's acceptance shape.
//
// Run directly: node --test docs/todo-fixme-audit.test.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

const docsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(docsDir, '..')

const globalDts = readFileSync(path.join(repoRoot, 'backend/types/global.d.ts'), 'utf8')
const schemaTs = readFileSync(path.join(repoRoot, 'backend/db/schema.ts'), 'utf8')
const variances = readFileSync(path.join(docsDir, 'variances.md'), 'utf8')

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

describe('docs/variances.md TODO/FIXME audit record', () => {
  test('records that the classification pass ran, not just the unrelated oxfmt entry', () => {
    assert.match(variances, /TODO\/FIXME/i)
  })

  test('accounts for backlog TODOs owned by other epics instead of dropping them silently', () => {
    assert.match(variances, /epic/i)
  })

  test('accounts for the #422 bugs by name, noting none of their markers survive in this tree', () => {
    assert.match(variances, /#422/)
  })

  test('defers the pages.ts stale-comment fix to its owning sibling task rather than duplicating it', () => {
    assert.match(variances, /#781/)
  })

  test('does not force a bucket-(d) entry to pad the file', () => {
    const entriesStart = variances.indexOf('## Entries')
    const entryHeadings = [...variances.slice(entriesStart).matchAll(/\n### (.+)/g)].map(
      (m) => m[1]
    )
    // Only the oxfmt formatting-boundary entry from task #778 is expected here -- this task's
    // audit found no genuinely deliberate, currently-justified tradeoff among the TODO/FIXME
    // markers it reviewed.
    assert.deepEqual(entryHeadings, ['Generated icon/emoji bundles excluded from oxfmt'])
  })
})
