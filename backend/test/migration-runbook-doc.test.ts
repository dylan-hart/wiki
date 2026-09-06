// Regression test for docs/migration/migration-runbook.md (Feature 421 task 751). Lives here rather
// than next to the doc because npm run test's '**/*.test.ts' glob only resolves inside this
// workspace.
//
// Trimmed by OpenProject #2690 (`docs/testing-audit/backend.md`'s `test/migration-runbook-doc` row):
// the runbook's prose (which cutover steps it covers, its stated rollback rationale) is deleted —
// nothing gates a stale runbook but the next operator who follows it, and that failure is loud, not
// silent. What survives is the one genuine cross-file drift check: the CLI flags the runbook tells an
// operator to run are real flags this branch's source-args.ts/cli.ts/verify-cli.ts define, not
// invented or since-removed ones. Nothing else cross-checks the doc against the flags —
// `migration/cli.test.ts` covers what the flags *do*, not whether the runbook still names them
// correctly.
//
// No database or network access needed at test time: every input is read as plain text/source.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const MIGRATION_DOCS_DIR = join(REPO_ROOT, 'docs', 'migration')
const DOC_PATH = join(MIGRATION_DOCS_DIR, 'migration-runbook.md')
const CLI_PATH = join(REPO_ROOT, 'backend', 'migration', 'cli.ts')
const VERIFY_CLI_PATH = join(REPO_ROOT, 'backend', 'migration', 'verify-cli.ts')
const SOURCE_ARGS_PATH = join(REPO_ROOT, 'backend', 'migration', 'source-args.ts')

const doc = readFileSync(DOC_PATH, 'utf8')
const cliSrc = readFileSync(CLI_PATH, 'utf8')
const verifyCliSrc = readFileSync(VERIFY_CLI_PATH, 'utf8')
const sourceArgsSrc = readFileSync(SOURCE_ARGS_PATH, 'utf8')

describe('docs/migration/migration-runbook.md', () => {
  it('documents the real source-selection flags (postgres and export-bundle)', () => {
    for (const flag of [
      '--bundle-path',
      '--source-host',
      '--source-database',
      '--source-user',
      '--source-password'
    ]) {
      assert.ok(
        sourceArgsSrc.includes(flag),
        `fixture assumption broken: source-args.ts lacks ${flag}`
      )
      assert.ok(doc.includes(flag), `expected runbook to mention ${flag}`)
    }
  })

  it('documents the real migrate.ts flags for dry-run and reporting', () => {
    for (const flag of ['--dry-run', '--report-file', '--site-id', '--only']) {
      assert.ok(cliSrc.includes(flag), `fixture assumption broken: cli.ts lacks ${flag}`)
      assert.ok(doc.includes(flag), `expected runbook to mention ${flag}`)
    }
    // Re-run/idempotency support (--update-existing) was deliberately dropped once the destination
    // was guaranteed to always start empty (see importers/users-groups.ts's own doc comment) — the
    // runbook must not describe a flag the CLI no longer accepts.
    assert.ok(
      !cliSrc.includes('--update-existing'),
      'fixture assumption broken: cli.ts has grown --update-existing back'
    )
    assert.ok(
      !doc.includes('--update-existing'),
      'expected runbook to no longer reference the removed --update-existing flag'
    )
  })

  it('documents the real verify-migration.ts flags', () => {
    for (const flag of ['--against-report', '--sample-size', '--sample-paths']) {
      assert.ok(
        verifyCliSrc.includes(flag),
        `fixture assumption broken: verify-cli.ts lacks ${flag}`
      )
      assert.ok(doc.includes(flag), `expected runbook to mention ${flag}`)
    }
  })
})
