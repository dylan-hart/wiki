/**
 * git-cliff is a standalone binary rather than a workspace dependency, so both describes skip when
 * it is not on PATH, the way the DB-backed suites skip without a `DATABASE_URL`.
 *
 * The real-history describe runs over FULL history, not `--unreleased`: a `vX.Y.Z` tag landing at
 * HEAD legitimately empties that window, which would fail every content assertion for no defect at
 * all. `--unreleased` gets one test of its own, claiming only that it renders cleanly.
 *
 * The synthetic fixture repo is the only way to pin specific commit shapes deterministically, and
 * the only way to exercise the tagged-release cases while this repo has no tags.
 */
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CLIFF_CONFIG = path.join(REPO_ROOT, 'cliff.toml')

// Order matters: it mirrors `cliff.toml`'s own `<!-- N -->` group prefixes, which is what fixes
// this order in the tool's output.
const SECTION_ORDER = ['Features', 'Bug Fixes', 'Refactors', 'Chores']

// Chores has no entry on purpose: `cliff.toml` makes it the catch-all, so verifying it means
// verifying the ABSENCE of the other three prefixes, not the presence of one of its own.
const EXPECTED_TYPE_PREFIX: Record<string, RegExp> = {
  Features: /^feat(\(|!|:)/i,
  'Bug Fixes': /^fix(\(|!|:)/i,
  Refactors: /^refactor(\(|!|:)/i
}

const COMMIT_LINK_PATTERN =
  /\(\[[0-9a-f]{7}\]\(https:\/\/github\.com\/requarks\/wiki\/commit\/([0-9a-f]{40})\)\)/

function hasGitCliff(): boolean {
  try {
    execFileSync('git-cliff', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function runGitCliff(cwd: string, ...args: string[]): string {
  return execFileSync('git-cliff', ['--config', CLIFF_CONFIG, ...args], {
    cwd,
    encoding: 'utf8'
  })
}

interface ChangelogSection {
  name: string
  body: string
  entries: string[]
}

interface ChangelogRelease {
  /** The `## ` heading text: `Unreleased`, or e.g. `1.0.0 - 2026-09-06`. */
  heading: string
  sections: ChangelogSection[]
}

/**
 * Parsing per-release rather than over the whole document is load-bearing once tags exist: a full
 * run emits one block per release, so `### Features` legitimately appears many times and a
 * first-occurrence scan would read one release's sections believing it had the whole file. Ordering
 * is therefore only ever asserted WITHIN a block.
 */
function parseReleases(output: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let release: ChangelogRelease | undefined
  let section: ChangelogSection | undefined

  for (const line of output.split('\n')) {
    const releaseHeading = /^## +(.+?) *$/.exec(line)
    if (releaseHeading) {
      release = { heading: releaseHeading[1], sections: [] }
      releases.push(release)
      section = undefined
      continue
    }

    const sectionHeading = /^### +(.+?) *$/.exec(line)
    if (sectionHeading && release) {
      section = { name: sectionHeading[1], body: '', entries: [] }
      release.sections.push(section)
      continue
    }

    if (section) {
      section.body += `${line}\n`
      if (line.startsWith('- ')) section.entries.push(line)
    }
  }

  return releases
}

/**
 * A subsequence of `SECTION_ORDER`, not the whole of it: a section being absent altogether is fine,
 * since a small enough range can legitimately have zero `feat:` commits. A rendered heading with no
 * entries under it is not.
 */
function assertSectionsWellFormed(release: ChangelogRelease): void {
  let previousRank = -1
  for (const section of release.sections) {
    const rank = SECTION_ORDER.indexOf(section.name)
    assert.notEqual(
      rank,
      -1,
      `unexpected section "### ${section.name}" under "## ${release.heading}" — expected one of ${SECTION_ORDER.join('/')}`
    )
    assert.ok(
      rank > previousRank,
      `expected "### ${section.name}" to appear after the previous section under "## ${release.heading}", but sections came out as ${release.sections.map((s) => s.name).join(' -> ')}`
    )
    previousRank = rank

    assert.ok(
      section.entries.length > 0,
      `expected "### ${section.name}" under "## ${release.heading}" to have at least one entry`
    )
  }
}

describe('changelog generator (cliff.toml)', () => {
  test('config file exists at the repo root', () => {
    assert.ok(fs.existsSync(CLIFF_CONFIG), `expected ${CLIFF_CONFIG} to exist`)
  })

  describe('generation against real repo history', { skip: !hasGitCliff() }, () => {
    // Populated once: git-cliff and `git log` over the whole repo history are too slow per test.
    let releases: ChangelogRelease[]
    let unreleasedOutput = ''
    let subjectByHash: Map<string, string>

    before(() => {
      releases = parseReleases(runGitCliff(REPO_ROOT))
      unreleasedOutput = runGitCliff(REPO_ROOT, '--unreleased')

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

    test('renders at least one release block carrying categorized entries', () => {
      assert.ok(releases.length > 0, 'expected at least one "## " release block in the output')
      const entries = releases.flatMap((r) => r.sections.flatMap((s) => s.entries))
      assert.ok(
        entries.length > 0,
        `expected the full history to yield at least one categorized entry across ${releases.length} release block(s)`
      )
    })

    test('orders the sections within each release block, and leaves none of them empty', () => {
      for (const release of releases) assertSectionsWellFormed(release)
    })

    test('every entry references its commit via a short-hash link', () => {
      for (const release of releases) {
        for (const section of release.sections) {
          for (const entry of section.entries) {
            assert.match(
              entry,
              COMMIT_LINK_PATTERN,
              `expected the entry ${JSON.stringify(entry)} under "### ${section.name}" to end in a short-hash commit link`
            )
          }
        }
      }
    })

    test("categorizes this repo's real commits correctly, cross-checked against git log rather than hardcoded", () => {
      let checked = 0

      for (const release of releases) {
        for (const section of release.sections) {
          for (const entry of section.entries) {
            const hash = COMMIT_LINK_PATTERN.exec(entry)?.[1]
            assert.ok(hash, `expected a commit hash in the entry ${JSON.stringify(entry)}`)

            const subject = subjectByHash.get(hash)
            assert.ok(
              subject !== undefined,
              `expected commit ${hash}, referenced under "### ${section.name}", to be real (found via git log)`
            )
            checked += 1

            const expected = EXPECTED_TYPE_PREFIX[section.name]
            if (expected) {
              assert.match(
                subject,
                expected,
                `expected commit ${hash} ("${subject}") under "### ${section.name}" to actually be a ${section.name} commit`
              )
            } else {
              for (const [otherName, pattern] of Object.entries(EXPECTED_TYPE_PREFIX)) {
                assert.ok(
                  !pattern.test(subject),
                  `expected commit ${hash} ("${subject}") under "### Chores" not to actually be a ${otherName} commit`
                )
              }
            }
          }
        }
      }

      assert.ok(checked > 0, 'expected to have cross-checked at least one entry against git log')
    })

    test('--unreleased renders cleanly, tolerating a window a release tag has emptied', () => {
      // Deliberately weak: a tag at HEAD leaves this range legitimately empty (`render_always =
      // true` still emits the heading), so anything stronger would fail on a correct config.
      const unreleased = parseReleases(unreleasedOutput)
      assert.deepEqual(
        unreleased.map((r) => r.heading),
        ['Unreleased'],
        'expected --unreleased to render exactly one "## Unreleased" block'
      )
      assertSectionsWellFormed(unreleased[0])
    })
  })

  describe('generation against a synthetic fixture repo', { skip: !hasGitCliff() }, () => {
    interface FixtureCommit {
      message: string
      /** The section this commit must land in, or `null` if it must be dropped entirely. */
      section: string | null
      hash: string
    }

    interface Fixture {
      dir: string
      commits: FixtureCommit[]
      cliff: (...args: string[]) => string
      cleanup: () => void
    }

    const FIXTURE_COMMITS: { message: string; section: string | null }[] = [
      { message: 'feat: add the first thing', section: 'Features' },
      { message: 'feat(editor)!: change a thing incompatibly', section: 'Features' },
      { message: 'fix: correct the thing', section: 'Bug Fixes' },
      { message: 'refactor: restructure the thing', section: 'Refactors' },
      { message: 'chore: tidy the thing', section: 'Chores' },
      // This repo's history is inconsistent about casing, which is why cliff.toml matches `(?i)`.
      { message: 'Fix: correct the capitalized thing', section: 'Bug Fixes' },
      // Ad-hoc types this repo uses that no conventional-commit spec enumerates.
      { message: 'audit: note an ad-hoc thing', section: 'Chores' },
      { message: 'polish: smooth a rough edge', section: 'Chores' },
      // This repo's own squash-merge commit shape, PR-number suffix and all.
      { message: 'Cycle: graph layout and assorted fixes (#46)', section: 'Chores' },
      // `filter_unconventional` must drop this rather than render it uncategorized.
      { message: 'Update README.md', section: null }
    ]

    function createFixtureRepo({
      tagAtHead,
      afterTag = []
    }: { tagAtHead?: string; afterTag?: string[] } = {}): Fixture {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-changelog-fixture-'))

      // Hermetic on purpose: an ambient `init.defaultBranch`, `commit.gpgsign` or `core.hooksPath`
      // from the machine's own git config would otherwise change what this fixture produces.
      const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8', env })

      git('init', '-q', '--initial-branch=main', '.')
      git('config', 'user.email', 'fixture@example.com')
      git('config', 'user.name', 'Changelog Fixture')

      let counter = 0
      const commit = (message: string): string => {
        // Each commit needs a real change, or `git commit` refuses it as empty.
        fs.writeFileSync(path.join(dir, 'file.txt'), String(counter++))
        git('add', '-A')
        git('commit', '-q', '-m', message)
        return git('rev-parse', 'HEAD').trim()
      }

      const commits: FixtureCommit[] = FIXTURE_COMMITS.map((c) => ({
        ...c,
        hash: commit(c.message)
      }))

      if (tagAtHead) git('tag', tagAtHead)
      for (const message of afterTag)
        commits.push({ message, section: 'Features', hash: commit(message) })

      return {
        dir,
        commits,
        cliff: (...args: string[]) => runGitCliff(dir, ...args),
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    function sectionByHash(output: string): Map<string, string> {
      const result = new Map<string, string>()
      for (const release of parseReleases(output)) {
        for (const section of release.sections) {
          for (const entry of section.entries) {
            const hash = COMMIT_LINK_PATTERN.exec(entry)?.[1]
            if (hash) result.set(hash, section.name)
          }
        }
      }
      return result
    }

    let fixture: Fixture

    before(() => {
      fixture = createFixtureRepo()
    })

    after(() => {
      fixture?.cleanup()
    })

    test('categorizes every commit shape into its documented section', () => {
      const actual = sectionByHash(fixture.cliff())

      const expected = new Map(
        fixture.commits.filter((c) => c.section !== null).map((c) => [c.hash, c.section as string])
      )

      // Compared as whole maps rather than per-commit, so a commit git-cliff silently dropped fails
      // as loudly as a miscategorized one.
      assert.deepEqual(
        Object.fromEntries(
          [...actual].map(([hash, section]) => [
            `${section} <- ${fixture.commits.find((c) => c.hash === hash)?.message ?? hash}`,
            section
          ])
        ),
        Object.fromEntries(
          [...expected].map(([hash, section]) => [
            `${section} <- ${fixture.commits.find((c) => c.hash === hash)?.message ?? hash}`,
            section
          ])
        )
      )
    })

    test('drops a commit that is not conventional-shaped at all', () => {
      const rendered = sectionByHash(fixture.cliff())
      for (const { message, section, hash } of fixture.commits) {
        if (section !== null) continue
        assert.equal(
          rendered.get(hash),
          undefined,
          `expected the non-conventional commit ${JSON.stringify(message)} to be dropped, but it rendered under "### ${rendered.get(hash)}"`
        )
      }
    })

    test('orders the fixture sections and leaves none of them empty', () => {
      const releases = parseReleases(fixture.cliff())
      assert.deepEqual(
        releases.map((r) => r.heading),
        ['Unreleased']
      )
      assert.deepEqual(
        releases[0].sections.map((s) => s.name),
        SECTION_ORDER
      )
      assertSectionsWellFormed(releases[0])
    })

    test('links a trailing PR-number suffix at the pull request, not at /pull/#N', () => {
      const output = fixture.cliff()
      assert.match(
        output,
        /\(\[#46\]\(https:\/\/github\.com\/requarks\/wiki\/pull\/46\)\)/,
        'expected the `(#46)` suffix to render as a link to /pull/46'
      )
      assert.doesNotMatch(
        output,
        /\/pull\/#/,
        'expected no `/pull/#N` links — that URL 404s (the capture group must exclude the `#`)'
      )
    })

    describe('once a release tag lands', () => {
      let tagged: Fixture
      let taggedThenCommitted: Fixture

      before(() => {
        tagged = createFixtureRepo({ tagAtHead: 'v1.0.0' })
        taggedThenCommitted = createFixtureRepo({
          tagAtHead: 'v1.0.0',
          afterTag: ['feat: add something after the tag']
        })
      })

      after(() => {
        tagged?.cleanup()
        taggedThenCommitted?.cleanup()
      })

      test('--unreleased renders an empty window cleanly rather than failing', () => {
        // With the tag at HEAD nothing is unreleased and `render_always = true` emits the heading
        // alone — every assertion this suite makes about `--unreleased` has to survive that.
        const releases = parseReleases(tagged.cliff('--unreleased'))
        assert.deepEqual(
          releases.map((r) => r.heading),
          ['Unreleased']
        )
        assert.deepEqual(releases[0].sections, [])
        assertSectionsWellFormed(releases[0])
      })

      test('still categorizes the tagged release when run over full history', () => {
        const releases = parseReleases(tagged.cliff())
        // Asymmetric with `--unreleased` above: a FULL run omits an empty Unreleased block
        // altogether, whereas `--unreleased` renders the bare heading. Neither implies the other.
        assert.deepEqual(
          releases.map((r) => r.heading.replace(/ - \d{4}-\d{2}-\d{2}$/, '')),
          ['1.0.0']
        )
        assert.deepEqual(
          releases[0].sections.map((s) => s.name),
          SECTION_ORDER
        )
        assertSectionsWellFormed(releases[0])
      })

      test('puts a post-tag commit under Unreleased, above the tagged release', () => {
        const releases = parseReleases(taggedThenCommitted.cliff())
        assert.deepEqual(
          releases.map((r) => r.heading.replace(/ - \d{4}-\d{2}-\d{2}$/, '')),
          ['Unreleased', '1.0.0']
        )
        assert.deepEqual(
          releases[0].sections.map((s) => s.name),
          ['Features']
        )
        assert.equal(releases[0].sections[0].entries.length, 1)

        const postTag = taggedThenCommitted.commits.at(-1)
        assert.equal(
          sectionByHash(taggedThenCommitted.cliff()).get(postTag?.hash as string),
          'Features'
        )
      })
    })
  })
})
