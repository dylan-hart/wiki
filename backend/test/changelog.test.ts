/**
 * Confirms the repo-root `cliff.toml` (git-cliff config, see docs/versioning.md) actually produces
 * a sane, categorized changelog — not just that the file parses.
 *
 * git-cliff is a standalone binary (not an npm dependency of any workspace, per CLAUDE.md's
 * currency/dependency stance for this task), so it is not guaranteed to be on PATH in every dev or
 * CI environment. Gated on its presence exactly like the DB-backed model suites gate on
 * `hasTestDatabase()` (see `./db.ts`) — skip the whole `describe` when the tool isn't installed
 * rather than failing the run.
 *
 * Two describes, because the two things worth proving have opposite requirements (OpenProject
 * #2567):
 *
 *  - **Against real repo history** — the smoke test that the config works on the actual corpus it
 *    ships for. It hardcodes no commit subject and no hash: it cross-references whatever the
 *    output currently contains against this repo's own `git log`. Crucially it runs git-cliff over
 *    the FULL history rather than `--unreleased`, because `--unreleased` is by definition the one
 *    window a release tag can empty out — the first `vX.Y.Z` tag landing at HEAD renders
 *    `## Unreleased` with zero sections and zero entries, which would fail every content
 *    assertion here for no code defect at all. Full history only ever grows, so it is a stable
 *    corpus whatever the tag situation is. `--unreleased` still gets its own test, but only for
 *    the narrow claim that it renders cleanly, explicitly tolerating an empty window.
 *
 *  - **Against a synthetic fixture repo** — a throwaway git repo with a known commit set, which is
 *    the only way to pin the specific shapes that motivated #2567 (a `Cycle: ...` squash-merge
 *    commit, a capitalized `Fix:`, an ad-hoc `audit:` type) and the only way to exercise the
 *    tagged-release cases at all, since this repo has no tags yet. Deterministic, so it asserts on
 *    exact categorization rather than general shape.
 *
 * Between them: the real-history describe catches "the config broke against our actual commits",
 * and the fixture describe catches "the config broke for a commit shape we care about" without
 * waiting for such a commit to organically show up in `--unreleased`.
 */
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

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
  /\(\[[0-9a-f]{7}\]\(https:\/\/github\.com\/requarks\/wiki\/commit\/([0-9a-f]{40})\)\)/

/** Whether the git-cliff binary is available to run these suites. */
function hasGitCliff(): boolean {
  try {
    execFileSync('git-cliff', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Runs the real `cliff.toml` against whichever repo `cwd` points at. */
function runGitCliff(cwd: string, ...args: string[]): string {
  return execFileSync('git-cliff', ['--config', CLIFF_CONFIG, ...args], {
    cwd,
    encoding: 'utf8'
  })
}

interface ChangelogSection {
  name: string
  /** Everything between this section's heading and the next heading (or EOF). */
  body: string
  /** Just the entry lines — one per rendered commit. */
  entries: string[]
}

interface ChangelogRelease {
  /** The `## ` heading text: `Unreleased`, or e.g. `1.0.0 - 2026-09-06`. */
  heading: string
  sections: ChangelogSection[]
}

/**
 * Splits a git-cliff run into its `## <release>` blocks, each carrying the `### <section>`
 * headings found inside it, in the order they appear.
 *
 * Parsing per-release rather than over the whole document is load-bearing once tags exist: a full
 * run emits one block per release, so `### Features` legitimately appears many times and any
 * first-occurrence-only scan (`indexOf`) would silently read one release's sections while
 * believing it had the whole file. Ordering is therefore only ever asserted WITHIN a block.
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
 * Asserts one release block's sections are a subsequence of `SECTION_ORDER` (so whichever ones are
 * present are in the documented order) and that none of them rendered a heading with no entries
 * under it. A section being altogether absent is fine — a small enough range can legitimately have
 * zero `feat:` commits.
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
    // Populated once, shared by every test below, rather than re-running git-cliff (and `git log`)
    // over the whole repo history — thousands of commits — for each test individually.
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
              // Chores is the catch-all: assert it's none of the three specifically-typed
              // sections, rather than asserting it matches some positive "chore-shaped" pattern.
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
      // The claim here is deliberately weak, and that is the point: once a `vX.Y.Z` tag lands at
      // HEAD this range is legitimately empty (`render_always = true` still emits the heading), so
      // anything stronger would fail on a correct config. Categorization is proven above, against
      // full history, where a tag cannot take the corpus away.
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

    // One commit per shape worth pinning. The last four are the ones that actually motivated
    // OpenProject #2567: before cliff.toml's Chores catch-all, an enumerated whitelist dropped
    // each of them with a "grouping error" instead of categorizing it.
    const FIXTURE_COMMITS: { message: string; section: string | null }[] = [
      { message: 'feat: add the first thing', section: 'Features' },
      { message: 'feat(editor)!: change a thing incompatibly', section: 'Features' },
      { message: 'fix: correct the thing', section: 'Bug Fixes' },
      { message: 'refactor: restructure the thing', section: 'Refactors' },
      { message: 'chore: tidy the thing', section: 'Chores' },
      // Capitalized type — this fork's history is not consistent about casing, which is why
      // cliff.toml matches feat/fix/refactor with `(?i)`.
      { message: 'Fix: correct the capitalized thing', section: 'Bug Fixes' },
      // Ad-hoc types this fork uses that no conventional-commit spec enumerates.
      { message: 'audit: note an ad-hoc thing', section: 'Chores' },
      { message: 'polish: smooth a rough edge', section: 'Chores' },
      // This fork's own squash-merge commit shape, PR-number suffix and all.
      { message: 'Cycle: graph layout and assorted fixes (#46)', section: 'Chores' },
      // Not conventional-shaped at all: `filter_unconventional` must drop it rather than render it
      // uncategorized. Pre-fork upstream history is full of these.
      { message: 'Update README.md', section: null }
    ]

    function createFixtureRepo({
      tagAtHead,
      afterTag = []
    }: { tagAtHead?: string; afterTag?: string[] } = {}): Fixture {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-changelog-fixture-'))

      // Hermetic on purpose: ignore the machine's own ~/.gitconfig and /etc/gitconfig entirely, so
      // an ambient `init.defaultBranch`, `commit.gpgsign` or `core.hooksPath` cannot change what
      // this fixture produces. This is the same class of ambient-git-config CI failure the git
      // storage sync suite hit (OpenProject #2586) — pin it rather than inherit it.
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

    /** Maps every rendered entry's commit hash to the section heading it landed under. */
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

      // Compared as whole maps rather than per-commit so a commit silently vanishing (the original
      // #2567 "skipped due to grouping error" failure) fails just as loudly as a miscategorized
      // one would.
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
        // The regression this whole work package exists to prevent: with the tag at HEAD there is
        // nothing unreleased, and `render_always = true` emits the heading alone. Every assertion
        // the suite makes about `--unreleased` has to survive exactly this.
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
        // Note the asymmetry with `--unreleased` above, confirmed against git-cliff 2.13: a FULL
        // run omits an empty Unreleased block altogether, whereas `--unreleased` renders the bare
        // heading (that is what `render_always = true` buys). Both are fine; the suite just must
        // not assume the same shape from both, which is precisely the kind of assumption that
        // made the pre-#2567 version of this file brittle.
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
