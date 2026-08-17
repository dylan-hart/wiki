# Variances

Genuine, justified deviations from spec. An entry is removed once resolved — this file is not a
changelog.

## Pre-existing oxfmt debt excluded from the CI format gate (task 766, feature 423)

`npx oxfmt --check backend frontend blocks` was added as a required CI step in
`.github/workflows/quality.yml`. Run cold against the tree at the time, it failed on 48 files that
predate the gate and were not touched by task 766 — 44 genuine formatting debt (mostly `frontend/`
components/boot files never run through oxfmt, plus a handful in `backend/` and `blocks/`), and 4
that should simply never be formatted (two `frontend/src/assets/*.generated.js` build outputs, two
vendored font stylesheets under `frontend/public/_assets/fonts/`).

The 4 generated/vendored files are excluded permanently via `.oxfmtrc.json`'s `ignorePatterns`,
alongside the project's existing build-output/vendored-asset entries.

The other 44 are listed in a root `.prettierignore` (oxfmt's default ignore-file discovery picks
this up the same way Prettier would) as a dated debt snapshot, not a permanent exclusion. This
follows the project's own convention, documented in `CLAUDE.md`'s Style section, against bulk
reformatting untouched files as a drive-by: a task whose scope is "add a build.yml gate step" is
not license to rewrite the bytes of 44 unrelated files in one commit. Each entry should be dropped
from `.prettierignore` the next time that file is genuinely touched (reformat it as part of that
change) or by a small dedicated cleanup task that reformats them on their own, reviewable, with
nothing else riding along.

Resolution: land a follow-up task that runs `oxfmt` (write mode) once over the listed paths, diffs
reviewed on their own, then deletes `.prettierignore` (or the entries it no longer needs).

## blocks/ oxlint pinned to backend's version, not a literal shared pin (task 769, feature 423)

Task 769 called for pinning `blocks/`'s new `oxlint` devDependency "at the same version pinned in
backend/package.json and frontend/package.json", assuming the two already agreed. They don't:
backend has `oxlint: 1.77.0`, frontend has `oxlint: 1.76.0` — a pre-existing one-patch drift between
the two workspaces, not something introduced here. `blocks/package.json` was pinned to `1.77.0`,
matching backend, consistent with the precedent already established for `oxfmt` in
`.github/workflows/quality.yml` (backend's install treated as the canonical one for repo-wide
tooling versions; see that file's "Format Check" step comment). Resolution: a follow-up task should
reconcile `frontend/package.json`'s `oxlint` pin up to `1.77.0` so all three workspaces genuinely
share one version, then this entry can be deleted.
