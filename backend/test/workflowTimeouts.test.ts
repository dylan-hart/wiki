/**
 * OpenProject #2736: no job in any workflow under `.github/workflows/` declared `timeout-minutes`,
 * so a wedged GitHub-hosted runner relied on GitHub Actions' own silent 360-minute (6 hour) default
 * job timeout to ever get killed -- discovered when PR #52's "Backend Tests" step sat stuck
 * `in_progress` for 65+ minutes with nothing to surface it early (observed baseline for that step:
 * ~6-8 minutes).
 *
 * This is a structural/self-consistency check against `.github/workflows/*.yml`, which has no
 * backend-workspace file of its own to sit next to -- same category as `verifyCi.test.ts` and
 * `release-workflow.test.ts`, which already parse these same four files (see CLAUDE.md's "Testing
 * (backend)" for the rule this follows).
 *
 * What this deliberately does NOT assert: that any particular number is "the right" timeout. A
 * wedged-runner floor is a judgment call sized with headroom over an observed/estimated baseline,
 * not a measured SLA -- the point here is only that every job HAS one, and that none of them is so
 * loose it stops meaning anything (silently drifting back toward the 360-minute default a job gets
 * when the key is simply omitted).
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

// GitHub Actions' own silent default for a job with no timeout-minutes at all. Anything at or
// above this defeats the point of declaring one -- it would still let a wedged runner run out the
// same 6-hour clock this check exists to catch.
const GITHUB_DEFAULT_JOB_TIMEOUT_MINUTES = 360

type Workflow = { jobs: Record<string, { 'timeout-minutes'?: unknown; uses?: string }> }

function loadWorkflow(relPath: string): Workflow {
  return load(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')) as Workflow
}

describe('every workflow job declares a sane timeout-minutes (OpenProject #2736)', () => {
  for (const relPath of WORKFLOW_FILES) {
    const doc = loadWorkflow(relPath)

    for (const [jobId, job] of Object.entries(doc.jobs)) {
      // A job that only `uses:` another workflow (quality.yml, called from build.yml) has no
      // steps of its own to run long -- the timeout lives on the called workflow's own job(s)
      // instead, asserted by this same test when quality.yml is its own turn through the loop.
      if (typeof job.uses === 'string') continue

      test(`${relPath} → ${jobId} declares timeout-minutes`, () => {
        assert.equal(
          typeof job['timeout-minutes'],
          'number',
          `job "${jobId}" in ${relPath} has no timeout-minutes -- without one, a wedged runner ` +
            `relies on GitHub Actions' own silent ${GITHUB_DEFAULT_JOB_TIMEOUT_MINUTES}-minute ` +
            'default before anyone finds out (OpenProject #2736).'
        )
      })

      test(`${relPath} → ${jobId} timeout-minutes is a positive number well under GitHub's default`, () => {
        const value = job['timeout-minutes'] as number
        assert.ok(
          Number.isFinite(value) && value > 0,
          `job "${jobId}" in ${relPath} has a non-positive timeout-minutes: ${value}`
        )
        assert.ok(
          value < GITHUB_DEFAULT_JOB_TIMEOUT_MINUTES,
          `job "${jobId}" in ${relPath} sets timeout-minutes: ${value}, which is not meaningfully ` +
            `tighter than GitHub Actions' own ${GITHUB_DEFAULT_JOB_TIMEOUT_MINUTES}-minute default`
        )
      })
    }
  }
})
