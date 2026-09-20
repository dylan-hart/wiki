// Covers docs/migration/migration-runbook.md. Lives here rather than beside the doc because npm run
// test's '**/*.test.ts' glob only resolves inside this workspace. The one drift nothing else
// catches: whether the flags the runbook tells an operator to run still exist. `migration/cli.test.ts`
// covers what the flags do, not whether the runbook names them correctly.

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
    // The destination always starts empty, so there is no `--update-existing` to re-run with, and
    // the runbook must not describe a flag the CLI does not accept.
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
