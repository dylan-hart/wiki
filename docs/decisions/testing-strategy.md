# Decision Record: What Each Test Layer Is For, and What Goes Untested

**Date:** 2026-09-06
**Status:** Decided — implements OpenProject #2689 (Feature #2602, Epic #2600)
**Author:** Task #2689

## The question

This repository has more test code than source code in one workspace and roughly two-thirds as much
in another, and until now no written statement of what any of it is *for*. Every convention that
exists — co-located `*.test.ts`, the `*.db.test.ts` suffix, `test/` reserved for harness code, the
two contract runners — describes *where a test file goes*. None of them says which code earns a
test, which layer answers which question, or what this project deliberately does not test.

The absence has a cost that is now measured rather than asserted. Two hand-classification passes
(#2687 for `backend/`, #2688 for `frontend/`) read every suite in both workspaces and found the
same shape twice: the great majority of the suite gates real product behaviour, and the waste is
not a set of worthless files but a set of **recurring assertion shapes** repeated inside files that
are otherwise worth keeping. You cannot delete a shape without a rule that names it. This document
is that rule set.

It is a decision record, not a how-to guide. The per-workspace mechanics — runners, harnesses,
mount helpers, fixtures, the DB fixture's schema-per-call design — live in `CLAUDE.md` and are
cited here, never restated.

## The evidence this is written from

| Document | Covers | Task |
| --- | --- | --- |
| `docs/testing-audit/README.md` | the shared classification schema | #2687 |
| `docs/testing-audit/backend.md` | every `backend/` suite, one row each | #2687 |
| `docs/testing-audit/frontend.md` | every `frontend/` suite, one row each | #2688 |
| `docs/testing-audit/metrics.mjs` | the objective counts, all four workspaces | #2687 |
| `docs/decisions/flaky-test-quarantine.md` | the `*.flaky.*` lane | #2691 |

Both classifications used Feature #2602's four categories verbatim — **product behaviour**,
**framework behaviour**, **implementation restatement**, **environment** — and both are read here
as evidence, not as verdicts. Where they took a position this document adopts it, overturns it, or
adjudicates between them, explicitly, in
[Positions carried forward](#positions-carried-forward-adopted-overturned-adjudicated).

### The corrected figures, and what they supersede

Epic #2600's description and Feature #2602's table both state that **9 of 397** backend suites
exercise a real database. That was the triage measurement, it was taken off the `*.db.test.ts`
filename suffix, and it is wrong by a factor of nine. `backend.md` finding 1 measured the tree
instead: **79 of 397** suites open a real Postgres schema, and only 9 of those carry the suffix.

Re-measured on this branch at `66a224a86` with `node docs/testing-audit/metrics.mjs`:

| | `backend/` | `frontend/` | `blocks/` | `e2e/` |
| --- | ---: | ---: | ---: | ---: |
| test files | 412 | 330 | 40 | 10 |
| test LOC | 129,030 | 66,558 | 5,659 | 1,415 |
| test LOC / source LOC | **1.24** | 0.73 | 0.52 | — |
| suites opening a real Postgres schema | **81** | 0 | 0 | 0 |
| …of those, named `*.db.test.*` | **11** | — | — | — |
| suites behind a `{ skip: !… }` gate | **84** | 14 | 0 | 0 |
| suites booting Fastify | 74 | — | — | — |
| suites scanning repo files | 34 | 16 whole-tree | 0 | 0 |

The audits' own denominators were taken at `3b3635f74` (397 backend, 308 frontend); the difference
is this run's other work packages, not a re-measurement dispute. **These figures supersede
"9 of 397" wherever it appears.** Three of them are load-bearing for the rules below:

1. **The inverted-ratio diagnosis survives; its stated cause does not.** The DB-backed layer is
   about a fifth of `backend/`, not two percent. The volume is concentrated in route suites, in
   34 repo-file scans, and in two 3,400-line model suites — not in the database layer, which is
   the highest value per line in the workspace.
2. **A fifth of `backend/` is silently skipped on a default `npm run test`.** 84 files sit behind a
   precondition gate — 80 on `DATABASE_URL`, the rest on pandoc, `git-cliff`, Elasticsearch, or a
   suite's own probe. This is the correct pattern and this document keeps it, but it means **green
   locally and green in CI are different promises**, and anything reading a bare "tests passed"
   must say which.
3. **Neither workspace has a single category-2 file.** Nothing in this repo tests that Fastify,
   drizzle, Vue, Pinia or `node:test` does what it documents. That is a result worth defending, not
   a category to retire — see [What gets no test at all](#what-gets-no-test-at-all).

## The layers, and the question each one answers

Six layers, plus one cross-cutting mechanism that is deliberately **not** a layer. They are ordered
by cost, cheapest first, and **a test belongs at the lowest-numbered layer that can actually answer
its question** — every step further down this list costs roughly an order of magnitude more time
and produces a coarser failure signature.

### 1. Pure unit — no `WIKI` global, no database, no mount

**The question:** given this input, does this logic produce this output?

**Right for:** decision tables and precedence rules (`helpers/pageRules.ts`, `helpers/siteRules.ts`),
parsers and codecs (the tree-path codec, `normalizePagePath`), permission resolution over
in-memory rules, session flattening (`models/users.ts#updateSession`), pure frontend helpers,
anything in `frontend/src/helpers/`.

**Wrong for:** anything whose correctness depends on the database agreeing, on a request passing
through a real gate, or on a browser laying something out. A pure test of those asserts the mock,
not the system.

**Rule:** if the logic is decidable before a query is built or a request is issued, it is tested
here, and testing it anywhere else is the same test made slower and less specific.

### 2. DB-backed — a real Postgres schema through `test/db.ts#setupTestDb()`

**The question:** does the database agree?

This is the layer with the strictest membership rule in this document, because it is both the most
valuable per line in `backend/` and the most tempting to over-apply. See
[The DB-backed rule](#the-db-backed-rule).

**Right for:** constraints firing, transaction boundaries holding, concurrent writers not
corrupting each other, and several tables staying in step across one logical write.

**Wrong for:** a CRUD round trip whose only database contribution is handing back the row that was
just inserted. That is layer 1 with a Postgres bolted on.

### 3. Route / HTTP — `test/fastify.ts#buildTestApp`, real gate, stubbed models

**The question:** does a request reach the handler at all, and does the gate answer correctly?

`buildTestApp` installs the **real** `apiErrorHandler` and the **real** `permissionPreHandler`,
API-key branch included, and stubs only the models below the handler. That is what makes an
assertion here a claim about the gate a request actually passes through rather than about a replica
of it, and it is why `backend.md` classifies almost the whole `api/` directory as product
behaviour.

**Right for:** which permission gates a route, 401-before-403-before-404 ordering, schema validation
and its 400s, what is and is not serialised into a response, encapsulation boundaries (a body
parser or `preHandler` scoped to one sub-plugin), and the site-pin / disabled-site guards.

**Wrong for:** business logic reachable without HTTP — that is layer 1 or 2 — and for the single
most common restatement shape in the workspace, *"the handler forwards the body to the model
unchanged"*, which is [not tested at all](#what-gets-no-test-at-all).

### 4. Component — a real mount through each workspace's harness

`frontend/test/mount.js#mountWithApp` under happy-dom; `blocks/test/mount.js#mountBlock` under
jsdom.

**The question:** does the rendered interface do what a person doing this would expect?

**Right for:** a control's effect on state and on emitted events, accessible names and roles, focus
handling, i18n resolution, RTL mirroring where it is expressed in logical properties, empty and
error states, a store's reaction to a stale or failed response, and a block's reading of its own
light-DOM body.

**Wrong for:** anything requiring a layout engine (layer 5), and anything requiring more than one
process (layer 6). Prefer mounting the real component over shallow-rendering: `frontend.md`'s zero
category-2 files are partly a consequence of the harness building the framework stack once, so
suites never have occasion to assert that the stack works.

### 5. Real browser — Playwright's bundled Chromium via `frontend/test/realGridLayout.js`

**The question:** what does a real layout engine actually compute?

**Right for:** exactly the questions no DOM emulator can answer, because neither jsdom nor
happy-dom runs a layout engine. How many columns an `auto-fit`/`minmax()` grid renders at a given
width is the worked example; PR #43's overlay scroll/dismiss defect — invisible to jsdom *and* to
careful CSS reasoning, exposed only by a real engine — is the case that settled it, and it is
recorded here because it was previously written down nowhere under `docs/decisions/`.

**Wrong for:** everything else in a component. The cost is a browser launch; it is paid per
`describe`, not per file, and it is skipped entirely by `{ skip: !hasChromium() }` on a machine
with no browser binary.

**Rule:** this layer needs an explicit justification in the test file naming the property that no
emulator can answer. Two `describe` blocks in the whole repository use it today, and that number
should move slowly.

### 6. End-to-end — Playwright against the built stack (`e2e/`)

**The question:** does the real, production-shaped stack hold together across process and host
boundaries?

**Right for:** boot against a real Postgres, first-run seeding, the login round trip, session
cookies actually being host-only, hostname-routed multi-site resolution, the built `assets/` bundle
being the one served, an author's real keystrokes through Monaco and the save dialog.

**Wrong for:** permission matrices, error taxonomies, accessibility properties, and anything with
more than a handful of cases. Ten specs in one Chromium at one viewport cannot assert a focus trap,
an `aria-live` announcement, an RTL-mirrored gutter or a `javascript:` refusal, and every case added
here is paid for on every run. `frontend.md` states the consequence plainly: delete the frontend
unit suite and essentially everything it covers goes ungated, because `e2e/` cannot reach it.

**Rule:** a flow gets an e2e spec when its failure mode is *the pieces not fitting together*.
Anything that is a case within one piece belongs above.

### Not a layer: structural and source scans

A scan reads source text or a repo file off disk and asserts a property across a whole tree
(`api/routeTags.test.ts`, `frontend/src/imgAlt.test.js`, the 34 backend repo-file scans, the 16
frontend whole-tree gates). It is a **mechanism**, available at any layer, and it is the right one
for exactly one question: *is this property true of every file, including a file nobody wrote a
test for?* That is the class of defect a per-file test structurally cannot see, because the failure
is an omission in a file that does not exist yet.

Neither classification gave scans a category of their own, and this document does not either. See
[Positions carried forward](#positions-carried-forward-adopted-overturned-adjudicated) for the
adjudicated rule, and [What gets no test at all](#what-gets-no-test-at-all) for the half of the
scan population that is not kept.

## What belongs at which layer

Rules, applied to the code in front of you. Not ratios: Feature #2602's resolved scope is explicit
that a target percentage is the same volume-as-a-proxy-for-quality error this policy exists to
correct, wearing a different hat.

1. **Test at the lowest layer that can actually fail on the defect.** If a wrong answer would be
   visible to a pure function test, it does not get a route test as well.
2. **A defect that has shipped gets a test at the layer that would have caught it, pinned to its
   issue number.** `frontend.md` found suite after suite naming the OpenProject issue it was written
   for; that is the difference between accumulated regression coverage and speculative surface
   coverage, and it is the single healthiest habit in this repository.
3. **A security boundary is tested at the boundary, not below it.** Permissions, sanitisation,
   SSRF-reachable fetches, open-redirect containment, secret masking, and per-site scoping are
   tested where an attacker's request arrives — layer 3 for an API surface, layer 2 where the filter
   is SQL. A unit test of the helper is not a substitute, because the question is whether the route
   *calls* it.
4. **A shared surface is tested once, at the shared surface.** `composables/adminSettings.js`,
   `components/ModuleConfigForm.vue`, `helpers/moduleConfig.js`, `helpers/pageAccess.ts`,
   `helpers/clusterCache.ts`, the two contract runners
   (`test/searchModuleContract.ts`, `test/storageModuleContract.ts`) each own a contract. Its
   consumers test what is **theirs** — the page-specific behaviour, the vendor-specific
   translation — and do not re-assert the contract with their own key names. `frontend.md` measured
   the cost of ignoring this: twenty-one admin pages each re-asserting the same `load()`/`save()`
   round trip.
5. **A claim asserted about two or more components is a `describe.each` in a named shared file**,
   which records what stayed behind in each component's own suite. This is already `CLAUDE.md`'s
   convention; `frontend.md`'s finding is that the pattern is **under-used, not over-used**, with at
   least four live duplications of exactly the shape it exists to absorb.
6. **A new module in a family joins its contract runner rather than re-describing it.** A search
   engine, a blob storage driver: the runner emits the claims the family owes its model, and the
   module's own file keeps only what is genuinely vendor-specific.
7. **Reviewability is a real constraint, and it is not a coverage question.** Two suites
   (`backend/models/navigation.test.ts` at 3,419 lines and `backend/models/pages.test.ts` at 3,098)
   are 5% of the workspace between them, both category 1, both earning it. No file-size limit is
   set here, but a suite past roughly a thousand lines **splits by subject on its next substantive
   touch**, into the sibling files `CLAUDE.md` already sanctions
   (`models/users.test.ts` / `users.crud.test.ts` / `users.profile.test.ts`), with coverage
   unchanged. Splitting is not pruning and does not need #2690's authority. *(This settles
   `backend.md`'s third open question.)*

## The DB-backed rule

Which code **must** have a DB-backed test. `CLAUDE.md` already names the shape — "a `models/` write
path that inserts, checks a constraint, and coordinates a couple of tables" — and this is that,
made applicable. Applying it produces whatever count it produces; no target is set.

**A DB-backed test is required when any of these is true of the code:**

- It **writes more than one table in one logical operation** and those tables must stay in step —
  the page/tree/history trio is the canonical case.
- Its correctness **depends on a database-enforced invariant**: a unique index, a foreign key, a
  check constraint, a partial or locale-scoped uniqueness constraint. The assertion is that the
  constraint fires, which is unobservable above the query builder.
- It **coordinates concurrent writers**: an advisory lock, `SELECT … FOR UPDATE`, an upsert race, a
  scheduler job claim, a cross-instance reload.
- It **depends on a transaction boundary** — a partial failure must leave nothing behind.
- It **filters rows by permission in SQL.** A leak here is invisible to a stubbed query builder,
  and the failure mode is a disclosure.
- It **is a migration**, or depends on the migrated schema's shape.

**A DB-backed test is the wrong instrument when:**

- The logic is decidable **before** the query is built — validation, permission resolution over
  in-memory rules, path normalisation, payload mapping. Layer 1, and a DB-backed version of it is
  slower and no more truthful.
- The database's only contribution is **returning the row just inserted**, with no constraint, no
  second table and no concurrency in the picture. That is a restatement that happens to be slow.
- The model method under test **has no caller but its own test.** `CLAUDE.md`'s existing rule
  stands: express the read-back as a local fixture helper over the table, not as a widened model
  surface.

**Mechanics, unchanged and non-negotiable:** every DB-backed suite wraps its whole `describe` in
`{ skip: !hasTestDatabase() }` so an unset `DATABASE_URL` reports skipped rather than failing; one
`setupTestDb()` per file, shared by its describes; a fresh randomly-named schema per call, dropped
in `teardownTestDb()`. All three are in `CLAUDE.md` and none of them changes here.

## What gets no test at all

The hardest section, and the one that makes this a policy rather than a wish list. Everything below
is something this project **deliberately does not test**. Each entry names the recurring shape, why
it cannot earn its keep, and — where one exists — the narrow exception that is not an instance of
it.

Both audits found that the waste is overwhelmingly *inside* files worth keeping: 50 mixed rows in
`backend/`, ~2,900 LOC of stated restatement share inside category-1 `frontend/` files. So these
are written as assertion shapes to stop writing, not as files to delete. Deleting the shape wherever
it appears is #2690's mandate.

1. **"The handler forwards the body to the model unchanged."** The single largest restatement shape
   in `backend/`, spread across `api/`. It restates the handler line by line and can only fail on a
   deliberate rewrite. *No exception.* Whatever the handler validates, gates or reshapes **is**
   tested; the passthrough is not.

2. **"The `definition.yml` declares the props it declares."** The second named shape, spread across
   `modules/`. An admin filling the form would see a missing prop immediately. *Exception:* a scan
   asserting a module **has** a required file or handler at all is a structural claim about files
   that do not exist yet, and is kept.

3. **A JSON Schema's field list, re-typed as an assertion.** `api/schemas/group.test.ts`'s
   enum-equals-the-union and `api/schemas/hook.test.ts`'s description-contains-a-sentence are the
   pure cases. Drift here surfaces as a 400 the first time an admin saves — annoying, never silent.
   *Exception, and it is a real one:* a schema **branch that has shipped a bug** is product
   behaviour, not schema restatement. The boolean-or-string union of #2366
   (`api/schemas/security.test.ts`, `api/schemas/storage.test.ts`) locks an admin out of a setting
   when it is wrong, and stays.

4. **Prose in a document.** Asserting that a Markdown file contains a sentence, a heading or a
   phrasing is prose linting through a test runner. Roughly 4,600 test LOC and ~350 assertions in
   `backend/` are this shape, and **not one of them can fail on a product defect.** *Exception, and
   this is the whole of it:* a doc scan that binds a document to a **machine-readable fact in code
   that can diverge silently** is kept, because that divergence has no other detector. The six
   named by `backend.md` are the set — the MCP tool list against `registerAllTools()`, `dataPath`
   subdirectories against what models populate, documented CSS classes against real selectors in
   `_page-contents.scss`, the documented default admin credentials against `models/users.ts`'s
   seeding, every hard-required release gate running before the Docker publish, and `package.json`
   declaring only `pg` as a database driver. A scan not in that shape is the cheapest and least
   risky thing in the repository to delete: the cost is a stale doc, not a shipped bug.

5. **Process discipline that is not a property of the code.** `docs-todo-fixme-drift`,
   `docs-variances` and `release-checklist-doc` enforce project conventions through `node --test`
   because there is nowhere else to put them. *Ruled here, since `backend.md` left it open:* they
   are legitimate and they stay, but they are **capped by rule 4** — a process check survives only
   where it binds a document to a machine-readable fact, and the test suite does not grow new ones.
   The test runner is where they live because it is the only always-run gate, not because they are
   tests.

6. **Dead code staying dead.** `frontend/src/autofocusUsage.test.js` (an inert duplicate
   `autofocus` attribute), `frontend/src/css/_base.test.js` (deleted Quasar selectors),
   `frontend/src/components/EditorMarkdown.deadcode.test.js` (three identifiers removed in task
   477). By construction nothing a user could observe changes if the dead thing returns. A deletion
   is verified once, by the diff that performs it. *No exception.*

7. **Field-by-field payload mapping.** `stores/site.test.js`'s twelve "adopts X from the payload" /
   "defaults to Y when omitted" pairs, ~260 LOC. One table-driven `it.each` over the field list
   keeps the same coverage at a fraction of the size; N hand-written pairs is the mapping retyped.

8. **A shared contract, re-asserted by each consumer.** Rule 4 of the placement rules, stated as a
   prohibition: the twenty-one `adminSettings.js` pages do not each test `load()`/`save()`.
   `composables/adminSettings.test.js` owns that contract. **The pages are explicitly released from
   it here**, because `frontend.md`'s finding was that they do not currently know they are allowed
   to stop.

9. **Framework behaviour — category 2.** That both workspaces are at zero is the result to defend.
   No test asserts that Vue re-renders, that Pinia patches, that drizzle builds SQL, that
   `node:test` runs. *Exception:* a **documented framework behaviour this codebase's design
   actually leans on**, where getting it wrong is a live hazard — Fastify's `register()`
   encapsulation boundary is the case, and `api/users/profile.test.ts` tests it as *our* wiring, not
   as Fastify's promise.

10. **Getters and derived state with no branch**, and a mock's exact call arguments where the call
    itself is the behaviour. Both are the implementation retyped; a behaviour-preserving refactor
    breaks them and a behaviour break does not reliably fail them.

11. **Appearance.** Exact spacing, colour values, class-name presence with no behavioural
    consequence. *Exceptions, and they are narrow:* a layout **behaviour** no emulator can compute
    (layer 5), an accessibility property (a name, a role, a focus order), and RTL mirroring, which
    is a correctness property expressed through logical CSS properties and is gated as such.

12. **A test nobody wants to maintain.** Delete it and say so in the diff. It is not a quarantine
    candidate — see below.

## Positions carried forward: adopted, overturned, adjudicated

Both classifications took positions. Each is settled here rather than averaged.

### Route-surface scans → kept, product behaviour

**Adopted from `backend.md` §(a).**

`api/routeTags.test.ts`, `api/responseErrors.test.ts`, `api/index.test.ts`'s scan half and
`helpers/apiKeySite.coverage.test.ts` walk every route file through `test/routeRecorder.ts` and
assert a property no individual route file's test can see. The defects are user-reachable: an
untagged route vanishes from the API docs under `hideUntagged`; a permission-gated route with no
401/403 `ApiError` schema serialises its error body wrong for every caller that hits the gate; a
`:siteId` route registered outside the pin hook's prefix lets a site-scoped API key read another
site. **These survive #2690 untouched**, and a fifth scan of the same kind is welcome.

### Doc and CI-config consistency scans → restatement, capped

**Adopted from `backend.md` §(b), narrowed by rule 4 above.**

Kept only where the scan binds a document to a machine-readable fact in code. Everything else in
that 34-file, ~4,600-LOC block is the cheapest volume in the repository to remove.

### Classify a scan by what regresses in the product, not by the mechanism

**`frontend.md`'s rule governs.**

The two documents differ in emphasis here — `backend/`'s scans land in restatement, `frontend/`'s
mostly in product behaviour — and the difference is real but not a conflict. Applying
`frontend.md`'s rule to `backend/`'s doc scans reproduces `backend.md`'s verdict exactly: a stale
document is not a defect a person hits, so the scan is restatement. Applying it to `frontend/`'s
tree scans yields product behaviour, because a missing `alt`, an unnamed dialog, an untranslated
literal or a physical `margin-left` that will not mirror under RTL is a defect a person hits. **One
rule, two answers, both correct.** The scan is a *proxy* for the behaviour and the proxy's
imprecision — it can pass while the behaviour breaks another way, and fail on a refactor that
changed text without changing behaviour — is a cost recorded in the reason, never a category of its
own. **No fifth category is created**, for the reason `frontend.md` gives: mechanism-shaped
categories put `imgAlt` and `autofocusUsage` on the same side of a line they belong on opposite
sides of.

### `describe.each` across components → the required form, and under-used

**Adopted from `frontend.md`.**

Placement rule 5. The gap is application, not the rule.

### The two real-Chromium suites → keep, do not quarantine

**Both documents agree; adopted.**

`ApiKeyCreateDialog.test.js` and `ProfileApiKeyCreateDialog.test.js`'s "real layout" describes are
the most expensive assertions in the repository and are worth it: no cheaper mechanism answers the
question at all, the cost is two `describe` blocks behind `{ skip: !hasChromium() }`, and the
recorded failures were browser *launch* timeouts under eight Vitest workers — an environment
problem Feature #2601's pinned image and an applied 30 s timeout both address — not unstable
measurements. `docs/decisions/flaky-test-quarantine.md` argues the same conclusion at length and is
the authority on the quarantine half of it.

The one action worth taking is `frontend.md`'s: `test/realGridLayout.js` has no co-located suite of
its own, so a break in it presents as two unexplained layout failures. It and `test/setup.js` are
the only two harness modules without coverage.

### The harness's own coverage → kept, and classified restatement-with-an-exemption

**`backend.md` §(c) adopted; `frontend.md`'s category-4 label overturned.**

Both documents reach the same verdict — keep — by different labels: `backend.md` calls
`backend/test/*.test.ts` category 3 with a stated exemption; `frontend.md` calls
`frontend/test/*.test.js` category 4. The verdict is adopted from both. The label is adjudicated in
`backend.md`'s favour, for a reason neither document could see alone: **in this Epic, category 4 has
a second job.** It is #2691's quarantine candidate set, produced nowhere else in the tree. Filing
non-flaky harness coverage into it collides two unrelated meanings in one label and feeds the
quarantine lane files that have no business there.

So: harness coverage is **restatement by category and exempt from pruning by rule**, in both
workspaces. The justification is fan-in, and it is measured. `frontend/test/setup.js` runs before
every test in its workspace; `test/mount.js` is imported directly by 76 suites on this branch (64
at the audit's snapshot); `backend/test/`'s `buildTestApp` and `createWikiStub` stand behind
hundreds of assertions. A silent break in any of
them weakens everything downstream without failing anything, and produces a failure signature
pointing everywhere except the cause. That is the exemption, and column 4 of both audits records it
per row so a reader cannot act on the category alone.

## Conventions kept, and the one that changes

`CLAUDE.md`'s per-workspace conventions are the ground this builds on. Kept unchanged: co-located
`*.test.ts` / `*.test.js` beside the file they cover; several sibling files per source file split by
subject; `test/` reserved for shared harness code plus its own coverage; the two contract runners;
`node:assert/strict` in `backend/`; the `{ skip: !… }` precondition gate; `stubs: { teleport: true }`
by default in `frontend/`; a test-only sibling module named as a plain `.js`.

**One convention changes, on `backend.md` finding 1's evidence: the `*.db.test.ts` suffix is
retired as a boundary claim.**

`CLAUDE.md` presents the suffix as making "the pure/DB boundary visible from the filename" so that
"the pure half can be run alone." Neither half of that is true: 70 of the 81 DB-backed suites are
indistinguishable from pure ones by filename, so the boundary is not visible, and no path glob can
select the pure half. A suffix applied by hand to a growing set drifts, and this one already has.

The ruling, in three parts:

1. **The boundary is `hasTestDatabase()`, not the filename.** It is universal (every DB-backed suite
   carries it; `migration/connectors/postgres.test.ts` is the one file with its own equivalent
   probe), it is enforced at runtime rather than by discipline, and it is mechanically checkable —
   a file calling `setupTestDb()` outside a `{ skip: !hasTestDatabase() }` gate is a defect anyone
   can find with a grep.
2. **Running the pure half alone is `DATABASE_URL` unset**, which is what a developer already has.
   That is the real selector and it always was.
3. **Nothing is renamed, in either direction.** Renaming 70 files to add the suffix, or 11 to
   remove it, changes no behaviour, invalidates the path column of both audit documents in the
   middle of the pruning pass those columns exist to serve, and buys a selector that
   `DATABASE_URL` already provides. The 11 existing names stay as they are; the suffix is **not
   required** of a new DB-backed file and carries no claim if used.

The consequence for `#2691`'s lane is that the `*.flaky.*` suffix is a *different* kind of marker
and does not inherit this problem: it selects a set that is deliberately tiny, is the sole input to
its own runner, and would announce its own drift by the lane quietly rejoining the default run.

*(This settles `backend.md`'s second open question. Its first is settled by "what gets no test at
all" rule 5, its third by placement rule 7, and its fourth — any deletion — is #2690's.)*

## How this interacts with the quarantine lane

`docs/decisions/flaky-test-quarantine.md` is **the authority on the lane**; this document changes
nothing about it and restates none of its rules.

The two answer different questions, and the distinction is the reason both exist:

| | This document | The quarantine record |
| --- | --- | --- |
| Asks | what a test is **for** | what a test **depends on** |
| Decides | which layer, and whether it is written at all | whether it blocks a run |
| Vocabulary | the four classification categories | eligible / not eligible |

Four consequences, stated so neither document has to be read against the other:

1. **The two axes are independent.** A test can be the highest-value kind there is (category 1) and
   still be environment-fragile. Quarantining it is not a demotion and does not make it a pruning
   candidate; keeping it out of the lane does not make it valuable.
2. **A category-4 classification is not a quarantine nomination.** `backend.md` says this outright
   about its own flat list — "do not read this list as 'these are flaky'" — and the harness
   adjudication above is the reason the confusion is worth guarding against.
3. **Nothing this document says makes a test eligible for the lane.** Eligibility is the lane
   record's, and its exclusions bind: a flaky assertion about product behaviour is a defect, an
   environment gap Feature #2601's image closes is a fix, a slow test is a budget question, shared
   state between tests is an isolation bug, and a test nobody wants to maintain gets deleted under
   [rule 12](#what-gets-no-test-at-all) rather than parked.
4. **A quarantined test is still governed by this document.** It carries a dated expiry, and when
   that date arrives the question "is this worth keeping at all" is answered from here.

## Applying this to a file

The procedure #2690 runs. It is written to reach a verdict without a follow-up question; where it
cannot, that is a defect in this document and it gets fixed here rather than decided ad hoc.

For each file, in order:

1. **Read its row in `docs/testing-audit/backend.md` or `frontend.md`.** The category and column 4
   ("what gates this behaviour if the file goes away") are the starting point, not the verdict.
2. **Is it harness coverage, or one of the four route-surface scans?** → **Keep, whole.** Both
   exemptions above are unconditional. Harness coverage means a suite whose *subject* is a module
   under `test/` (`test/fastify.ts` → `test/fastify.test.ts`); **living under `test/` is not the
   criterion** — the 31 doc scans that also sit there have a document as their subject, not the
   harness, and go to step 3.
3. **For each assertion in the file, is it an instance of one of the twelve shapes in
   [What gets no test at all](#what-gets-no-test-at-all)?** Check the exception attached to that
   shape before acting. An instance with no applicable exception → **delete the assertion.**
4. **Is what remains empty?** → delete the file. **Is what remains real?** → keep the file with the
   restatement removed. Most files land here; both audits found the waste inside kept files, not in
   separate ones.
5. **Does column 4 say something else gates the behaviour?** If it names a replacement, the
   deletion is safe. If it says "nothing", the assertion stays **unless** it is one of the shapes
   whose whole point is that nothing needs to gate it (dead code, prose, appearance) — those say
   "nothing needs to."
6. **If the file is kept and is over ~1,000 lines**, splitting it by subject is available without
   #2690's authority and is not pruning. Coverage unchanged.
7. **Record the verdict against the audit row.** A deletion whose reason is not one of the twelve
   named shapes is out of scope for #2690 and needs an argument of its own.

### Worked examples

Each resolves to a verdict, and each is a case one of the audits flagged as awkward.

- **`backend/api/glossary.test.ts`** (classified `3 restatement / 1 product (~70/30)`). Step 3:
  most of its twenty-four tests are shape 1, *the handler forwards these fields to the model*. Its
  unknown-site 404s come free from `siteEnabledPreHandler` and are covered once in
  `api/index.test.ts`; its body validation is enforced by the route's JSON Schema. **Verdict:**
  delete the forwarding assertions, keep the file with whatever is genuinely route-level. Column 4
  named the replacement, so the deletion is safe.

- **`backend/test/docs-variances.test.ts`.** Step 2: it is under `test/`, but it is not harness
  code — it tests a document, not the harness. Step 3: shape 4 (prose) and shape 5 (process
  discipline). Does it bind the document to a machine-readable fact in code that can diverge
  silently? No. **Verdict:** delete. The cost is a stale `variances.md`, not a shipped bug.

- **`backend/test/mcp-getting-started-doc.test.ts`.** Same two steps, opposite answer: it asserts
  the documented tool list matches `registerAllTools()` 1:1, which is exactly rule 4's exception
  and one of the six named. **Verdict:** keep that assertion; delete any prose assertions sitting
  beside it.

- **`backend/models/analytics.test.ts`** (classified `3 restatement`). Step 3: shape 2, *the
  `definition.yml` declares the props it declares*, plus a disk-scan count. But its "a failed scan
  leaves an empty array, not `undefined`" test is a real branch with a real consumer. **Verdict:**
  keep the file, reduced to that assertion.

- **`frontend/src/autofocusUsage.test.js`.** Step 3: shape 6, dead code staying dead — what it
  forbids is inert. Column 4 says nothing needs to gate it, and step 5's carve-out applies.
  **Verdict:** delete. Its near-twin `src/buttonAccessibility.test.js` is **not** the same call:
  an unnamed `<w-btn>` is a defect a screen-reader user hits, so it is product behaviour through a
  textual proxy and it stays. The two files being the same scanner with a different predicate is a
  consolidation opportunity (placement rule 5), not a deletion.

- **`frontend/src/pages/pageTitles.test.js` and `pageTitleHeadings.test.js`.** Both scan the same
  directory for the same #1630/#1637 conversion from opposite directions; both are product
  behaviour. Step 3 deletes nothing. Placement rule 5 applies instead: **merge into one**, losing
  no coverage. Not a #2690 deletion.

- **`frontend/src/stores/site.test.js`.** Step 3: shape 7, twelve field-by-field
  `applySiteInfo()` adopt/default pairs, ~260 LOC. **Verdict:** replace with one table-driven
  `it.each`; keep the file's stale-response and RTL-detection coverage, which is not restatement.
  This is the whole of why `src/stores/` is the one inverted directory in `frontend/`.

- **`frontend/src/pages/Admin*.test.js`'s `load()`/`save()` round trips.** Step 3: shape 8. The
  contract is `composables/adminSettings.test.js`'s and the pages are released from it by this
  document. **Verdict:** delete the round trips; keep each page's own behaviour.

- **`backend/mcp/http.flaky.test.ts`.** Not this document's call at all — it is in the lane, with
  an expiry of 2026-12-06. When that date arrives, this document decides whether it is worth
  keeping; until then the lane record governs.

## What this document does not do

- **It authorises no deletion by itself.** #2690 acts, file by file, with an audit row and this
  procedure. A deletion outside the twelve named shapes needs its own argument.
- **It sets no coverage target, in either direction.** No percentage, no ratio, no minimum. The
  rules produce whatever count they produce.
- **It does not govern the quarantine lane.** `docs/decisions/flaky-test-quarantine.md` does.
- **It does not restate `CLAUDE.md`.** Where the two overlap, `CLAUDE.md` is the mechanics and this
  is the reasoning. The one place they disagreed — the `*.db.test.ts` boundary claim — is resolved
  above and corrected there.
