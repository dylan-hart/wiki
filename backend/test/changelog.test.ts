/**
 * Confirms the repo-root `cliff.toml` (git-cliff config, see docs/versioning.md) actually produces
 * a sane, categorized changelog from this repo's real commit history — not just that the file
 * parses.
 *
 * git-cliff is a standalone binary (not an npm dependency of any workspace, per CLAUDE.md's
 * currency/dependency stance for this task), so it is not guaranteed to be on PATH in every dev or
 * CI environment. Gated on its presence exactly like the DB-backed model suites gate on
 * `hasTestDatabase()` (see `../test/db.ts`) — skip the whole `describe` when the tool isn't
 * installed rather than failing the run.
 *
 * Deliberately does NOT hardcode any specific commit's subject or hash (OpenProject #2567): this
 * repo's history keeps moving — a squash-merge PR can drop a commit into a section
 * `cliff.toml`'s `commit_parsers` doesn't cleanly categorize, and the eventual first `vX.Y.Z` tag
 * will shrink what `--unreleased` even covers — so a literal historic reference goes stale the
 * moment either happens. Instead this cross-checks whatever the *current* `--unreleased` output
 * actually contains against this repo's own `git log`, and tolerates a section being altogether
 * absent (a small enough window can legitimately have zero `feat:` commits, say).
 */
import { describe, test, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CLIFF_CONFIG = path.join(REPO_ROOT, 'cliff.toml')

// Order matters: Features, then Bug Fixes, then Refactors, then Chores — mirroring upstream
// 2.5.x's GitHub Release convention (cliff.toml's own `<!-- N -->` group prefixes enforce this
// same order in the tool's output).
const SECTION_ORDER = ['Features', 'Bug Fixes', 'Refactors', 'Chores']

// Which real conventional-commit type each non-Chores section must actually be. Chores has no
// entry here on purpose — cliff.toml's `commit_parsers` makes it the catch-all for everything
// that isn't Features/Bug Fixes/Refactors, so verifying it means verifying the ABSENCE of the
// other three prefixes below, not the presence of one of its own.
const EXPECTED_TYPE_PREFIX: Record<string, RegExp> = {
  Features: /^feat(\(|!|:)/i,
  'Bug Fixes': /^fix(\(|!|:)/i,
  Refactors: /^refactor(\(|!|:)/i
}

const COMMIT_LINK_PATTERN =
  /\(\[[0-9a-f]{7}\]\(https:\/\/github\.com\/requarks\/wiki\/commit\/([0-9a-f]{40})\)\)/g

/** Whether the git-cliff binary is available to run this suite. */
function hasGitCliff(): boolean {
  try {
    execFileSync('git-cliff', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Splits `output` (a `git-cliff --unreleased` run) into whichever of `SECTION_ORDER`'s headings
 * are actually present, each paired with its body (from just after the heading to the next
 * heading, or EOF), sorted by where they appear in the output. A section that doesn't appear this
 * run (an empty category) is simply absent from the result — callers must not assume all four.
 */
function presentSections(output: string): { name: string; body: string }[] {
  const found = SECTION_ORDER.map((name) => ({
    name,
    index: output.indexOf(`### ${name}`)
  })).filter(({ index }) => index >= 0)
  found.sort((a, b) => a.index - b.index)
  return found.map(({ name, index }, i) => {
    const start = index + `### ${name}`.length
    const end = i + 1 < found.length ? found[i + 1].index : output.length
    return { name, body: output.slice(start, end) }
  })
}

describe('changelog generator (cliff.toml)', () => {
  test('config file exists at the repo root', () => {
    assert.ok(fs.existsSync(CLIFF_CONFIG), `expected ${CLIFF_CONFIG} to exist`)
  })

  describe('generation against real repo history', { skip: !hasGitCliff() }, () => {
    // Populated once, shared by every test below, rather than re-running `git-cliff` (and `git
    // log`) over the whole repo history — thousands of commits — for each test individually.
    let output = ''
    let subjectByHash: Map<string, string>

    before(() => {
      output = execFileSync('git-cliff', ['--config', CLIFF_CONFIG, '--unreleased'], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
      })

      const log = execFileSync('git', ['log', '--format=%H%x09%s'], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
      })
      subjectByHash = new Map()
      for (const line of log.split('\n')) {
        const tab = line.indexOf('\t')
        if (tab === -1) continue
        subjectByHash.set(line.slice(0, tab), line.slice(tab + 1))
      }
    })

    test('produces the upstream-mirroring sections that are present in the correct relative order, each non-empty', () => {
      const sections = presentSections(output)
      assert.ok(
        sections.length > 0,
        `expected at least one of ${SECTION_ORDER.join('/')} to appear in the output`
      )

      let previousRank = -1
      for (const { name, body } of sections) {
        const rank = SECTION_ORDER.indexOf(name)
        assert.ok(
          rank > previousRank,
          `expected "### ${name}" to appear after the previous section`
        )
        previousRank = rank

        assert.match(body, /^\s*- /m, `expected "### ${name}" to have at least one entry`)
      }
    })

    test('every entry references its commit via a short-hash link', () => {
      assert.match(
        output,
        /\(\[[0-9a-f]{7}\]\(https:\/\/github\.com\/requarks\/wiki\/commit\/[0-9a-f]{40}\)\)/
      )
    })

    test("categorizes this repo's real commits correctly, cross-checked against git log rather than hardcoded", () => {
      const sections = presentSections(output)
      assert.ok(sections.length > 0, 'expected at least one section to check')

      for (const { name, body } of sections) {
        const hashes = [...body.matchAll(COMMIT_LINK_PATTERN)].map((m) => m[1])
        assert.ok(hashes.length > 0, `expected "### ${name}" to reference at least one commit`)

        for (const hash of hashes) {
          const subject = subjectByHash.get(hash)
          assert.ok(
            subject !== undefined,
            `expected commit ${hash}, referenced under "### ${name}", to be real (found via git log)`
          )

          const expected = EXPECTED_TYPE_PREFIX[name]
          if (expected) {
            assert.match(
              subject as string,
              expected,
              `expected commit ${hash} ("${subject}") under "### ${name}" to actually be a ${name} commit`
            )
          } else {
            // Chores is the catch-all: assert it's none of the three specifically-typed sections,
            // rather than asserting it matches some positive "chore-shaped" pattern of its own.
            for (const [otherName, pattern] of Object.entries(EXPECTED_TYPE_PREFIX)) {
              assert.ok(
                !pattern.test(subject as string),
                `expected commit ${hash} ("${subject}") under "### Chores" not to actually be a ${otherName} commit`
              )
            }
          }
        }
      }
    })
  })
})
