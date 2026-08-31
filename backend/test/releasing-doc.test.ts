/**
 * Structural checks on the top-level `RELEASING.md` — the release-manager runbook that ties
 * together the other four Feature #426 deliverables (docs/release-checklist.md,
 * docs/versioning.md, cliff.toml, .github/workflows/release.yml) into one procedure a maintainer
 * follows end to end.
 *
 * This is not a prose/style check — it asserts the runbook actually contains the load-bearing
 * pieces a maintainer unfamiliar with the mechanics needs: links to the other docs (rather than
 * restating their content), the real commands to run (git-cliff preview, `git tag` + `git push`
 * for a `vX.Y.Z` tag), and an explicit step for verifying the release.yml-produced artifacts
 * (GitHub Release, Docker tags) plus communicating the release afterward. Mirrors the structural
 * style of `release-workflow.test.ts` and `changelog.test.ts` — checking the document is
 * self-consistent with the workflow/config it describes, not just that it parses as markdown.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const RELEASING_MD = path.join(REPO_ROOT, 'RELEASING.md')
const CLIFF_CONFIG = path.join(REPO_ROOT, 'cliff.toml')

describe('RELEASING.md — release-manager runbook', () => {
  test('exists at the repo root (not buried under docs/)', () => {
    assert.ok(fs.existsSync(RELEASING_MD), `expected ${RELEASING_MD} to exist`)
  })

  const raw = fs.readFileSync(RELEASING_MD, 'utf8')

  test('links to the pre-release checklist rather than restating it', () => {
    assert.match(raw, /docs\/release-checklist\.md/)
  })

  test('links to the versioning/tagging scheme rather than restating it', () => {
    assert.match(raw, /docs\/versioning\.md/)
  })

  test('links to (or names) the release workflow it triggers', () => {
    assert.match(raw, /release\.yml/)
  })

  test('includes the git-cliff preview command from docs/versioning.md, run before tagging', () => {
    assert.match(raw, /git-cliff --unreleased/)
  })

  test('includes an actual `git tag` command for a vX.Y.Z tag', () => {
    assert.match(raw, /git tag[^\n]*v\$\{?VERSION|git tag[^\n]*v\d/)
  })

  test('signs the release tag rather than merely annotating it (WP #2280)', () => {
    assert.match(raw, /git tag -s\b/)
    assert.doesNotMatch(raw, /git tag -a\b/)
  })

  test('notes the signing-key prerequisite for a signed tag', () => {
    assert.match(raw, /signing key|signingkey|gpg|ssh signing/i)
  })

  test('has a step for verifying the published build-provenance attestation', () => {
    assert.match(raw, /gh attestation verify/)
  })

  test('includes the `git push` of the tag, which is what actually triggers release.yml', () => {
    assert.match(raw, /git push[^\n]*\btag\b|git push[^\n]*v\$\{?VERSION/)
  })

  test('has a step for verifying the resulting GitHub Release', () => {
    assert.match(raw, /GitHub Release/)
  })

  test('has a step for verifying the resulting Docker tags', () => {
    assert.match(raw, /docker pull|ghcr\.io\/requarks\/wiki/)
  })

  test('has a step for communicating the release', () => {
    assert.match(raw, /communicat/i)
  })

  test('is short and procedural, not a restatement of the linked docs (under 250 lines)', () => {
    const lineCount = raw.split('\n').length
    assert.ok(lineCount < 250, `expected a short runbook, got ${lineCount} lines`)
  })

  test('references the real cliff.toml config path it tells the reader to run against', () => {
    assert.ok(fs.existsSync(CLIFF_CONFIG))
    assert.match(raw, /cliff\.toml|git-cliff/)
  })
})
