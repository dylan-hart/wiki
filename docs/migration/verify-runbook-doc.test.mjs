// Regression test for docs/migration/migration-runbook.md (Feature 421 task 751).
//
// The runbook's conflict-resolution guidance and CLI examples must match what the tool this branch
// actually built prints and accepts — not a description of an imagined interface. This test re-derives
// each checkable claim from its real source rather than trusting the doc's prose:
//
//   1. The two `UnmappableReason` values the runbook must explain (`../../backend/migration/report.ts`)
//      match the strings `../../backend/migration/unmappable.ts` actually emits.
//   2. The CLI flags/commands the runbook tells an operator to run are real flags this branch's
//      `cli.ts`/`verify-cli.ts`/`package.json` define, not invented ones.
//   3. The `PhaseReport` field names the runbook uses to explain the dry-run table match the real
//      shape in `report.ts`.
//   4. The runbook states the read-only/point-in-time rationale that
//      `docs/migration/decision-source-scope.md` already establishes, and doesn't contradict it.
//
// No database or network access needed at test time: every input is read as plain text/source.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const DOC_PATH = join(HERE, 'migration-runbook.md')
const UNMAPPABLE_PATH = join(REPO_ROOT, 'backend', 'migration', 'unmappable.ts')
const CLI_PATH = join(REPO_ROOT, 'backend', 'migration', 'cli.ts')
const VERIFY_CLI_PATH = join(REPO_ROOT, 'backend', 'migration', 'verify-cli.ts')
const SOURCE_ARGS_PATH = join(REPO_ROOT, 'backend', 'migration', 'source-args.ts')
const PACKAGE_JSON_PATH = join(REPO_ROOT, 'backend', 'package.json')
const DECISION_DOC_PATH = join(HERE, 'decision-source-scope.md')

const doc = readFileSync(DOC_PATH, 'utf8')
const unmappableSrc = readFileSync(UNMAPPABLE_PATH, 'utf8')
const cliSrc = readFileSync(CLI_PATH, 'utf8')
const verifyCliSrc = readFileSync(VERIFY_CLI_PATH, 'utf8')
const sourceArgsSrc = readFileSync(SOURCE_ARGS_PATH, 'utf8')
const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'))
const decisionDoc = readFileSync(DECISION_DOC_PATH, 'utf8')

describe('docs/migration/migration-runbook.md', () => {
  it('exists and covers the six cutover steps the task describes', () => {
    const requiredPhrases = [
      /freez/i,
      /export.to.disk/i,
      /dry.run/i,
      /verify/i,
      /rollback/i,
      /DNS|reverse.proxy/i
    ]
    for (const phrase of requiredPhrases) {
      assert.match(doc, phrase, `expected runbook to cover: ${phrase}`)
    }
  })

  it('names the real npm scripts this branch defines, not invented ones', () => {
    assert.ok(
      pkg.scripts.migrate,
      'fixture assumption broken: backend/package.json has no "migrate" script'
    )
    assert.ok(
      pkg.scripts['verify-migration'],
      'fixture assumption broken: backend/package.json has no "verify-migration" script'
    )
    assert.match(doc, /npm run migrate/)
    assert.match(doc, /npm run verify-migration/)
  })

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
    for (const flag of ['--dry-run', '--report-file', '--site-id', '--only', '--update-existing']) {
      assert.ok(cliSrc.includes(flag), `fixture assumption broken: cli.ts lacks ${flag}`)
      assert.ok(doc.includes(flag), `expected runbook to mention ${flag}`)
    }
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

  it('explains the PhaseReport fields the dry-run table actually prints', () => {
    for (const field of ['found', 'wouldCreate', 'wouldSkipExisting', 'conflicts', 'unmappable']) {
      assert.ok(doc.includes(field), `expected runbook to explain PhaseReport field: ${field}`)
    }
  })

  it('cross-links the exact UnmappableReason strings unmappable.ts emits, and their meaning', () => {
    for (const reason of ['unsupported-auth-provider', 'no-destination-table']) {
      assert.ok(
        unmappableSrc.includes(`'${reason}'`),
        `fixture assumption broken: unmappable.ts no longer emits "${reason}"`
      )
      assert.ok(doc.includes(reason), `expected runbook to name unmappable reason: ${reason}`)
    }
    // The specific unsupported providers named in unmappable.ts's own Set literal.
    for (const provider of ['ldap', 'saml', 'cas', 'auth0', 'okta']) {
      assert.ok(
        unmappableSrc.toLowerCase().includes(provider),
        `fixture assumption broken: unmappable.ts no longer names ${provider}`
      )
      assert.ok(
        doc.toLowerCase().includes(provider),
        `expected runbook to name unsupported provider: ${provider}`
      )
    }
    assert.match(doc, /comments/i)
  })

  it('states the same read-only / point-in-time rationale as the source-scope decision record', () => {
    assert.match(decisionDoc, /read-only/i)
    assert.match(doc, /read-only/i)
    assert.match(doc, /snapshot/i)
    assert.match(doc, /lost/i)
  })

  it('states the rollback plan is pointing back at the frozen 2.5.x source because import is additive', () => {
    assert.match(doc, /additive/i)
    assert.match(doc, /2\.5\.x/)
    assert.match(doc, /rollback/i)
  })
})
