/**
 * Structural + self-consistency checks on `docs/release-checklist.md` (Feature #426, task #775).
 *
 * Two kinds of assertion here:
 *  - Structural: the checklist actually contains the items the task requires (the four CI gates,
 *    the test-suite item, the variances.md review, the Epic 13 migration sign-off) and
 *    cross-references docs/versioning.md for what a "release" trigger is, mirroring the style of
 *    `release-workflow.test.ts` and `releasing-doc.test.ts`.
 *  - Self-consistency: several items describe whether a dependency (Feature #423's CI gates,
 *    Feature #424's test suites, Feature #425's variances.md, Epic #341's migration CLI) has
 *    landed *yet*, phrased as "as of this writing". Those claims are checked against the actual
 *    repo state rather than trusted as prose, so the document cannot silently go stale the moment
 *    one of those sibling Features lands on this branch without this test catching it.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CHECKLIST_MD = path.join(REPO_ROOT, 'docs/release-checklist.md')

/** True if `dir` (relative to repo root) has a package.json with a "test" script. */
function hasTestScript(dir: string): boolean {
  const pkgPath = path.join(REPO_ROOT, dir, 'package.json')
  if (!fs.existsSync(pkgPath)) return false
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  return typeof pkg.scripts?.test === 'string' && pkg.scripts.test.length > 0
}

/** True if `dir` (relative to repo root) contains at least one *.test.* file, excluding node_modules. */
function hasTestFiles(dir: string, extPattern: RegExp): boolean {
  const root = path.join(REPO_ROOT, dir)
  if (!fs.existsSync(root)) return false
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()!
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (extPattern.test(entry.name)) {
        return true
      }
    }
  }
  return false
}

describe('docs/release-checklist.md — pre-release checklist', () => {
  test('exists', () => {
    assert.ok(fs.existsSync(CHECKLIST_MD), `expected ${CHECKLIST_MD} to exist`)
  })

  const raw = fs.readFileSync(CHECKLIST_MD, 'utf8')

  test('cross-references docs/versioning.md for what a release trigger is', () => {
    assert.match(raw, /docs\/versioning\.md/)
  })

  describe('item 1 — CI quality gates (Feature #423)', () => {
    test('names all four gates without re-specifying their implementation', () => {
      assert.match(raw, /typecheck/)
      assert.match(raw, /oxlint/)
      assert.match(raw, /oxfmt --check|oxfmt.*check/)
      assert.match(raw, /icons:check/)
      assert.match(raw, /emoji:check/)
    })

    test('attributes ownership to Feature #423', () => {
      assert.match(raw, /#423/)
    })

    test('phrases the gates as "must be green" rather than re-deriving pass/fail logic', () => {
      assert.match(raw, /must be green/)
    })
  })

  describe('item 2 — test suites (Feature #424) reflects actual repo state', () => {
    const backendHasTests = hasTestScript('backend') && hasTestFiles('backend', /\.test\.ts$/)
    const frontendHasTests =
      hasTestScript('frontend') && hasTestFiles('frontend/src', /\.test\.js$/)
    const blocksHasTests = hasTestScript('blocks') && hasTestFiles('blocks', /\.test\.js$/)
    const e2eHasTests = hasTestScript('e2e')
    const allWired = backendHasTests && frontendHasTests && blocksHasTests && e2eHasTests

    test('attributes ownership to Feature #424', () => {
      assert.match(raw, /#424/)
    })

    test('sanity: this repo actually has test suites in every workspace right now', () => {
      // If this fails, the fixture assumption below (allWired) is wrong for the current branch
      // state and the two tests below need re-reading, not silencing.
      assert.ok(backendHasTests, 'expected backend/*.test.ts files + a test script')
      assert.ok(frontendHasTests, 'expected frontend/src/**/*.test.js files + a test script')
      assert.ok(blocksHasTests, 'expected blocks/**/*.test.js files + a test script')
      assert.ok(e2eHasTests, 'expected an e2e/ test script')
    })

    test('does NOT claim no test framework exists, now that all workspaces have one', () => {
      if (!allWired) return
      assert.doesNotMatch(
        raw,
        /no test framework exists in any workspace/i,
        'test suites are wired in every workspace on this branch — the checklist must not claim otherwise'
      )
    })

    test('documents that the suites are wired into build.yml CI, not just present on disk', () => {
      if (!allWired) return
      assert.match(raw, /build\.yml/)
    })
  })

  describe('item 3 — docs/variances.md (Feature #425) reflects actual repo state', () => {
    const variancesExists = fs.existsSync(path.join(REPO_ROOT, 'docs/variances.md'))

    test('attributes ownership to Feature #425', () => {
      assert.match(raw, /#425/)
    })

    test('claim about variances.md existing matches the actual filesystem', () => {
      if (variancesExists) {
        assert.doesNotMatch(
          raw,
          /variances\.md.{0,40}does not exist yet|file does not exist/i,
          'docs/variances.md exists now — the checklist must not still say it does not'
        )
      } else {
        assert.match(
          raw,
          /does not exist yet/i,
          'docs/variances.md does not exist yet — the checklist should say so, not assume it'
        )
      }
    })
  })

  describe('item 5 — Epic 13 migration tooling sign-off', () => {
    test('explicitly states this item cannot be a CI assertion', () => {
      assert.match(raw, /cannot.*(be a )?CI assertion|never be a CI assertion/i)
    })

    test('names a real 2.5.x dataset and dry-run procedure', () => {
      assert.match(raw, /2\.5\.x/)
      assert.match(raw, /dry-run/i)
    })

    test('describes where the sign-off gets recorded (release PR description)', () => {
      assert.match(raw, /release PR/i)
    })

    test('requires a named human, not just a checkbox', () => {
      assert.match(raw, /named human/i)
    })
  })

  describe('item 6 — ARM host verification (Epic #2435 / WP #2488)', () => {
    test('attributes ownership to Epic #2435 and WP #2488', () => {
      assert.match(raw, /#2435/)
      assert.match(raw, /#2488/)
    })

    test('explicitly states this item cannot be a full CI assertion', () => {
      assert.match(raw, /cannot.*(be a )?(full )?CI assertion|never.*CI (runner|assertion)/i)
    })

    test('names the two verification scripts', () => {
      assert.match(raw, /verify-arm64-manifest\.ts/)
      assert.match(raw, /arm-host-smoke-test\.sh/)
    })

    test('claim about the arm64 image being published matches sibling WP #2486/#2487 status', () => {
      // WP #2486/#2487 add linux/arm64 to build.yml/release.yml. Until at least one of those
      // workflows actually declares linux/arm64, no arm64-including image can have been published,
      // and this item must say so rather than assume it.
      const buildYml = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/build.yml'), 'utf8')
      const releaseYml = fs.readFileSync(
        path.join(REPO_ROOT, '.github/workflows/release.yml'),
        'utf8'
      )
      const arm64Wired = /linux\/arm64/.test(buildYml) || /linux\/arm64/.test(releaseYml)

      if (arm64Wired) {
        assert.doesNotMatch(
          raw,
          /No image with an arm64 platform in its manifest has ever been published/,
          'a workflow now declares linux/arm64 — the checklist must not still claim none does'
        )
      } else {
        assert.match(
          raw,
          /No image with an arm64 platform in its manifest has ever been published/,
          'neither workflow declares linux/arm64 yet — the checklist should say so, not assume it exists'
        )
      }
    })

    test('requires a named human recording the host used, not just a checkbox', () => {
      assert.match(raw, /named human/i)
    })

    test('describes where the sign-off gets recorded (release PR description)', () => {
      assert.match(raw, /release PR/i)
    })
  })

  test('spells out unambiguous go/no-go usage instructions', () => {
    assert.match(raw, /go[- /]?no-go/i)
  })

  test('cross-references RELEASING.md for the runbook that follows a "go"', () => {
    assert.match(raw, /RELEASING\.md/)
  })
})
