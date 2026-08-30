# Releasing

The release-manager runbook: the exact steps to cut a real `vX.Y.Z` release once a maintainer has
decided the tree is ready. This file is procedural only — it links to the documents that define
_what_ each step means rather than restating them. Read those first if a step here is unclear:

- [`docs/release-checklist.md`](docs/release-checklist.md) — the go/no-go gate, including the
  manual sign-offs, that must pass **before** step 1 below.
- [`docs/versioning.md`](docs/versioning.md) — what version number to pick, the two build
  channels, the changelog generator, and the Docker tag rules.
- [`cliff.toml`](cliff.toml) — the changelog generator config used in step 2.
- [`.github/workflows/release.yml`](.github/workflows/release.yml) — the workflow the tag push in
  step 3 triggers. Everything it does is described there and in `docs/versioning.md`; this file
  only tells you when to push the tag and what to check once it's done.

## 1. Confirm the checklist is satisfied

Work through [`docs/release-checklist.md`](docs/release-checklist.md) against the exact commit on
`scarlett` you intend to release, including its manual sign-off items (test suites,
`docs/variances.md`, the Epic 13 migration dry-run — whichever are currently enforceable). Do not
proceed to step 2 on a partially-filled checklist. Keep the filled-in checklist text; it gets
pasted into the release announcement in step 6.

## 2. Decide the version

Pick `MAJOR.MINOR.PATCH` per [`docs/versioning.md`](docs/versioning.md#what-bumps-which-number).
Set it as a shell variable for the rest of this runbook:

```sh
VERSION=3.1.0          # no leading "v" — added by the tag commands below
```

Add `-rc.N` to `VERSION` instead if this is a release candidate
(`docs/versioning.md#version-format`).

## 3. Preview the changelog before tagging

Run the same generator `release.yml` will run, against the same config, so you see the release
notes before they're public:

```sh
git-cliff --unreleased --tag "v$VERSION"
```

Read the output. If a commit landed in the wrong section, or an entry reads badly, fix the
underlying commit message convention for next time — do not hand-edit `cliff.toml`'s grouping
rules per release. This is a sanity check, not a step that writes any file; `release.yml` runs the
real generation itself once the tag is pushed.

## 4. Tag and push

This is the action that starts the release build — nothing before this step is visible to CI.

```sh
git tag -a "v$VERSION" -m "Release v$VERSION"
git push origin "v$VERSION"
```

Pushing the tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml): it
re-runs the quality gates, builds and pushes the Docker image, and creates the GitHub Release.

## 5. Watch the workflow run

Open the **Actions** tab for the `Release` workflow run against the tag you just pushed. If any
step fails, the tag has already been pushed but nothing downstream (Docker push, GitHub Release)
happened — per `docs/versioning.md`, a release is never retroactively fixed by moving the tag.
Delete the tag (`git push --delete origin "v$VERSION"` and `git tag -d "v$VERSION"`), fix the
underlying problem, and restart from step 1 against a new commit.

## 6. Verify the resulting artifacts

Once the workflow finishes green:

- **GitHub Release** — open the repo's Releases page and confirm a release named `v$VERSION`
  exists, is marked "pre-release" if and only if `VERSION` contains `-rc.`/`-alpha.`/`-beta.`, and
  its body is the categorized changelog (Features / Bug Fixes / Refactors / Chores) — not empty,
  not raw commit list.
- **Docker tags** — confirm both expected tags resolve:

  ```sh
  docker pull ghcr.io/dylan-hart/wiki:$VERSION
  ```

  and, only if this was a stable (non-`-rc.`/`-alpha.`/`-beta.`) release, also confirm `:latest`
  now points at the same digest:

  ```sh
  docker pull ghcr.io/dylan-hart/wiki:latest
  docker inspect --format '{{.Id}}' ghcr.io/dylan-hart/wiki:$VERSION ghcr.io/dylan-hart/wiki:latest
  ```

  The two `Id` values must match. If this was a release candidate, confirm the opposite: `:latest`
  did **not** move (compare its digest against the previous stable release).

## 7. Communicate the release

- Paste the filled-in checklist from step 1 into the release PR description or the GitHub Release
  itself, so the go/no-go reasoning is on the record (`docs/release-checklist.md`, "How to use
  this checklist", step 5).
- Post the GitHub Release link wherever the team/users watch for releases.
- If this was a release candidate, say explicitly that it's a candidate and what feedback window
  you're waiting on before promoting it to stable.
