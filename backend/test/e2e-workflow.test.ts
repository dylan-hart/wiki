/**
 * Structural check on `.github/workflows/e2e.yml` (task #2282, part of "Harden the release
 * pipeline"): unlike `quality.yml`, `build.yml` and `release.yml`, this job declared no
 * `permissions:` block, so its `GITHUB_TOKEN` inherited the repository/organisation default
 * -- and it triggers on `pull_request`, then runs PR-controlled code (`npm ci` against the
 * PR's own lockfiles, then the PR's own `e2e/playwright.config.js`, whose `webServer.command`
 * is an arbitrary shell string). `actions/checkout@v7` with no `with:` block also defaults
 * `persist-credentials` to `true`, writing the token into `.git/config` on the runner for that
 * PR-controlled code to find.
 *
 * These are not "does the workflow actually run on GitHub Actions" tests -- that would need a
 * real runner. What they assert is the structural fix: the `e2e` job is narrowed to
 * `contents: read` (matching `quality.yml`), and its checkout sets `persist-credentials: false`
 * since the job never pushes.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const E2E_YML = path.join(REPO_ROOT, '.github/workflows/e2e.yml')

describe('e2e.yml — narrowed token, no persisted credentials', () => {
  const raw = fs.readFileSync(E2E_YML, 'utf8')
  const doc: any = load(raw)
  const job = doc.jobs.e2e

  test('e2e job declares contents:read permissions, not the default token', () => {
    assert.ok(job.permissions, 'expected the e2e job to declare a permissions: block')
    assert.equal(job.permissions.contents, 'read')
  })

  test('checkout step sets persist-credentials: false', () => {
    const checkoutStep = job.steps.find((step: any) => /actions\/checkout@/.test(step.uses ?? ''))
    assert.ok(checkoutStep, 'expected an actions/checkout step')
    assert.equal(checkoutStep.with?.['persist-credentials'], false)
  })
})
