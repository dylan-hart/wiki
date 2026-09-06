# Decision Record: The `*.flaky.*` Quarantine Lane

**Date:** 2026-09-06
**Status:** Decided — implements OpenProject #2691 (Feature #2603, Epic #2600)
**Author:** Task #2691

## The question

A handful of tests in this repo depend on real external state that no amount of care inside the
test makes deterministic — a real Chromium's launch time under N parallel workers, an event-loop
timing margin under a 400-file `node --test` run, an external binary's ambient configuration.
Today they sit in the same blocking lane as every other test, so each is a trunk-red generator, and
each red run costs an overnight batch real effort (#2567, #2569, #2585, #2586, #2587, #2588,
#2589).

The project already had an informal version of this: `docs/cardinal-reskin-second-pass.md` carried
a "Known flaky" section naming one backend test in prose. Prose does not stop a run going red, does
not expire, and is invisible from a directory listing. This record replaces it.

## Decision

**A quarantined test lives in a file whose name carries a `.flaky.` segment**: `*.flaky.test.ts`
(backend), `*.flaky.test.js` (frontend, blocks), `*.flaky.spec.js` (e2e). That file is excluded
from its workspace's default `npm run test` and is run by that workspace's `npm run test:flaky`
instead, which CI runs as a separate report-only step (Task #2692).

Why a filename suffix and not a runner tag or a config-file list: `backend/`'s existing
`*.db.test.ts` is the precedent for encoding a category in the filename, a glob is the one selector
all four runners support (`node:test` has no tag mechanism at all, so a tag would need four
different answers), and a filename is visible in a directory listing and in every diff that touches
the file, which a list buried in a config is not.

### The exact command per workspace

Both halves are part of the contract, because a lane nobody can run is the same as no lane:

| Workspace   | Default run (lane excluded)                          | Lane only                                                                            |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `backend/`  | `npm run test` → `node --test '**/!(*.flaky).test.ts'` | `npm run test:flaky` → `node --test '**/*.flaky.test.ts'`                              |
| `frontend/` | `npm run test` → `vitest run` (config `exclude`)      | `npm run test:flaky` → `vitest run --config vitest.flaky.config.js`                    |
| `blocks/`   | `npm run test` → `vitest run` (config `exclude`)      | `npm run test:flaky` → `vitest run --config vitest.flaky.config.js`                    |
| `e2e/`      | `npm test` → `playwright test` (config `testIgnore`)  | `npm run test:flaky` → `playwright test --config playwright.flaky.config.js --pass-with-no-tests` |

Three of these four lanes are empty as of this record; only `backend/` has a member. An empty lane
must exit 0, so the two Vitest lane configs set `passWithNoTests: true` and the Playwright lane
script passes `--pass-with-no-tests`. `node --test` already exits 0 on a pattern that matches
nothing.

The two Vitest lanes and the Playwright one each need their own config file rather than a
command-line flag, and that is not an aesthetic choice: Vitest's CLI has no `--include` (its
`--exclude` is _additive_, so it cannot cancel the base config's exclusion), and Playwright's CLI
has no `--test-match`. Each lane config re-derives its `include`/`testMatch` from the base config it
imports, so a change to the base — a new `include` root, a new plugin — reaches the lane without a
second edit.

One thing the `e2e/` lane does differently, worth knowing before wiring its CI step: Playwright
starts `webServer` **before** it discovers tests, so an empty lane would boot a whole backend
against a real Postgres just to then report zero specs. `playwright.flaky.config.js` therefore drops
`webServer` when the lane holds no `*.flaky.spec.js`, and restores it the moment one lands. The
`DATABASE_URL` precondition in the base config still applies either way, since a real lane spec
needs it.

### Why `backend/` uses an extglob, and what does not work

`node --test` takes glob patterns but has **no** exclusion flag. Three things were tried against
the real runner before settling:

- `node --test '**/*.test.ts' '!**/*.flaky.test.ts'` — **silently runs both files and exits 0.**
  The negation is not interpreted; it is treated as a pattern that matches nothing and contributes
  nothing. This is the failure mode to watch for: it looks exactly like success.
- `--test-skip-pattern` — matches test _names_, not paths. Wrong axis.
- `node --test '**/!(*.flaky).test.ts'` — **works.** The extglob is evaluated inside the one path
  segment, so `models/storage.db.test.ts` (the existing `.db.` convention) still matches and stays
  in the default run, while `mcp/http.flaky.test.ts` does not.

Verified on both the sandbox's Node 25.9.0 and Node 26.7.0 (CI's line, per Feature #2601): on a
three-file fixture the plain glob runs 3, the extglob runs 2, and `'**/*.flaky.test.ts'` runs 1, on
both runtimes. If a future Node changes extglob handling, the symptom is the lane quietly rejoining
the default run — so the check to re-run is a file count on each pattern, never an exit code.

### Each quarantined test carries a dated expiry

Every file in the lane opens with a comment stating **why it is here** and **the date by which it
is fixed or deleted** — a plain date, not a run-history system. Three months is the default. The
date makes "quarantined" a commitment rather than a parking space, and a stale one is visible in
any diff that touches the file. Passing the date is not automatically enforced; it is a signal to
whoever next opens the file, and it is what stops the lane becoming a place tests go to die.

## What qualifies, and what does not

This is the whole difference between a quarantine lane and a graveyard.

**Eligible.** The test depends on real external state that cannot be made deterministic from
inside the test:

- a real browser's _launch_ or process-startup time, under whatever parallelism the run happens to
  use;
- an event-loop or wall-clock timing margin that is a property of the whole run's scheduling rather
  than of the code under test;
- a real external binary's ambient configuration (a version-control client's global config, a
  system locale, an installed toolchain's defaults);
- an external network service the test genuinely has to reach.

**Not eligible.**

- **A flaky assertion about product behaviour is a defect.** If the thing being measured is what
  the app does, an intermittent failure means the app is intermittently wrong, or the test is
  wrong. Both are fixed, not quarantined.
- **Anything the parity image (Feature #2601) makes deterministic.** A test that fails only because
  the sandbox runs Node 25.9 while CI runs 26.x is a fixable environment gap, not a fragile test.
  Quarantining one hides the fix. When in doubt, file it against #2601 and leave the test where it
  is.
- **A slow test.** Slowness is a budget problem (Feature #2602's territory), not a determinism one.
- **A test that fails because of shared state between tests in the same file or run.** That is an
  isolation bug with a real fix — a fresh fixture, a cleared module-level singleton
  (`helpers/rateLimit.ts#activeBanMemo` is the worked example already in the tree).
- **A test nobody wants to maintain.** Delete it, and say so.

Moving a test in is a decision that gets argued in the merge request that does it, not a reflex.

## What is in the lane today

**`backend/mcp/http.flaky.test.ts`** — the single test `an active session is not evicted while it
is still being used`, split out of `backend/mcp/http.test.ts`. It touches an MCP session five times
across a span longer than a deliberately tiny 30 ms idle TTL, asserting `updateAgeOnGet` keeps
resetting the clock; whether each touch lands inside a 30 ms window is a fact about the event loop
under a ~400-file `node --test` run, not about the session map. It passes reliably when run alone.
Expiry **2026-12-06** — by then it is either rewritten against injected time (which would make it
deterministic and return it to the default lane) or deleted. The other two tests in that describe
assert eviction _happens_, which a slow run only makes more true, so they stay in the default run.

Nothing else. The initial set is deliberately small.

## `frontend/`'s two real-Chromium describes stay OUT of the lane

`ApiKeyCreateDialog.test.js` and `ProfileApiKeyCreateDialog.test.js` each carry a
`… — real layout` describe that launches a real headless Chromium (`test/realGridLayout.js`) to
measure how many columns an `auto-fit`/`minmax()` CSS grid actually renders at a given width. They
already carry `{ skip: !hasChromium(), timeout: 30000 }`. `docs/cardinal-reskin-second-pass.md`
recorded them as having failed intermittently alongside the MCP test, which makes them the obvious
second candidate. They are not being quarantined. Both sides, explicitly:

**The case for quarantining them.** They are the only tests in the repo that launch a real browser,
so they are the only ones whose runtime depends on a process launch competing with seven other
Vitest workers — precisely the "real external state" the lane exists for. They were observed
failing for that reason. They are also the slowest tests in `frontend/`, and a `hasChromium()` skip
already means the default run does not depend on them being present, so moving them costs the
default run nothing it is not already prepared to lose.

**The case against, which wins.**

1. **What failed was the browser launch, not the measurement.** The second-pass doc was explicit:
   they were timing out on `chromium.launch()` under eight workers, not on anything they measure,
   which passes in well under a second once the browser is up. That is a bounded, identified cause
   with a fix already applied — the 30 s `timeout` on each describe — and a second fix coming from
   Feature #2601's parity image. There have been no failures since. Quarantining a test whose known
   cause has already been addressed is exactly the "hides a fixable problem" outcome Feature #2603
   warns about.
2. **They are among the highest-value tests in the repo.** Per Feature #2602's evidence, they are
   one of the few suites that ever caught a real defect: PR #43's overlay bug was invisible to jsdom
   and to CSS reasoning, and only a real layout engine exposed it. The lane is report-only by
   design, so moving them there converts the repo's best regression detector into a signal nobody
   is required to look at. That is the highest-cost mistake available in this Epic.
3. **They already have the right mechanism for their real environment dependency.** The genuine
   external dependency here is _whether a Chromium binary is installed at all_ — a per-machine fact,
   handled correctly by `hasChromium()` skipping the describe rather than failing it. The lane
   would be a second, blunter answer to a question already answered well.

If they do start failing again with the 30 s timeout and the parity image both in place, that is
new evidence and this decision gets revisited on it — under this record's own rules, with the
argument written down.

## Relationship to the rest of Epic #2600

- **Feature #2601 (environment parity) comes first in spirit even where it does not come first in
  time.** Anything #2601's image would make deterministic is not a quarantine candidate.
- **Feature #2602 (re-proportioning the suite)** classifies what each test is _for_; this record
  classifies what a test _depends on_. A test can be valuable (category 1) and still
  environment-fragile, which is why the two questions are answered separately.
- **Task #2689's `docs/decisions/testing-strategy.md`** is the aggregate testing policy and cites
  this record for the quarantine rules. The two must agree; this file is the authority on the lane.
- **Task #2692** owns the CI side: the lane runs as its own step, report-only everywhere including
  `release.yml`. A lane that blocks a release is a blocking lane with extra steps.
