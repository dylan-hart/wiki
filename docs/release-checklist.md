# Pre-release checklist

This is the literal, step-by-step gate a release manager runs through before pushing a release
tag (see [`docs/versioning.md`](versioning.md#channel-2-real-releases) for what "release" means
and what triggers one — pushing a `vX.Y.Z` git tag is the **only** action that starts a release
build, and this checklist is what must be true before that push happens). It exists so that any
two people looking at the same commit reach the same go/no-go answer, without relying on tribal
knowledge of what "ready" means.

Every item below is either **CI-checkable** (a status you look up) or **manual** (a step a human
performs and records). Do not mark an item done from memory — for CI items, look at the actual run
for the commit being released; for manual items, do the step and write down what you found, not
what you expect to find.

Not every item below runs itself yet. Sibling Features under this same Feature
(#426, "Release readiness process and documentation") are what wire the CI-checkable items into
an actual gate on the release workflow, and most already have: see
[Status of automation](#status-of-automation) below for exactly what is enforced today versus what
this document still anticipates.

## How to use this checklist

1. Pick the commit on `scarlett` you intend to release.
2. Work through every item below in order, for that exact commit.
3. If every item is either ✅ Pass or ✅ N/A-with-reason (see [Item 2](#2-test-suites-all-green)),
   the release is a go: proceed to tag per `docs/versioning.md`.
4. If any item is ❌, the release is a no-go. Fix the underlying problem and re-run the checklist
   from the top against the new commit — do not carry forward a pass from an earlier commit.
5. Paste the filled-in checklist (with each item's Pass/Fail/N/A and any notes) into the release
   PR or release-tag announcement, so the go/no-go reasoning is on the record, not just the
   decision. See [Item 5](#5-epic-13-migration-tooling-exercised-end-to-end-with-sign-off) for
   where the migration sign-off specifically gets recorded.

## The checklist

### 1. CI quality gates green

**Owner: Feature #423 ("Stand up CI quality gates")** for the continuous alpha channel
(`build.yml`); **also enforced independently by `.github/workflows/release.yml`** (task #777) for
the release channel itself. #423 has since landed in `build.yml`: every `scarlett` push runs a
`quality` job (`.github/workflows/quality.yml`, shared with `pull_request`) that the `build` job
`needs:`, so a red typecheck/lint/format/drift result there stops the Docker publish the same way a
red `release.yml` run stops a release tag. `release.yml` still runs its own copy of the same checks
rather than depending on `build.yml`'s run for the exact commit a release tag points at — see that
workflow's own header comment for why. See [Status of automation](#status-of-automation).

For the release commit, confirm **all** of the following are green (read from the `release.yml`
run for the pushed tag; the `quality.yml` run against the same commit's `scarlett` push corroborates
it too):

- [ ] Backend `npm run typecheck` — must be green (zero errors).
- [ ] `oxlint` — must be green (zero warnings/errors) across all three workspaces
      (`backend/`, `frontend/`, `blocks/`).
- [ ] `oxfmt --check` — must be green (no unformatted files) across all three workspaces.
- [ ] Frontend `icons:check` and `emoji:check` — must be green (no drift between source and the
      generated `icons.generated.js` / emoji bundle).

A single red item here is an automatic no-go — do not release on a red CI run "because the
failure looks unrelated." Fix it, or get it fixed, and re-run.

### 2. Test suites all green

**Owner: Feature #424 ("Build test infrastructure from zero").** Re-running the suites themselves
is deliberately **not** a step in `release.yml` (task #777) even though they exist and run in CI
today: the release workflow's own top-of-file comment spells out why — `build.yml`'s `quality` job
already runs the backend/frontend/blocks suites and its `build` job already runs the e2e Playwright
suite against every `scarlett` push, including the commit a release tag points at, so re-running
them a second time on the tag push would be an expensive echo of a check that already ran, not an
independent gate.

**The existence of that run is now enforced, not just assumed (task #1943).** `release.yml`'s
first step, "Verify build.yml succeeded for this commit", fails the release job closed if
`gh run list --workflow=build.yml --commit=<tag SHA> --status=success` comes back empty — so a tag
pushed against a release branch, or against a `scarlett` commit whose push run was cancelled or
skipped, no longer reaches the Docker publish at all. That guard proves a green run exists; it does
not itself read which of the four suites below passed within that run — this item's manual read of
the actual `build.yml` run for the release commit, recorded in the release PR, is still required for
that level of detail, not a `release.yml` CI assertion.

**Enforceable today.** Feature #424 has landed on this branch: every workspace has a real test
suite wired into `build.yml` as a required step, run in this order, each one gating the steps after
it (a failure stops the job before the Docker build):

- [ ] Backend test suite (`backend/`, `npm run test` — `node --test`) — must be green.
- [ ] Frontend test suite (`frontend/`, `npm run test` — Vitest) — must be green.
- [ ] Blocks test suite (`blocks/`, `npm run test` — Vitest) — must be green.
- [ ] End-to-end smoke suite (`e2e/`, `npm test` — Playwright) — must be green.

For the release commit, read the `build.yml` run for that exact commit on `scarlett` (the commit
the release tag points at) and confirm all four "Run ... Tests" steps passed. Do not infer this
from a different commit's run, and do not mark this item Pass on the strength of "tests usually
pass" — look at the actual run.

Do not partially apply this item — e.g. treat "backend tests are green but the e2e suite was
skipped/cancelled" as a full Pass. A skipped or cancelled leg is a Fail for this item, named
specifically, not folded silently into a Pass.

**Degraded-mode fallback.** If a release is ever cut against a commit that predates Feature #424
landing (e.g. a hotfix branched from before test infrastructure existed), this item cannot be
evaluated and must be marked, explicitly, in the filled-in checklist:

> **N/A — no test suite exists on this commit (Feature #424 not present).**

recorded per [How to use this checklist](#how-to-use-this-checklist) step 5, not silently dropped
from the list — that is a real, visible fact about that release, not an absence that should read as
"nothing to see here."

### 3. `docs/variances.md` reviewed and current

**Owner: Feature #425 ("variances.md discipline").**

`docs/variances.md` is CLAUDE.md's home for genuine, justified deviations from spec — see the
root `CLAUDE.md`, "variances.md Discipline": it records only real variances, never used to excuse
a fixable lint or type error, and stale entries get deleted once resolved. **Enforceable today** —
the file already exists and is populated (several already-merged Features have added entries to it
ahead of Feature #425's own dedicated discipline pass landing), so this item is a manual read every
release, no exceptions, starting now rather than once #425 specifically merges:

- [ ] Open `docs/variances.md` and read every entry.
- [ ] For each entry, confirm it is still true of the release commit — an entry describing a
      condition that no longer holds (the underlying issue got fixed, the tool got upgraded, the
      workaround got removed) must be deleted before release, not left as stale changelog prose.
- [ ] Confirm nothing shipped in this release _should_ have a variance entry and doesn't — i.e.
      a known, accepted deviation introduced by this release's own changes is written down, not
      left implicit.

Mark Pass only once the reviewer has actually read the file for this commit and it reflects
reality. "It was current last release" is not current.

### 4. Frontend generated-bundle drift guards passing

Covered under [Item 1](#1-ci-quality-gates-green) (`icons:check` / `emoji:check` are two of the
gates `release.yml` runs, mirroring what Feature #423 owns on the alpha channel) — listed here
only so a reader scanning item numbers for "did we check the icon/emoji bundles" finds a direct
answer: yes, as part of item 1, not a separate step.

### 5. Epic 13 migration tooling exercised end-to-end, with sign-off

**Owner: Epic #341 ("Migration & Upgrade Path from 2.5.x")**, specifically task #421 ("Migration
CLI, Dry-Run Reporting & Cutover Runbook") within it.

**This item can never be a CI assertion.** Every other item on this checklist can be answered by a
machine looking at the release commit in isolation. This one cannot: it requires running the
migration tooling against an actual 2.5.x instance's data, which no CI runner has access to and
which cannot be faked with a fixture without defeating the point of the check (the whole risk
being gated is "does this actually work against a real department's real 2.5.x database," not
"does it work against data we made up to look like one"). This item is therefore always a manual
step performed and attested by a named human, every release, with no automated substitute.

As of this writing, Epic #341 has not landed — there is no migration CLI, no dry-run mode, and no
2.x reader of any kind in the repo (confirmed by direct inspection: no migration code exists
under `backend/` beyond Drizzle's own migration runner for the 3.0 schema itself). Until task #421
ships a runnable CLI with a dry-run/report mode, this item cannot be performed and must be marked:

> **N/A — migration CLI does not exist yet (Epic #341 / task #421 not landed).**

recorded explicitly, the same way as [Item 2](#2-test-suites-all-green). A 3.0 release cut before
Epic #341 lands is a release with no verified migration path from 2.5.x — again, a real,
disclosed fact about that release, not something to leave unstated.

**Once task #421 lands**, the procedure for every release is:

1. **Obtain a real 2.5.x dataset.** Not a synthetic fixture — an actual export or database
   connection from a genuine 2.5.x install (a maintainer's own instance, or a department's
   instance with permission). A copy is fine; the live instance must never be written to by the
   dry run.
2. **Run the migration CLI in dry-run mode** against that dataset, targeting a scratch 3.0
   database that is discarded afterward (never the release candidate's actual target database).
   Dry-run mode must not write to the source and must not require a live 3.0 deployment beyond the
   scratch database.
3. **Read the dry-run report.** It must account for every 2.5.x record class named in Epic #341's
   scope: users/groups/permissions, pages/history/tags/navigation, assets, settings/auth-module/
   storage config, and comments (staged, not written — Epic 335's comments table doesn't exist yet,
   so comment data is expected to land in the staging area, not silently vanish). Anything the
   report flags as unmapped, conflicting, or dropped needs a named human decision: either it's
   expected and explainable (e.g. a 2.x LDAP account falling back to local auth per Epic #341's
   documented auth-coverage gap), or it's a real bug that blocks the release.
4. **A named human signs off.** Not "the migration ran" — a specific person read the dry-run
   report, judged it acceptable for this release, and is willing to be identified as having done
   so. Initials or a full name, not a checkbox with no attribution.
5. **Record the sign-off in the release PR description** (or the release-tag announcement, for a
   release cut without a PR), in the same place the rest of this filled-in checklist gets pasted
   per [How to use this checklist](#how-to-use-this-checklist) step 5. The recorded line should
   read as something a future reader can verify was real, e.g.:

   > Migration dry-run: 2.5.x export dated 2026-09-02, source: `wiki-dept-42-export.tar.gz`,
   > 1,204 pages / 38 users / 6 groups mapped with 0 unresolved conflicts. Reviewed and approved
   > by Jane Doe, 2026-09-03.

   A line that only says "migration tested — OK" is not sufficient sign-off; it names no dataset,
   no reviewer, and no date, and cannot be checked later against what actually happened.

This item stays manual permanently — even once task #421 ships full CLI tooling, the _judgment_
of whether a dry-run's mapped/unmapped/conflicting counts are acceptable for a given release is a
human call, not something this checklist should ever try to automate away.

### 6. Multi-arch Docker image manifest verified on a real ARM host

**Owner: Epic #2435 ("Docker build/release pipeline only targets linux/amd64 — no ARM (Raspberry
Pi) support")**, specifically OpenProject #2488 ("Verify published multi-arch manifest on a real
ARM host") within it.

**This item can never be a full CI assertion.** A CI runner can (and, once sibling WPs #2486/#2487
land, will) confirm the *manifest itself* lists `linux/arm64` — that check is scriptable and needs
no special hardware. But "runs correctly," the second half of this item's own name, means the
image's arm64 layer actually boots and becomes ready when Docker pulls and runs it on genuine arm64
silicon — GitHub-hosted runners are amd64-only, so anything CI does with an arm64 image is QEMU
emulation, which is exactly the gap a Raspberry Pi user (Issue #2388, the report that started Epic
#2435) would actually hit. Real arm64 hardware is therefore required for this half, the same way
Item 5's migration dry-run requires a real 2.5.x dataset no CI fixture can substitute for.

As of this writing, Epic #2435's sibling WPs #2486 (`build.yml`) and #2487 (`release.yml`) — which
add `linux/arm64` to the two workflows' buildx `platforms:` in the first place — have not landed.
No image with an arm64 platform in its manifest has ever been published by this repo's CI, so this
item cannot yet be performed and must be marked:

> **N/A — no arm64-including image has been published yet (WP #2486 / #2487 not landed).**

recorded explicitly, the same way as [Item 5](#5-epic-13-migration-tooling-exercised-end-to-end-with-sign-off).

**Once an arm64-including image has been published**, the procedure for every release is:

1. **Verify the manifest**, from any machine with Docker (no arm64 hardware needed for this step):

   ```sh
   node backend/scripts/verify-arm64-manifest.ts ghcr.io/<owner>/<repo>:<version>
   ```

   This inspects the published manifest list (`docker buildx imagetools inspect --raw`, no pull
   required) and confirms both `linux/amd64` and `linux/arm64` are present as real platforms —
   filtering out the `provenance`/`sbom` attestation sub-manifests `release.yml` also attaches,
   which report `architecture: "unknown"` and are not runnable platforms. A `FAIL` here is a
   release no-go; stop and fix the workflow before continuing to step 2.
2. **Run the real hardware smoke test**, on genuine arm64 hardware (a Raspberry Pi, an arm64 cloud
   VM, or Apple Silicon's native arm64 Docker Desktop VM — never an emulated/QEMU arm64 build,
   which would silently pass even on a broken arm64-native layer):

   ```sh
   ./dev/build/arm-host-smoke-test.sh ghcr.io/<owner>/<repo>:<version>
   ```

   This pulls the image, confirms `docker inspect` reports the pulled image's architecture as
   `arm64` (catching a host that silently pulled the wrong platform), starts the container, and
   polls its `/_ready` readiness endpoint until it answers or a timeout is hit.
3. **A named human signs off**, recording which physical (or cloud arm64 VM) host was used, both
   scripts' pass/fail outcome, and the date — in the release PR description, the same place the
   rest of this filled-in checklist gets pasted per
   [How to use this checklist](#how-to-use-this-checklist) step 5:

   > Multi-arch verification: `ghcr.io/example/wiki:3.1.0` — manifest check PASS (linux/amd64,
   > linux/arm64); ARM host smoke test PASS on a Raspberry Pi 5 (Raspberry Pi OS 64-bit). Verified
   > by Jane Doe, 2026-09-10.

   A line that only says "arm64 image tested — OK" is not sufficient; it names no host, no script
   output, and no date.

This item stays manual permanently for its second half (the real-hardware smoke test) — no CI
runner will ever have native arm64 silicon to run it on. The first half (manifest platform
coverage) is a strong candidate for a future CI gate once #2486/#2487 land; until then both halves
are performed together as one manual step.

## Status of automation

A snapshot of what's real today versus what this document anticipates, so nobody mistakes the
future-tense sections above for present-tense fact:

| Item                   | Owner                     | Exists on `scarlett` today?                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. CI quality gates    | Feature #423 / task #777  | Yes — `build.yml`'s `build` job `needs:` the `quality` job (`quality.yml`, also run standalone on `pull_request`); `release.yml` enforces the same checks again                                                                                                                                                                                    |
| 2. Test suites         | Feature #424 / task #1943 | Yes — backend/frontend/blocks run in `quality.yml` (which both `build.yml` and every PR run); the e2e Playwright suite runs as a step in `build.yml`'s `build` job. `release.yml` additionally gates on a successful `build.yml` run existing for the tagged commit (task #1943); the actual per-suite pass/fail read for that run is still manual |
| 3. `docs/variances.md` | Feature #425              | Yes — file exists and is populated; #425 formalizes ongoing discipline around it                                                                                                                                                                                                                                                                   |
| 4. Bundle drift guards | Feature #423 / task #777  | Yes — same as item 1, enforced in both `quality.yml` and `release.yml`                                                                                                                                                                                                                                                                             |
| 5. Migration dry-run   | Epic #341 / task #421     | No — no migration code exists                                                                                                                                                                                                                                                                                                                      |
| 6. ARM host verification | Epic #2435 / WP #2488   | No — WP #2486/#2487 (add linux/arm64 to build.yml/release.yml) have not landed, so no arm64-including image has ever been published to verify                                                                                                                                                                                                     |

Nothing in this table is a criticism of those Features — they are each independently in progress
under the same parent Feature (#426) as this document, at the time it was written. This table
exists so the checklist stays honest as those Features land one at a time: update the row the
moment its owning Feature merges to `scarlett`, and flip the corresponding checklist item from
N/A to an enforced gate in the same change.

## See also

- **`docs/versioning.md`** — defines what a release _is_: the tag format, what triggers a release
  build versus a continuous alpha build, and what version/Docker-tag a given tag produces. Read it
  first if the question is "does pushing X count as a release" rather than "is this commit ready
  to release."
- **[`RELEASING.md`](../RELEASING.md)** — the actual step-by-step runbook for _performing_ a
  release once this checklist has passed: the git commands to tag, what the release workflow does
  with that tag, and how to verify the resulting artifacts. This document stops at go/no-go;
  `RELEASING.md` picks up from there.
- `.github/workflows/release.yml` — the gated release channel (task #777): the workflow that
  actually enforces item 1 of this checklist on every `vX.Y.Z` tag push, and whose own top-of-file
  comment explains why items 2 and 5 stay manual sign-off rather than becoming workflow steps.
- `.github/workflows/build.yml` — the continuous alpha channel. Its `build` job `needs:` the
  `quality` job (`quality.yml`) for item 1, and runs the e2e Playwright suite itself for the rest
  of item 2.
- `.github/workflows/quality.yml` — item 1's actual gate (typecheck/lint/format/drift) plus the
  backend/frontend/blocks unit suites for item 2, shared between `pull_request`, `build.yml`'s
  `quality` job, and `workflow_dispatch`.
