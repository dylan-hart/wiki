/**
 * Structural checks on the two publish workflows (task #777, splitting `build.yml`'s single
 * push-to-`scarlett` stream into a continuous alpha channel and a gated release channel — see
 * `docs/versioning.md`).
 *
 * These are not "does the workflow actually run on GitHub Actions" tests — that would need a real
 * runner. What they assert is the structural contract the task requires: `build.yml`'s trigger and
 * behavior are untouched (no behavior change to the continuous dev stream), and `release.yml`
 * exists, triggers only on a `vX.Y.Z` tag push, and hard-gates its Docker publish + GitHub Release
 * behind the same typecheck/lint/format/icon-drift checks — in an order that actually gates them,
 * not just steps present anywhere in the file.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const BUILD_YML = path.join(REPO_ROOT, '.github/workflows/build.yml')
const RELEASE_YML = path.join(REPO_ROOT, '.github/workflows/release.yml')

/** Flattens every step across every job in a parsed workflow document, in file order. */
function allSteps(doc: any): any[] {
  const steps: any[] = []
  for (const job of Object.values<any>(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      steps.push(step)
    }
  }
  return steps
}

/** Index of the first step whose `run` or `uses`+`with` text matches `pattern`, or -1. */
function findStepIndex(steps: any[], pattern: RegExp): number {
  return steps.findIndex((step) => {
    const haystack = [step.run, step.uses, JSON.stringify(step.with ?? {})]
      .filter(Boolean)
      .join('\n')
    return pattern.test(haystack)
  })
}

describe('publish workflow split (build.yml + release.yml)', () => {
  describe('build.yml — continuous alpha channel is untouched', () => {
    const raw = fs.readFileSync(BUILD_YML, 'utf8')
    const doc: any = load(raw)

    test('still triggers only on push to scarlett — no tag trigger added here', () => {
      assert.deepEqual(doc.on.push.branches, ['scarlett'])
      assert.equal(doc.on.push.tags, undefined)
    })

    test('still stamps the floating 3.0.0-alpha.$GITHUB_RUN_NUMBER version', () => {
      assert.match(raw, /REL_VERSION=3\.0\.0-alpha\.\$GITHUB_RUN_NUMBER/)
    })

    test('still pushes the floating alpha tag alongside the run-numbered one', () => {
      assert.match(raw, /ghcr\.io\/requarks\/wiki:3\.0\.0-alpha\b/)
    })
  })

  describe('release.yml — gated release channel', () => {
    test('file exists', () => {
      assert.ok(fs.existsSync(RELEASE_YML), `expected ${RELEASE_YML} to exist`)
    })

    const raw = fs.readFileSync(RELEASE_YML, 'utf8')
    const doc: any = load(raw)
    const steps = allSteps(doc)

    test('triggers only on a vX.Y.Z(-prerelease) tag push, not on branch pushes', () => {
      assert.ok(doc.on.push.tags, 'expected on.push.tags to be set')
      assert.ok(doc.on.push.tags.includes('v*'), 'expected the v* tag glob from docs/versioning.md')
      assert.equal(
        doc.on.push.branches,
        undefined,
        'release.yml must not also trigger on branch pushes'
      )
    })

    test('has contents:write and packages:write permissions for the release + registry push', () => {
      const perms = Object.values<any>(doc.jobs).find((job: any) => job.permissions)?.permissions
      assert.ok(perms, 'expected some job to declare permissions')
      assert.equal(perms.contents, 'write')
      assert.equal(perms.packages, 'write')
    })

    const gateChecks: Array<[string, RegExp]> = [
      ['backend typecheck', /npm run typecheck/],
      ['backend lint', /working-directory:\s*backend[\s\S]*?oxlint|oxlint/],
      ['frontend icons:check', /npm run icons:check/],
      ['frontend emoji:check', /npm run emoji:check/],
      ['format check (oxfmt --check)', /oxfmt.*--check/]
    ]

    for (const [label, pattern] of gateChecks) {
      test(`hard-required gate present: ${label}`, () => {
        assert.ok(
          findStepIndex(steps, pattern) !== -1,
          `expected a step matching ${pattern} for "${label}"`
        )
      })
    }

    test('oxlint runs across all three workspaces (backend, frontend, blocks)', () => {
      const oxlintSteps = steps.filter((step) => /oxlint/.test(step.run ?? ''))
      const dirs = new Set(oxlintSteps.map((step) => step['working-directory']))
      assert.ok(dirs.has('backend'), 'expected an oxlint step in backend')
      assert.ok(dirs.has('frontend'), 'expected an oxlint step in frontend')
      assert.ok(dirs.has('blocks'), 'expected an oxlint step in blocks')
    })

    test('builds and pushes the real semver Docker tag, conditionally :latest', () => {
      const dockerStepIndex = findStepIndex(steps, /docker\/build-push-action/)
      assert.ok(dockerStepIndex !== -1, 'expected a docker/build-push-action step')
      const dockerStep = steps[dockerStepIndex]
      assert.equal(dockerStep.with.push, true)
      // Must not hardcode the alpha channel's tags, and must be driven by the derived version.
      assert.doesNotMatch(JSON.stringify(dockerStep.with.tags), /3\.0\.0-alpha/)
    })

    test('all hard-required quality gates run BEFORE the Docker publish step (fail closed)', () => {
      const dockerStepIndex = findStepIndex(steps, /docker\/build-push-action/)
      assert.ok(dockerStepIndex > 0, 'expected to find the docker publish step')
      for (const [label, pattern] of gateChecks) {
        const gateIndex = findStepIndex(steps, pattern)
        assert.ok(
          gateIndex !== -1 && gateIndex < dockerStepIndex,
          `expected gate "${label}" (step ${gateIndex}) to run before the Docker publish step (step ${dockerStepIndex})`
        )
      }
    })

    test('runs the changelog generator against the range since the previous release tag', () => {
      assert.ok(
        findStepIndex(steps, /git-cliff/) !== -1,
        'expected a step invoking git-cliff (the changelog generator from the companion task)'
      )
    })

    test('creates a GitHub Release using the generated changelog as the body', () => {
      const releaseStepIndex = findStepIndex(steps, /action-gh-release/)
      assert.ok(releaseStepIndex !== -1, 'expected a step creating a GitHub Release')
      const releaseStep = steps[releaseStepIndex]
      const bodyText = JSON.stringify(releaseStep.with ?? {})
      assert.match(
        bodyText,
        /changelog/i,
        'expected the release body to be sourced from the changelog step'
      )
    })

    test('documents that the test-suite and migration checklist items are NOT CI-enforceable here', () => {
      assert.match(raw, /NOT CI-enforceable/i)
      assert.match(raw, /manual sign-off/i)
    })

    test('has actions:read permission for the build.yml run-history check', () => {
      const perms = Object.values<any>(doc.jobs).find((job: any) => job.permissions)?.permissions
      assert.equal(perms.actions, 'read')
    })

    test('guards on a successful build.yml run existing for the tagged commit, before every other gate', () => {
      const guardIndex = findStepIndex(steps, /gh run list.*--workflow=build\.yml/s)
      assert.ok(
        guardIndex !== -1,
        'expected a step asserting a build.yml run for this commit (task #1943)'
      )

      const dockerStepIndex = findStepIndex(steps, /docker\/build-push-action/)
      assert.ok(guardIndex < dockerStepIndex, 'guard must run before the Docker publish step')

      for (const [label, pattern] of gateChecks) {
        const gateIndex = findStepIndex(steps, pattern)
        assert.ok(
          guardIndex < gateIndex,
          `expected the build.yml-run guard (step ${guardIndex}) to run before gate "${label}" (step ${gateIndex})`
        )
      }

      const guardStep = steps[guardIndex]
      assert.match(
        guardStep.run,
        /--commit="\$GITHUB_SHA"/,
        'expected the guard to check the exact tagged commit'
      )
      assert.match(
        guardStep.run,
        /--status=success/,
        'expected the guard to require a successful run'
      )
      assert.match(
        guardStep.run,
        /exit 1/,
        'expected the guard to fail the job when no run is found'
      )
    })
  })
})
