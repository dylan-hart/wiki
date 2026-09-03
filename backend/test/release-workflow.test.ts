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
const QUALITY_YML = path.join(REPO_ROOT, '.github/workflows/quality.yml')
const E2E_YML = path.join(REPO_ROOT, '.github/workflows/e2e.yml')
const ALL_WORKFLOW_FILES = [BUILD_YML, RELEASE_YML, QUALITY_YML, E2E_YML]

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

    test('still pushes the floating alpha tag alongside the run-numbered one, under a namespace derived from the repository', () => {
      assert.match(raw, /\$\{\{\s*env\.IMAGE_NAMESPACE\s*\}\}:3\.0\.0-alpha\b/)
      assert.doesNotMatch(raw, /ghcr\.io\/requarks\/wiki/)
    })

    test('derives the GHCR namespace from github.repository rather than hard-coding an owner', () => {
      assert.match(raw, /IMAGE_NAMESPACE:\s*ghcr\.io\/\$\{\{\s*github\.repository\s*\}\}/)
    })
  })

  describe('multi-arch publishing decision (OpenProject #1916) — both workflows agree', () => {
    const buildRaw = fs.readFileSync(BUILD_YML, 'utf8')
    const buildDoc: any = load(buildRaw)
    const releaseRaw = fs.readFileSync(RELEASE_YML, 'utf8')
    const releaseDoc: any = load(releaseRaw)

    function platformsOf(doc: any): string {
      const step = allSteps(doc).find((s) => /docker\/build-push-action/.test(s.uses ?? ''))
      assert.ok(step, 'expected a docker/build-push-action step')
      return step.with.platforms
    }

    test('build.yml and release.yml declare the same platforms: value', () => {
      assert.equal(platformsOf(buildDoc), platformsOf(releaseDoc))
    })

    test('neither workflow leaves a commented-out platforms: line behind', () => {
      assert.doesNotMatch(
        buildRaw,
        /^\s*#\s*platforms:/m,
        'build.yml has a commented-out platforms: line'
      )
      assert.doesNotMatch(
        releaseRaw,
        /^\s*#\s*platforms:/m,
        'release.yml has a commented-out platforms: line'
      )
    })

    // OpenProject #2435/#2486: the amd64-only decision above was revisited once arm64 image
    // availability was actually requested (Issue #2388, a Raspberry Pi user report) — both
    // workflows now target linux/arm64 too, cross-built via QEMU emulation since GitHub-hosted
    // runners are amd64-only.
    test('both workflows include linux/arm64 alongside linux/amd64', () => {
      for (const [label, doc] of [
        ['build.yml', buildDoc],
        ['release.yml', releaseDoc]
      ] as const) {
        const platforms = platformsOf(doc)
          .split(',')
          .map((p) => p.trim())
        assert.ok(
          platforms.includes('linux/amd64'),
          `expected ${label} to still target linux/amd64`
        )
        assert.ok(platforms.includes('linux/arm64'), `expected ${label} to target linux/arm64`)
      }
    })

    test('both workflows set up QEMU before Buildx, so the arm64 layer can cross-build via emulation', () => {
      for (const [label, doc] of [
        ['build.yml', buildDoc],
        ['release.yml', releaseDoc]
      ] as const) {
        const steps = allSteps(doc)
        const qemuIndex = findStepIndex(steps, /docker\/setup-qemu-action/)
        const buildxIndex = findStepIndex(steps, /docker\/setup-buildx-action/)
        assert.ok(qemuIndex !== -1, `expected ${label} to have a docker/setup-qemu-action step`)
        assert.ok(buildxIndex !== -1, `expected ${label} to have a docker/setup-buildx-action step`)
        assert.ok(
          qemuIndex < buildxIndex,
          `expected ${label}'s QEMU setup (step ${qemuIndex}) to run before Buildx setup (step ${buildxIndex})`
        )
      }
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

    test('derives the GHCR namespace from github.repository rather than hard-coding an owner', () => {
      assert.match(raw, /IMAGE_NAMESPACE:\s*ghcr\.io\/\$\{\{\s*github\.repository\s*\}\}/)
      assert.doesNotMatch(raw, /ghcr\.io\/requarks\/wiki/)
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

    test('fails closed before building/publishing anything when the tag is not on scarlett', () => {
      const containmentIndex = findStepIndex(steps, /merge-base\s+--is-ancestor/)
      assert.ok(containmentIndex !== -1, 'expected a step running git merge-base --is-ancestor')

      const containmentStep = steps[containmentIndex]
      assert.match(
        containmentStep.run,
        /origin\/scarlett/,
        'expected the containment check to compare against origin/scarlett'
      )
      assert.match(
        containmentStep.run,
        /\$GITHUB_SHA/,
        'expected the containment check to test the tagged commit ($GITHUB_SHA)'
      )
      assert.match(
        containmentStep.run,
        /exit 1/,
        'expected the step to exit non-zero (fail the job) when the ancestor check fails'
      )

      // Must fetch the scarlett ref explicitly — fetch-depth: 0 on checkout gives full history for
      // the tag ref, not a guaranteed origin/scarlett remote-tracking ref.
      assert.match(
        containmentStep.run,
        /git fetch origin scarlett/,
        'expected an explicit fetch of the scarlett branch before the ancestor check'
      )

      // Must run immediately after checkout — before Node setup, every quality gate, the
      // build.yml-run guard, and the Docker publish step — so nothing downstream ever executes
      // against an out-of-branch tag.
      const checkoutIndex = findStepIndex(steps, /actions\/checkout/)
      const guardIndex = findStepIndex(steps, /gh run list.*--workflow=build\.yml/s)
      const dockerStepIndex = findStepIndex(steps, /docker\/build-push-action/)
      assert.ok(checkoutIndex !== -1, 'expected a checkout step')
      assert.ok(
        containmentIndex === checkoutIndex + 1,
        'expected the containment check to be the step immediately after checkout'
      )
      assert.ok(
        containmentIndex < guardIndex,
        'expected the containment check to run before the build.yml-run guard'
      )
      assert.ok(
        containmentIndex < dockerStepIndex,
        'expected the containment check to run before the Docker publish step'
      )
      for (const [, pattern] of gateChecks) {
        const gateIndex = findStepIndex(steps, pattern)
        assert.ok(
          containmentIndex < gateIndex,
          'expected the containment check to run before the quality gates too'
        )
      }
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

      test('the attestation subject-name is driven by the derived GHCR namespace, not hard-coded', () => {
        const attestIndex = findStepIndex(steps, /attest-build-provenance/)
        const attestStep = steps[attestIndex]
        assert.match(String(attestStep.with['subject-name']), /env\.IMAGE_NAMESPACE/)
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

// task #2273: a git tag is mutable, so a floating `@v4`/`@v7`-style `uses:` reference lets whoever
// owns or compromises an action repository repoint it and have every one of these four workflows
// execute the new commit on the next run, with nothing here to review. Every external action must
// be pinned to the full 40-character commit SHA it currently resolves to; the version stays visible
// as a trailing `# vX.Y.Z` comment so a re-pin is still a one-line, reviewable diff. The one `uses:`
// that is exempt is build.yml's `./.github/workflows/quality.yml` — a local, same-repo composite
// reference, not an external action, so there is no separately-owned tag for anyone to repoint.
describe('external actions are SHA-pinned across all four workflows', () => {
  const SHA_PINNED = /^[^@]+@[0-9a-f]{40}(\s+#\s*v\S+)?$/
  const LOCAL_REF = /^\.\//

  for (const file of ALL_WORKFLOW_FILES) {
    const relPath = path.relative(REPO_ROOT, file)

    describe(relPath, () => {
      // Parse the raw text (not js-yaml's `load`), since js-yaml strips trailing comments and this
      // test needs to see the `# vX.Y.Z` annotation that lives on the same line as the pinned SHA.
      const raw = fs.readFileSync(file, 'utf8')
      const usesLines = raw
        .split('\n')
        .map((line) => line.match(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1])

      test('has at least one `uses:` reference to check', () => {
        assert.ok(usesLines.length > 0, `expected at least one uses: line in ${relPath}`)
      })

      for (const usesValue of usesLines) {
        const label = usesValue.length > 60 ? `${usesValue.slice(0, 60)}…` : usesValue

        if (LOCAL_REF.test(usesValue)) {
          test(`local composite reference is left as-is: ${label}`, () => {
            assert.doesNotMatch(
              usesValue,
              /@/,
              `expected local reference "${usesValue}" in ${relPath} to carry no @ref at all`
            )
          })
          continue
        }

        test(`external action is SHA-pinned with a version comment: ${label}`, () => {
          assert.match(
            usesValue,
            SHA_PINNED,
            `expected "${usesValue}" in ${relPath} to be pinned to a 40-character commit SHA ` +
              '(owner/repo@<40-hex-sha> # vX.Y.Z), not a floating tag'
          )
        })
      }
    })
  }

  test('fails against a floating-tag reference (sanity check on the assertion itself)', () => {
    assert.doesNotMatch('actions/checkout@v7', /^[^@]+@[0-9a-f]{40}(\s+#\s*v\S+)?$/)
    assert.match(
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      /^[^@]+@[0-9a-f]{40}(\s+#\s*v\S+)?$/
    )
  })
})
