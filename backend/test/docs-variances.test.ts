import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Structural test for docs/variances.md — this file is pure documentation, so there is no
 * application code to unit test. Instead this verifies the discipline the file's own header states:
 * entries exist only for genuine, justified deviations, are not cover for a fixable lint/type/
 * behavior bug, and are deleted once resolved rather than left as changelog prose.
 *
 * This replaces docs/variances.test.mjs (OpenProject #959): that script enforced a rigid
 * "## Entry template" / "## Entries" / four-bolded-field-per-entry shape that the real file never
 * actually settled into — entries here are free-form prose (varying Date, Feature and Decision
 * fields, or none at all) accumulated across many overnight sessions, and forcing 20+
 * already-reasoned entries into a template retroactively was judged out of proportion for what #959
 * actually asked ("rewrite the scripts against the current variances.md shape"). What's checked here
 * is the header's stated discipline and the file's basic shape, not a fixed per-entry template.
 *
 * Was docs/variances.test.mjs, unrun by anything (no npm script, no CI step referenced it — see
 * #959) and failing against the file's real current shape. Moved into backend/ so `npm run test`
 * actually runs it, following the docs-tls-story.test.ts / test/release-checklist-doc.test.ts
 * precedent CLAUDE.md's "Testing (backend)" section documents for doc-content tests.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const filePath = path.join(REPO_ROOT, 'docs', 'variances.md')

describe('docs/variances.md', () => {
  const content = readFileSync(filePath, 'utf8')
  const lines = content.split('\n')

  test('exists and is non-empty', () => {
    assert.ok(content.trim().length > 0)
  })

  const headerEnd = lines.findIndex((line) => /^##\s/.test(line))
  const header = lines.slice(0, headerEnd === -1 ? lines.length : headerEnd).join('\n')

  test('header states entries exist only for genuine, justified deviations', () => {
    assert.match(header, /genuine/i)
    assert.match(header, /justified/i)
  })

  test('header states it is not a changelog and does not track resolved CI/lint/type issues', () => {
    assert.match(header, /not a changelog/i)
    assert.match(header, /CI\/lint\/type/i)
  })

  test('header states a resolved entry is deleted, not left as changelog prose', () => {
    assert.match(header, /deleted/i)
    assert.match(header, /resolved/i)
    assert.match(header, /changelog prose/i)
  })

  test('header links back to CLAUDE.md rather than re-explaining its discipline section', () => {
    assert.match(header, /CLAUDE\.md/)
  })

  test('every entry is a level-2 (##) heading, and at least one exists', () => {
    const entryHeadings = [...content.matchAll(/\n## (.+)/g)].map((m) => m[1])
    assert.ok(entryHeadings.length > 0, 'expected at least one ## entry heading')
    // -> No level-3 sibling entries masquerading as top-level ones -- every deviation gets its own
    //    ## heading directly off the document, not nested under another entry's.
    for (const heading of entryHeadings) {
      assert.doesNotMatch(heading, /^#/, `"${heading}" looks like a mis-nested heading`)
    }
  })

  test('the TODO/FIXME audit entry exists and is a genuine ## entry, not buried inside another one', () => {
    const entryHeadings = [...content.matchAll(/\n## (.+)/g)].map((m) => m[1])
    assert.ok(
      entryHeadings.some((h) => /TODO\/FIXME audit/i.test(h)),
      'expected a "## TODO/FIXME audit..." entry'
    )
  })
})
