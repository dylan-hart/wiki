/**
 * Structural checks on `.github/dependabot.yml` (task #2284, part of the "Harden the release
 * pipeline" epic #2271). This repo has four independently-installed npm workspaces (`backend/`,
 * `frontend/`, `blocks/`, `e2e/`) and no root manifest, plus GitHub Actions workflows under
 * `.github/workflows/`. Without a Dependabot config, a vulnerability disclosed against any of the
 * ~160 exact-pinned dependency versions produces no signal — CI stays green, no bot opens a PR.
 *
 * These assertions aren't "does Dependabot actually run" (that needs a real GitHub scan against
 * the default branch) — they're the structural contract: every workspace directory is covered by
 * an `npm` ecosystem entry, `github-actions` is covered, and no root/nonexistent directory is
 * accidentally included.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const DEPENDABOT_YML = path.join(REPO_ROOT, '.github/dependabot.yml')

describe('.github/dependabot.yml', () => {
  test('file exists', () => {
    assert.ok(fs.existsSync(DEPENDABOT_YML), `expected ${DEPENDABOT_YML} to exist`)
  })

  const raw = fs.readFileSync(DEPENDABOT_YML, 'utf8')
  const doc: any = load(raw)

  test('is valid YAML with version 2', () => {
    assert.ok(doc, 'expected the file to parse to a non-empty document')
    assert.equal(doc.version, 2)
  })

  test('has an updates array', () => {
    assert.ok(Array.isArray(doc.updates), 'expected doc.updates to be an array')
  })

  const npmEntries = (doc.updates ?? []).filter(
    (entry: any) => entry['package-ecosystem'] === 'npm'
  )
  const npmDirectories = new Set(npmEntries.map((entry: any) => entry.directory))

  test('covers exactly the four npm workspaces, no more, no fewer', () => {
    assert.deepEqual(npmDirectories, new Set(['/backend', '/frontend', '/blocks', '/e2e']))
  })

  test('every npm entry directory resolves to a real workspace with a package.json', () => {
    for (const entry of npmEntries) {
      const dir = path.join(REPO_ROOT, entry.directory)
      assert.ok(fs.existsSync(dir), `expected ${dir} to exist`)
      assert.ok(
        fs.existsSync(path.join(dir, 'package.json')),
        `expected ${dir}/package.json to exist`
      )
    }
  })

  test('every npm entry declares a schedule', () => {
    for (const entry of npmEntries) {
      assert.ok(entry.schedule?.interval, `expected a schedule.interval on ${entry.directory}`)
    }
  })

  const actionsEntries = (doc.updates ?? []).filter(
    (entry: any) => entry['package-ecosystem'] === 'github-actions'
  )

  test('covers the github-actions ecosystem exactly once, rooted at /', () => {
    assert.equal(actionsEntries.length, 1)
    assert.equal(actionsEntries[0].directory, '/')
    assert.ok(
      actionsEntries[0].schedule?.interval,
      'expected a schedule.interval on the github-actions entry'
    )
  })

  test('does not include a root npm entry (no root package.json exists in this repo)', () => {
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'package.json')), 'expected no root package.json')
    assert.ok(!npmDirectories.has('/'), 'expected no npm entry with directory /')
  })

  test('has exactly five update entries total (4 npm + 1 github-actions)', () => {
    assert.equal((doc.updates ?? []).length, 5)
  })
})
