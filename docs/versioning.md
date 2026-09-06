# Versioning and tagging scheme

This document defines, precisely, what version number a build gets and what Docker/artifact tags
it produces. There are exactly two channels: the **continuous alpha channel** (every push to
`scarlett`, fully automatic) and the **release channel** (a deliberate, human-triggered git tag).
If you are asking "what version does this build get", find your channel below and stop — there is
no third case.

## Precedent: how upstream 2.5.x did it

Upstream `requarks/wiki` has shipped every 2.5.x build under a plain semver tag —
`v2.5.300`, `v2.5.301`, ... `v2.5.314`, and onward — pushed by a maintainer, each producing a
GitHub Release with categorized notes (New Features / Bug Fixes / Refactors / Chores) and a Docker
image. Notably, upstream has not bumped _minor_ or _major_ in years: every 2.5.x release only ever
increments the patch number, because there has been no upstream event large enough to justify a
minor bump and no breaking change large enough to justify a major one. That's the same shape this
fork inherits — a single active line, patch-incremented by default, with minor/major reserved for
events that actually happened rather than incremented for their own sake. The scheme below is a
continuation of that convention, not a new invention: same tag shape (`vX.Y.Z`, `git tag` pushed by
a maintainer, GitHub Release with categorized notes), continued from `3.0.0` instead of restarting
at `1.0.0`, because this fork has no upstream release cadence of its own to inherit numbers from.

## Channel 1: continuous alpha (unchanged)

**Trigger:** every push to `scarlett`. Fully automatic, no gate, no human action.

`.github/workflows/build.yml` already does this correctly and this document does not change it:

```yaml
REL_VERSION=3.0.0-alpha.$GITHUB_RUN_NUMBER
```

- `backend/package.json` and `frontend/package.json` get `version` rewritten to that string for
  the duration of the build (not committed back to the repo — it's a build-time-only stamp).
- The Docker image is pushed under **two** tags, in this fork's own GHCR namespace
  (`ghcr.io/${{ github.repository }}` — `docker/login-action` authenticates as
  `github.repository_owner` with the run's `GITHUB_TOKEN`, whose `packages:write` scope only covers
  that owner's packages, so the namespace is derived rather than hard-coded):
  - `ghcr.io/dylan-hart/wiki:3.0.0-alpha.<run_number>` — an immutable, uniquely-addressable build.
  - `ghcr.io/dylan-hart/wiki:3.0.0-alpha` — a floating tag that always points at the most recent
    alpha push. This is what "latest dev build" means on this fork; nobody should point production
    infrastructure at it.
- `<run_number>` is `$GITHUB_RUN_NUMBER`: a per-workflow, monotonically increasing integer supplied
  by GitHub Actions. It has no relationship to commit count, PR number, or calendar time — it is
  just "the Nth time this workflow has run in this repo."
- `3.0.0` is a placeholder base version. It does not track real feature progress and is not read by
  anything downstream; it exists only so the alpha string is valid semver pre-release syntax. It
  stays `3.0.0` even after a real `3.1.0` release ships, until 3.x's own alpha stream is
  deliberately rebased forward (see [Open question](#open-question-rebasing-the-alpha-base) below).
- `:latest` is **never** touched by this channel. An alpha push must never become what
  `docker pull ghcr.io/dylan-hart/wiki:latest` resolves to.

Nothing above requires a decision or a checklist — it is the existing, correct behavior, called
out here so this document is a complete answer to "what version does this build get" for both
channels, and so a future edit to `build.yml` has something explicit to stay consistent with.

## Channel 2: real releases

**Trigger:** a maintainer pushes a git tag of the shape `vX.Y.Z` (optionally with a pre-release
suffix — see below) **after** the pre-release checklist (companion document, see
[Pre-release checklist](#see-also)) has passed. A release is never implied by a commit, a merge, or
a passing CI run on `scarlett` — those only ever produce channel-1 alpha builds. The tag push is
the one and only action that starts a release build.

### Version format

Standard [semver](https://semver.org/): `MAJOR.MINOR.PATCH[-PRERELEASE]`, tagged in git as
`vMAJOR.MINOR.PATCH[-PRERELEASE]` (matching upstream's `v`-prefixed convention).

| Tag pushed    | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `v3.0.0-rc.1` | Release candidate 1 for `3.0.0`. Pre-release: not "stable".         |
| `v3.0.0-rc.2` | A further RC after fixes, still gated by the same checklist.        |
| `v3.0.0`      | The first stable 3.0 release.                                       |
| `v3.0.1`      | A bugfix-only patch release on top of `3.0.0`.                      |
| `v3.1.0`      | A minor release: a new epic's feature-parity milestone landed.      |
| `v4.0.0`      | A major release: a genuinely breaking schema/config change shipped. |

Release candidates (`-rc.N`) are optional and used at a maintainer's discretion — typically for a
major or minor release where a soak period is wanted before calling it stable, not required for
every release. A patch release normally goes straight to `vX.Y.Z` with no RC stage.

### What bumps which number

This fork has no upstream release cadence of its own to defer to, so the rule is tied to what
actually happened in the repo, mirroring how upstream's own 2.5.x line has behaved in practice
(patch by default; minor/major only for events that earn it):

- **Patch (`Z`)** — a release containing only bugfixes, dependency bumps, or other changes with no
  new user-facing capability. No feature epic's scope landed since the last release.
- **Minor (`Y`)** — a release where at least one epic's feature-parity milestone (as tracked in
  OpenProject: an Epic reaching its "done" definition, or a Feature under it landing that the
  release manager judges user-visible and complete) landed since the last release. Resets `Z` to 0.
- **Major (`X`)** — reserved for a genuinely breaking schema or config change: something an
  operator cannot silently no-op through. Given this codebase's stance in the root `CLAUDE.md`
  ("change the shape, change the callers, and delete the old path" — no migration shims, no
  legacy-value fallbacks, no deprecated aliases), a schema or config change here is _by
  construction_ breaking the moment it ships, because the code deliberately does not carry
  backward-compatible fallbacks for the old shape. A major bump is the version-number signal that
  such a change occurred; it is not a statement about how large the diff was. Resets `Y` and `Z`
  to 0.

  This also means major-vs-minor cannot be decided by diff size or PR count — a one-line change to
  `db/schema.ts` that drops a column is a major-bump event; a large but purely additive feature
  epic is a minor-bump event even if it touches far more files.

Concretely: 3.0.0 is this fork's inaugural stable release once the epics under active development
(Stabilization/QA/Release Readiness, and whatever else is targeted for "3.0 done") reach their done
definition. After that, `3.0.x` patch releases absorb bugfixes; the next epic's milestone landing
ships as `3.1.0`; a breaking schema change (should one become necessary) ships as the next major.

### Docker tags on a release

`.github/workflows/release.yml` is that workflow: it triggers only on the `vX.Y.Z` tag push
described above, never on a `scarlett` push (that stays `build.yml`'s job, unchanged). Before it
pushes anything, it hard-gates on the same typecheck/lint/format/icon-drift/emoji-drift checks
Feature #423 wires into the continuous channel — every one of those steps must pass or the job
stops there: no Docker push, no GitHub Release. What it does **not** gate on: the full
backend/frontend/blocks/e2e test suites (`build.yml`'s own `build` job already ran those against
the commit a release tag points at) and Epic 13's migration-tooling dry run against a real 2.5.x
dataset. Both of those are **not CI-enforceable** here — no CI runner has a real 2.5.x dataset to
migrate, and re-running the full suite a second time on the same commit is not an independent
check — so they remain **manual sign-off** steps a release manager performs and records in the
release PR description, per `docs/release-checklist.md` items 2 and 5. `release.yml` carries this
same note as a code comment at its own top, so it's visible from either side.

It pushes:

- `ghcr.io/dylan-hart/wiki:<version>` — always, exactly matching the pushed tag with the leading `v`
  stripped (e.g. tag `v3.0.1` → image tag `3.0.1`; tag `v3.0.0-rc.1` → image tag `3.0.0-rc.1`).
- `ghcr.io/dylan-hart/wiki:latest` — **only** on a stable release (no pre-release suffix). Pushing
  `v3.0.0-rc.1` or any other `-rc.N`/`-alpha.N`/`-beta.N` tag must **never** move `:latest`.
  `:latest` always means "the newest stable release", full stop — never a candidate, never a dev
  build.

  | Tag pushed    | `:latest` rewritten? |
  | ------------- | :------------------: |
  | `v3.0.0-rc.1` |          No          |
  | `v3.0.0`      |         Yes          |
  | `v3.0.1`      |         Yes          |
  | `v3.1.0-rc.1` |          No          |
  | `v3.1.0`      |         Yes          |

- `backend/package.json` and `frontend/package.json` `version` fields are stamped to the
  tag-derived version (`v` stripped) for that build, the same mechanism channel 1 already uses.

### What a release is _not_

- Not every commit, not every merge to `scarlett`, not every green CI run. Those all continue to
  produce only channel-1 alpha builds, unchanged by anything in this document.
- Not automatic. There is no "N alphas since last release, cut one automatically" rule. A human
  decides an epic's milestone is done, runs the pre-release checklist, and pushes the tag.
- Not retroactive. A release tag is pushed against a specific commit on `scarlett` (or a release
  branch, if one is ever cut for a patch series); it does not get moved after the fact. If a
  release build is wrong, the fix ships as a new patch release, not a re-tag.

## Open question: rebasing the alpha base

The alpha channel's `3.0.0-alpha.<run_number>` base version does not currently advance when a real
`3.x` release ships (e.g. after `v3.1.0`, the very next `scarlett` push still stamps
`3.0.0-alpha.<n+1>`, not `3.1.0-alpha.<n+1>`). Whether to keep the alpha base static forever, or to
rebase it to track the most recent release's `MAJOR.MINOR` going forward, is left as an explicit
open decision for whoever implements the workflow split (companion task under this Feature) —
not resolved here, and not something CI should infer on its own from the latest git tag without a
maintainer decision, since that would silently change what an alpha version number means.

## Generating a changelog

Commit history is written as [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `ci:`, ...) throughout this fork's own history, and
[git-cliff](https://git-cliff.org/) — a single static binary, no npm dependency in any of the
three workspaces — turns that into a categorized changelog. Its config lives at the repo root,
`cliff.toml`.

**Install** (once, on a release manager's machine — this is a dev-machine tool, not something CI or
either app workspace depends on):

```sh
brew install git-cliff       # macOS
# or download a prebuilt binary from https://github.com/orhun/git-cliff/releases
```

**Run**, from the repo root:

```sh
git-cliff --unreleased                       # preview: commits since the last vX.Y.Z tag
git-cliff --unreleased --tag v3.0.0           # preview, labeling the range as the upcoming v3.0.0
git-cliff -o CHANGELOG.md                     # write the full changelog (every tagged release + unreleased)
```

`cliff.toml` groups commits into four sections, in this order, mirroring upstream 2.5.x's GitHub
Release convention (New Features / Bug Fixes / Refactors / Chores):

| Group         | Conventional Commit types                                                   |
| ------------- | --------------------------------------------------------------------------- |
| **Features**  | `feat` (case-insensitive)                                                   |
| **Bug Fixes** | `fix` (case-insensitive)                                                    |
| **Refactors** | `refactor` (case-insensitive)                                               |
| **Chores**    | everything else that parses as `type[(scope)]: description` — the catch-all |

Chores is a catch-all rather than an enumerated list on purpose: `docs`, `ci`, `chore`, `test`,
`style`, `build`, this repo's `misc`/`mics`/`dev` types, its own ad-hoc annotations (`audit:`,
`polish:`, ...) and its `Cycle: ...` squash-merge commits all land there. An earlier, enumerated
version of this list silently dropped any type it didn't name — the exact failure OpenProject
#2567 tracked, where a squash-merged commit could disappear from the changelog with a "grouping
error" instead of being categorized.

Each entry links to its commit, and a trailing `(#123)` PR-number suffix additionally becomes a
link to that pull request. A commit that doesn't parse as `type[(scope)]: description` at all
(pre-fork upstream history has plenty — plain "Update README.md", merge commits) is dropped rather
than shown unclassified.

`backend/test/changelog.test.ts` guards all of the above from two directions (OpenProject #2567),
and hardcodes no commit subject or hash in either:

- **Against this repo's real history** — it asserts whichever sections come out are in the
  documented order and non-empty, and cross-checks each entry's commit hash against `git log`'s
  real subject line to confirm it landed in the section its actual type says it should. It runs
  git-cliff over the **full** history rather than `--unreleased`, because `--unreleased` is exactly
  the window a release tag can empty out; `--unreleased` gets its own test making only the narrow
  claim that it renders cleanly, which stays true when the range is empty.
- **Against a synthetic fixture repo** — a throwaway repo with a known commit set, which is the
  only way to pin the specific shapes that motivated #2567 (a `Cycle: ...` squash-merge commit, a
  capitalized `Fix:`, ad-hoc `audit:`/`polish:` types) without waiting for one to organically turn
  up in range, and the only way to exercise the tagged-release cases at all while this repo has no
  tags. Revert the Chores catch-all and it reproduces the original bug verbatim — "3 commit(s) were
  skipped due to grouping error(s)", naming which commits vanished.

The suite is gated on the `git-cliff` binary being installed and skips cleanly without it, the same
way the DB-backed model suites gate on `DATABASE_URL`.

Since no `vX.Y.Z` tag has been pushed yet (see [Channel 2](#channel-2-real-releases) above),
`--unreleased` today walks the _entire_ history rather than "since the last release" — there is no
last release. That resolves itself the moment the first tag is pushed; nothing about the config
needs to change. `.github/workflows/release.yml` now wires this in automatically: on a tag push it
computes the range since the previous `vX.Y.Z` tag (or the whole history, on the first release) and
uses the generated changelog as the GitHub Release body — this document's "run it by hand" commands
above stay the way to preview that output before pushing the tag.

## See also

- **[`docs/release-checklist.md`](release-checklist.md)** — the concrete gate that must pass
  before a maintainer is allowed to push a release tag: CI quality gates green, test suites green,
  `docs/variances.md` current, and the Epic 13 migration tooling run end-to-end against a real
  2.5.x dataset with human sign-off.
- **[`RELEASING.md`](../RELEASING.md)** — the release-manager runbook: the actual step-by-step
  commands to cut a release once the checklist has passed.
- `.github/workflows/build.yml` — the continuous alpha channel, unchanged by the workflow split.
- `.github/workflows/release.yml` — the release channel described in this document: the `vX.Y.Z`
  tag trigger, the hard-required quality gate, the semver + `:latest` Docker tags, and the
  changelog-driven GitHub Release. Its own top-of-file comment carries the same note as above about
  what it does and does not gate on.
