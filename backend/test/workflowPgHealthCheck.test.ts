/**
 * OpenProject #3439: every workflow's postgres service container used a bare `--health-cmd
 * pg_isready`. With no `-U`, pg_isready probes as the container's OS user (`root`), so Postgres
 * logged `FATAL: role "root" does not exist` on every probe -- a line in every run's container log
 * that already misdirected the diagnosis of #3424. The service's POSTGRES_USER is the default
 * `postgres`, so the probe has to say so.
 *
 * Structural check against `.github/workflows/*.yml`, same category as `workflowTimeouts.test.ts`:
 * it asserts the option is present, not that Postgres reports healthy (that is CI's own job).
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const WORKFLOW_FILES = [
  '.github/workflows/quality.yml',
  '.github/workflows/build.yml',
  '.github/workflows/e2e.yml',
  '.github/workflows/release.yml'
]

type Service = { image?: string; options?: string }
type Workflow = { jobs: Record<string, { services?: Record<string, Service> }> }

/** Extract the value of `--health-cmd`, honoring a single- or double-quoted argument. */
function healthCmdOf(options: string): string | null {
  const match = /--health-cmd(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(options)
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null
}

describe('healthCmdOf', () => {
  test('reads a bare, double-quoted and single-quoted command', () => {
    assert.equal(healthCmdOf('--health-cmd pg_isready --health-interval 5s'), 'pg_isready')
    assert.equal(
      healthCmdOf('--health-cmd "pg_isready -U postgres" --health-interval 5s'),
      'pg_isready -U postgres'
    )
    assert.equal(
      healthCmdOf("--health-cmd 'pg_isready -U postgres' --health-retries 10"),
      'pg_isready -U postgres'
    )
  })

  test('returns null when there is no health command', () => {
    assert.equal(healthCmdOf('--health-interval 5s'), null)
  })
})

describe('every postgres service container probes as the postgres role (OpenProject #3439)', () => {
  for (const relPath of WORKFLOW_FILES) {
    const doc = load(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')) as Workflow

    for (const [jobId, job] of Object.entries(doc.jobs)) {
      for (const [serviceId, service] of Object.entries(job.services ?? {})) {
        if (!service.image?.startsWith('postgres')) continue

        test(`${relPath} → ${jobId} → ${serviceId} health-cmd passes -U postgres`, () => {
          const cmd = healthCmdOf(service.options ?? '')
          assert.ok(cmd, `service "${serviceId}" in ${relPath} has no --health-cmd`)
          assert.match(
            cmd,
            /^pg_isready(\s.*)?\s-U\s+postgres(\s|$)/,
            `health-cmd "${cmd}" in ${relPath} must be "pg_isready -U postgres": without -U the ` +
              'probe runs as root and logs `FATAL: role "root" does not exist` on every check.'
          )
        })
      }
    }
  }
})
