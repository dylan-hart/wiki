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
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CLIFF_CONFIG = path.join(REPO_ROOT, 'cliff.toml')

/** Whether the git-cliff binary is available to run this suite. */
function hasGitCliff(): boolean {
  try {
    execFileSync('git-cliff', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('changelog generator (cliff.toml)', () => {
  test('config file exists at the repo root', () => {
    assert.ok(fs.existsSync(CLIFF_CONFIG), `expected ${CLIFF_CONFIG} to exist`)
  })

  describe('generation against real repo history', { skip: !hasGitCliff() }, () => {
    test('produces the four upstream-mirroring sections, in order, each non-empty', () => {
      const output = execFileSync('git-cliff', ['--config', CLIFF_CONFIG, '--unreleased'], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
      })

      // Order matters: Features, then Bug Fixes, then Refactors, then Chores — mirroring upstream
      // 2.5.x's GitHub Release convention.
      const sections = ['Features', 'Bug Fixes', 'Refactors', 'Chores']
      let previousIndex = -1
      for (const section of sections) {
        const heading = `### ${section}`
        const index = output.indexOf(heading)
        assert.ok(index >= 0, `expected "${heading}" to appear in the output`)
        assert.ok(
          index > previousIndex,
          `expected "${heading}" to appear after the previous section`
        )
        previousIndex = index

        // Each heading must be followed by at least one entry before the next heading (or EOF).
        const nextHeadingIndex = output.indexOf('### ', index + heading.length)
        const sectionBody = output.slice(
          index + heading.length,
          nextHeadingIndex === -1 ? output.length : nextHeadingIndex
        )
        assert.match(sectionBody, /^\s*- /m, `expected "${heading}" to have at least one entry`)
      }
    })

    test('every entry references its commit via a short-hash link', () => {
      const output = execFileSync('git-cliff', ['--config', CLIFF_CONFIG, '--unreleased'], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
      })

      assert.match(
        output,
        /\(\[[0-9a-f]{7}\]\(https:\/\/github\.com\/requarks\/wiki\/commit\/[0-9a-f]{40}\)\)/
      )
    })

    test("categorizes this fork's own recent conventional commits, not just synthetic fixtures", () => {
      const output = execFileSync('git-cliff', ['--config', CLIFF_CONFIG, '--unreleased'], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
      })

      // Real subjects from this branch's own `git log`, one per convention prefix the task calls
      // out (feat:/fix:/docs:/ci:), confirming the parser handles this repo's actual history and
      // not just the tool's own examples.
      assert.match(output, /Add versioning and tagging scheme document/) // docs:
      assert.match(output, /Block-gallery/i) // feat:
      assert.match(output, /Creating a page at a folder path should not conflict/i) // fix:
    })
  })
})
