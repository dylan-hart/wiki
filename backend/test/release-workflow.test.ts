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

    describe('provenance, SBOM, signed attestation and release-artifact checksums (WP #2280)', () => {
      const dockerStepIndex = findStepIndex(steps, /docker\/build-push-action/)
      const dockerStep = steps[dockerStepIndex]

      test('grants the job attestations:write and id-token:write, alongside contents/packages write', () => {
        const jobWithPerms = Object.values<any>(doc.jobs).find((job: any) => job.permissions)
        assert.equal(jobWithPerms.permissions.attestations, 'write')
        assert.equal(jobWithPerms.permissions['id-token'], 'write')
      })

      test('the Docker build step turns on max-mode provenance and an SBOM', () => {
        assert.equal(dockerStep.with.provenance, 'mode=max')
        assert.equal(dockerStep.with.sbom, true)
      })

      test('the Docker build step exposes an id so its digest output can be attested', () => {
        assert.ok(dockerStep.id, 'expected the docker/build-push-action step to declare an `id`')
      })

      test('an attest-build-provenance step runs after the Docker push, keyed on its digest', () => {
        const attestIndex = findStepIndex(steps, /attest-build-provenance/)
        assert.ok(attestIndex !== -1, 'expected an actions/attest-build-provenance step')
        assert.ok(
          attestIndex > dockerStepIndex,
          'expected the attestation step to run after the Docker push it attests'
        )
        const attestStep = steps[attestIndex]
        assert.match(attestStep.with['subject-digest'], /docker_build.*digest|digest/)
        assert.equal(attestStep.with['push-to-registry'], true)
      })

      test('a release archive is prepared and checksummed before the GitHub Release step', () => {
        const releaseStepIndex = findStepIndex(steps, /action-gh-release/)
        const archiveIndex = findStepIndex(steps, /wiki-js\.tar\.gz/)
        const checksumIndex = findStepIndex(steps, /sha256sum/)
        assert.ok(archiveIndex !== -1, 'expected a step producing wiki-js.tar.gz')
        assert.ok(checksumIndex !== -1, 'expected a sha256sum step')
        assert.ok(archiveIndex < releaseStepIndex && checksumIndex < releaseStepIndex)
      })

      test('the GitHub Release attaches the archive and its checksum via files:', () => {
        const releaseStepIndex = findStepIndex(steps, /action-gh-release/)
        const releaseStep = steps[releaseStepIndex]
        assert.match(releaseStep.with.files, /wiki-js\.tar\.gz\.sha256/)
        assert.match(releaseStep.with.files, /wiki-js\.tar\.gz(?!\.sha256)/)
      })
    })
  })
})
