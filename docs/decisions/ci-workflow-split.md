# Decision Record: Why CI Is Split Across `quality.yml`, `build.yml`, `e2e.yml` and `release.yml`

**Status:** Decided — current state of `.github/workflows/`

## The question

Why isn't there one workflow file, and why does the Playwright e2e suite run from `build.yml`'s
`build` job rather than only from its own `e2e.yml`?

## The split, and why

- **`quality.yml` is a `workflow_call:` target, not folded into `build.yml` directly.** A plain
  `pull_request:` trigger added straight to `build.yml` would have no way to stop its expensive Docker
  build/push job from also queuing on every PR — `needs:` only works between jobs in the *same*
  workflow run, so gating the Docker job behind the quality checks requires the quality checks to be
  a job `build.yml` can `needs:`, not a trigger condition.
- **`quality.yml` runs on every pull request directly, and on every `scarlett` push via `build.yml`'s
  `quality` job (`uses: ./.github/workflows/quality.yml`).** Its steps: backend typecheck, then
  per-workspace lint (`oxlint --deny-warnings`) and the frontend's icon/emoji drift checks, then a
  `Backend/Frontend/Blocks Tests` step per workspace, then one repo-wide `oxfmt --check`. A
  `postgres:18` service container backs the backend's DB-backed model suites; frontend and blocks
  never touch it.
- **`build.yml`'s `build` job `needs: quality`, and does not repeat its tests.** Re-running the same
  three `npm run test` invocations on top of what `quality` already ran on the identical commit would
  pay for them twice with no new coverage. Its own steps, after the gate: stamp the alpha version,
  build `frontend/`'s assets and `blocks/compiled`, run the Playwright e2e suite against that build,
  then log in to GHCR and build/push the Docker image — all before the Docker steps, so a failing step
  blocks the image the same way a broken `npm run build` already did.
- **The Playwright leg reuses the build that's already there, not a second one.** `e2e/`'s
  `playwright.config.js` boots `node backend` against `frontend/`'s already-built `assets/` output —
  both already produced by earlier steps in the same job — so this leg needs no extra `npm run build`.
  The Docker image is not built at all until every step above, including this one, has passed, so
  there is exactly one `docker/build-push-action` invocation per run.
- **`build`'s own `postgres:18` service container is for the Playwright leg's first-run seeding
  only** — the backend's DB-backed model suites run in `quality`'s own separate service container, not
  here.
- **`e2e.yml`'s own `push: branches: [scarlett]` trigger was deleted.** That push event already runs
  the same suite from `build.yml`'s `build` job, and a second install-browsers-and-run-the-suite pass
  on the same commit buys nothing. `e2e.yml` still runs standalone on `pull_request` and
  `workflow_dispatch`, which `build.yml`'s push-only trigger doesn't cover.
- **`release.yml`'s tag-push channel runs its own copy of the quality gates** (typecheck, lint, drift
  checks, format) rather than depending on `build.yml`'s run for the exact commit a release tag points
  at, so a release never publishes on a stale, skipped, or not-yet-run gate. It does not repeat the
  unit or e2e suites, for the same already-covered-by-the-`scarlett`-push reasoning as above.
