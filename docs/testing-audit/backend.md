# `backend/` test-value classification

What each of `backend/`'s test suites actually gates, classified by hand, one row per file.

Produced for OpenProject **#2687**, under Feature **#2602** ("Re-proportion the suite"). This is the
evidence the testing policy (**#2689**) and the `backend/` pruning pass (**#2690**) are both written
from; the `frontend/` half is **#2688**'s and lands beside this file as `frontend.md`. The
category-4 rows are also **#2691**'s quarantine candidate list — see
[Category 4 as a flat list](#category-4-as-a-flat-list).

This document changes nothing under `backend/`. It deletes no test and rewrites none.

## How to reproduce the denominator

```sh
find backend -name '*.test.ts' -not -path '*/node_modules/*' | wc -l   # 397
find backend -name '*.db.test.ts' -not -path '*/node_modules/*' | wc -l   #   9
```

`-not -path '*/node_modules/*'` is load-bearing: without it the same glob returns **709**, counting
vendored dependencies' own suites. `#2688` and `#2689` must be able to reproduce 397 exactly.

- **Taken at commit** `3b3635f7433241bd9a65a580e1ea73dab7234a2a` (`scarlett`, 2026-09-06).
- **Objective numbers**: `docs/testing-audit/metrics.mjs` (committed output in
  `backend-metrics.txt`). The script counts; it does **not** classify. Per Feature #2602's resolved
  scope, the category and the reason are a human judgement and are deliberately not scriptable —
  "the value here is the decisions, not the ability to re-run them."

## The four categories

Feature #2602's vocabulary, verbatim and unabbreviated. Nothing is added to it.

| # | Category | Definition |
| --- | --- | --- |
| 1 | **product behaviour** | Would catch a real defect a user could hit. |
| 2 | **framework behaviour** | Asserts that Fastify, drizzle, `node:test` or a library does what it documents. |
| 3 | **implementation restatement** | Asserts the code does what the code says, and changes whenever the code changes without ever failing on a bug. |
| 4 | **environment** | Passes or fails on the runtime, the filesystem, the git binary or the clock rather than on the code. |

Where a file is genuinely mixed the category cell says so with a rough share
(`1 product / 3 restatement (~70/30)`) rather than forcing one label. The **fourth column is
mandatory for every row that is not purely category 1**: the parent Feature's rule is "deleting a
test is only safe if the audit says what gates that behaviour instead," and #2690 cannot act without
it. A `—` in that column means the row is category 1 and nothing else gates it.

## Rollup

| Primary category | Files | Share |
| --- | --- | --- |
| 1 product behaviour | 338 | 85% |
| 2 framework behaviour | 0 | 0% |
| 3 implementation restatement | 57 | 14% |
| 4 environment | 2 | 1% |
| **Total** | **397** | |

"Primary" is the first category named in a mixed cell. **50 of the 397 rows are mixed** and are
counted once, under their primary; the secondary share is named in the cell and its replacement
coverage in column 4. Counting only primaries therefore understates the restatement volume — a fair
reading is that roughly 57 files are predominantly restatement and another ~40 carry a meaningful
restatement share inside an otherwise valuable file.

**Category 2 is empty, and that is a real result rather than an oversight.** No suite in `backend/`
asserts that Fastify, drizzle or `node:test` does what it documents. The nearest candidates — the
five `api/schemas/*.test.ts` files — turned out on inspection to be asserting *this repo's own* JSON
Schemas, two of them against a genuine shipped bug in how a boolean-or-string union serialises
(#2366), which is product behaviour rather than framework behaviour. The suite's problem is not that
it tests the framework.

### Reading the rollup honestly

85% category 1 is not the answer Feature #2602's framing expects, and it should not be read as "the
audit found nothing to prune." Three things are true at once:

1. **Most of what `backend/` tests is worth testing.** The security surface here is large — three
   permission systems, an SSRF-reachable fetch, HTML sanitisation, SAML, an MCP write API, a
   destructive replication import — and the suites over it are mostly real gates, not ceremony.
   A pruning pass expecting to delete a third of the workspace will not find that much.
2. **The volume problem is real but is a *distribution* problem, not a category problem.** 123k test
   LOC against 102k source LOC is genuinely inverted, and it is concentrated (finding 3) in route
   suites that re-assert forwarding, in 35 documentation scans that cannot fail on a bug, and in two
   3,000-line model files. Those are the places to act.
3. **The restatement is mostly *inside* category-1 files, not in separate ones.** 50 mixed rows say
   so. The realistic pruning target is not "delete these files" but "delete this recurring
   assertion shape wherever it appears," and the two shapes worth naming are *"the handler forwards
   the body to the model unchanged"* (throughout `api/`) and *"the `definition.yml` declares the
   props it declares"* (throughout `modules/`).

## Findings that outrank any individual row

Four things turned up during the pass that change what #2689 and #2690 are reading against. They are
stated here rather than buried in a row.

### 1. The suite is far more DB-backed than the `*.db.test.ts` suffix suggests — 79, not 9

Feature #2602's framing rests on "only 9 of 397 backend suites exercise a real database," and
`CLAUDE.md` presents `*.db.test.ts` as the marker that makes "the pure/DB boundary visible from the
filename." Measured against the tree:

| | count |
| --- | --- |
| Suites that actually open a real Postgres schema | **79** |
| ...of those, named `*.db.test.ts` | **9** |
| ...of those, gated on `hasTestDatabase()` (`{ skip: !… }`) | 78 |

The 79th is `migration/connectors/postgres.test.ts`, which stands up a 2.5.x-shaped schema over raw
`pg` and gates on its own `dbAvailable` probe rather than `setupTestDb()`/`hasTestDatabase()`.

Reproduce:

```sh
grep -rlE "^[^*/]*\bsetupTestDb\(" backend --include='*.test.ts' | wc -l   # 78
```

(The regex excludes comment lines: `models/pages.selection.test.ts` and `models/rendering.test.ts`
both *mention* `setupTestDb()` in a comment explaining why they deliberately do not use it.)

Consequences the policy has to absorb:

- **The inverted-ratio diagnosis holds, but not for the stated reason.** The DB-backed layer is
  ~20% of files, not 2%. The volume problem is real (123k test LOC against 102k source LOC) and it
  is concentrated somewhere else — see finding 3.
- **The suffix is not a boundary anyone can act on.** 70 DB-backed suites are indistinguishable
  from pure ones by filename, so "run the pure half alone" is not achievable today by a path glob.
  Either the suffix gets applied to all 79 or the convention should be retired in favour of the
  `hasTestDatabase()` gate, which every one of them already has. That is a decision for #2689, not
  something this audit should pre-empt.
- **#2691's quarantine mechanism inherits the same problem**: a `*.flaky.*` suffix applied by hand
  drifts exactly the way `*.db.test.ts` did.

### 2. A fifth of the suite is silently skipped on a default `npm run test`

**82 of 397** files carry a `{ skip: !… }` gate. Without `DATABASE_URL` (and without pandoc,
git-cliff, or `ELASTICSEARCH_TEST_URL`) a local `npm run test` reports them skipped and exits zero.
The gates, in full:

| Gate | Files | Precondition |
| --- | --- | --- |
| `hasTestDatabase()` | 78 | `DATABASE_URL` set |
| `dbAvailable` (own probe) | 1 | a reachable Postgres |
| `pandocAvailable` | 1 | the `pandoc` binary on `PATH` |
| `hasGitCliff()` | 1 | the `git-cliff` binary on `PATH` |
| `hasElasticsearch()` | 1 | `ELASTICSEARCH_TEST_URL` set |

This is a correct pattern and `CLAUDE.md` mandates it — the alternative is a suite that cannot pass
on a clean machine. It is recorded because it means **the number a developer sees pass locally and
the number CI runs differ by about a fifth of the workspace**, and because it is the mechanism
category-4 rows are already contained by. Category 4 here therefore mostly reads "correctly gated,
not broken."

### 3. The volume is concentrated in route suites and repo-consistency scans, not in the DB layer

Rough shape of the 397 by what a file does:

| Shape | Files | Test LOC | Notes |
| --- | --- | --- | --- |
| Boots Fastify via `buildTestApp` / the route recorder | 71 | ~30k | The single largest block. Mostly permission and status-code gates (category 1) with a persistent restatement tail: "the handler forwards the body to the model unchanged." |
| Opens a real Postgres schema | 79 | ~42k | Almost entirely category 1. The highest value per line in the workspace. |
| Reads a repo file outside `backend/` (a doc, a workflow, a Dockerfile, a lockfile) | 32 | ~5k | Almost entirely category 3. Cannot fail on a product bug. |
| Everything else (pure helpers, models, modules, migration, mcp) | ~215 | ~46k | Mixed; the pruning surface. |

### 4. `models/navigation.test.ts` and `models/pages.test.ts` are 5% of the workspace between them

3,420 and 3,099 lines. Both are category 1 and both earn it, but they are also where an "is this
suite proportionate" conversation should start, because a single file at 3,400 lines is not
reviewable as a unit.

## Position on the structural scans

Feature #2687 flags these as "none of the four cleanly," and the coordination note requires a stated
position rather than a quiet distribution. Here it is.

**They are two different things, not one, and they take different categories.**

### (a) Route-surface scans → **category 1, product behaviour**

`api/routeTags.test.ts`, `api/responseErrors.test.ts`, `api/index.test.ts`'s scan half and
`helpers/apiKeySite.coverage.test.ts` walk every route file under `api/` through
`test/routeRecorder.ts` and assert a property no individual route file's own test can see.

The defects they catch are real and user-reachable:

- a route with no `tags` vanishes from the API docs entirely (`hideUntagged` is on);
- a permission-gated route with no 401/403 `ApiError` response schema serialises its error body
  wrong for every caller that hits the gate;
- a `:siteId` route registered outside the pin hook's prefix lets a site-scoped API key read another
  site.

Each of those is a bug a user hits, and each is invisible to a per-file test because the failure is
*an omission in a new file that nobody wrote a test for*. That is exactly the class of thing a
structural scan exists for, and it is why they classify as product behaviour rather than as
housekeeping. **These four should survive #2690 untouched.**

### (b) Documentation and CI-config consistency scans → **category 3, implementation restatement**

The `docs-*`, `readme-*`, `*-doc`, `dockerfile*`, `release-workflow`, `dependabot-config`,
`devcontainer*`, `postgres-version-consistency`, `localazy-config`, `lockfile-integrity`,
`arm64NativeDeps`, `e2e-workflow`, `changelog` and `dev-setup-script` suites, plus `base.test.ts`
and the two `locales/en*.test.ts` files — **32 files, ~5,000 test LOC** — assert that a sentence in a
Markdown file, a key in a YAML file, or a line in a Dockerfile still agrees with something in the
code.

They are category 3 by the letter of the definition: they restate a decision, and they change
whenever that decision's expression changes, without ever failing on a bug. Two qualifications, both
of which #2689 has to rule on:

1. **What they restate is a *document*, not code.** The failure mode they catch — a doc that has
   gone stale relative to the code it describes — is a genuine maintenance value this project has
   deliberately invested in, and it is not nothing. It is just not product behaviour, and it should
   not be counted as if it were.
2. **They are the cheapest large block to reduce, and the least risky.** Deleting one costs a stale
   doc, not a shipped bug. If #2690 needs volume, this is where it is, and column 4 for each of
   these rows says what would be lost.

**They are not distributed across the four categories.** They are one identified set of 32 files,
listed together in the `backend/test/` and root sections below and enumerated again in
[the category-3 doc-scan set](#the-documentation-scan-set).

### (c) The harness's own tests → **category 3, with a stated exemption**

`test/{builders,mocks,fastify,routeRecorder,sourceFiles,migrationFixtures}.test.ts` test the test
harness. Nothing a user can reach depends on them.

They are still the one place where a category-3 file should not be a pruning candidate: `test/`'s
correctness is a *precondition* of every category-1 suite that uses it, and a silent break in
`buildTestApp` or `createWikiStub` would weaken hundreds of assertions without failing anything.
`CLAUDE.md` already says as much ("a harness module is a source file like any other"). Column 4 for
these rows records the exemption explicitly so #2690 does not read the category and act on it.

## Category rows

Category codes in the tables: **1** product behaviour, **2** framework behaviour, **3**
implementation restatement, **4** environment.

### `backend/api/` — 74 files

The route layer. Almost every file here boots the real Fastify app through
`test/fastify.ts#buildTestApp` with the real `permissionPreHandler` and the real `apiErrorHandler`
installed, and stubs only the models below the handler. That shape is what makes the permission,
schema-validation and status-code assertions category 1: they exercise the gate a request actually
passes through, not a replica of it.

The recurring category-3 tail across this directory is the same assertion written many times over:
*"the handler forwards the body to the model unchanged."* It restates the handler line by line and
cannot fail on anything but a deliberate rewrite. Where it is a meaningful share of a file the
category cell says so.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `api/analytics.test.ts` | 3 restatement / 1 product (~50/50) | Two tests: one restates that the route returns the model's list verbatim; the other pins the route's declared permission to `manage:sites`, which is a real access defect. | The permission half is also covered structurally by nothing — `responseErrors.test.ts` checks response schemas, not which permission is declared. Keep the permission assertion; the passthrough one is redundant. |
| `api/apiKeys.swagger.test.ts` | 3 restatement | Asserts the OpenAPI schema declares the fields the schema declares, and that an enum matches `helpers/permissions.ts`. | `helpers/permissions.test.ts` already pins the permission vocabulary; the rest restates `api/schemas/`. A drifted Swagger doc is a docs defect, not a runtime one. |
| `api/apiKeys.test.ts` | 1 product | API-key issuance: scope validation, site pinning, classification allow-lists, and the rule that an API key may not mint another API key. Every one is a privilege-escalation surface. | — |
| `api/approvals.test.ts` | 1 product | `site:approvals` delegation on every rule route, including the cross-site refusal. A wrong answer here hands another site's approval rules to the wrong admin. | — |
| `api/assets.test.ts` | 1 product | Byte-serving headers (`Content-Disposition`, SVG CSP, nosniff), the disabled-site guard on all six routes, and the source-then-destination permission order on a move. The SVG CSP assertions are a stored-XSS gate. | — |
| `api/auditLog.test.ts` | 1 product | DB-backed: the retention change is audited *before* it takes effect, and a below-floor value writes nothing. Tamper-evidence of the audit log itself. | — |
| `api/auth/provider.test.ts` | 1 product | Open-redirect containment on the OAuth/SAML callback: `javascript:`, `//host` and `/\host` targets are all refused from both the `redirect` query param and the provider's own `result.redirect`. | — |
| `api/auth/site.test.ts` | 1 product | The whole unauthenticated account lifecycle — register, verify, forgot, reset — plus the logout cookie attributes and the account-enumeration-safe generic responses. | — |
| `api/auth/strategies.test.ts` | 1 product | DB-backed: strategy save auditing, the `allowedEmailDomains` normalisation, and who may read the group-sync warnings. | — |
| `api/blockCredentials.test.ts` | 1 product | `site:blocks` delegation and allowed-origin validation on a credential that carries a stored secret. A bare hostname or a query-carrying origin accepted here widens a CORS-ish trust boundary. | — |
| `api/blocks.test.ts` | 1 product | Custom-block upload validation (no `static definition`, unparseable JS, a mismatched `customElements.define` tag, an oversized payload) plus `site:blocks` delegation. This route accepts executable JavaScript from an admin. | — |
| `api/bootstrap.test.ts` | 1 product | The public, hostname-resolved boot payload: 404 vs 403 for an unknown vs a disabled site, and which flags reach an anonymous browser. | — |
| `api/checklists.test.ts` | 1 product | The 404-before-403 preamble, the locked-page refusal, and "signed out is 401, not an anonymous check-off." | — |
| `api/classificationLevels.test.ts` | 1 product | DB-backed: `manage:system` on every mutating route, and the all-or-nothing reorder. Classification levels are the floor invariant every page inherits. | — |
| `api/comments.admin.test.ts` | 1 product | DB-backed: a comment is only visible to a moderator holding `manage:comments` on *its own* page, individually — and `manage:system` short-circuits without materialising the site-wide page list. | — |
| `api/comments.test.ts` | 1 product | Guest commenting end to end: the rate-limit bucket keyed by IP, the guest-fields validation, the three separate 403 reasons (`read:comments`, page `allowComments`, site feature off). | — |
| `api/diagrams.test.ts` | 1 product | Anonymous refusal, and the `server` field being stripped before it can reach the renderer — an SSRF gate. | — |
| `api/glossary.test.ts` | 3 restatement / 1 product (~70/30) | Twenty-four tests, most of the shape "the route forwards these fields to the model." The 404-for-unknown-site and body-validation tests are the real ones. | The unknown-site 404s come free from `siteEnabledPreHandler`, covered once in `api/index.test.ts`. Body validation is enforced by the JSON Schema, which is in the route file. The forwarding assertions gate nothing. |
| `api/graph.test.ts` | 1 product | `assembleGraph`'s visibility filtering: a node the caller may not read is absent, and an edge into an unreadable or cross-locale page is dropped. A leak here exposes page titles and paths. | — |
| `api/groups.test.ts` | 1 product | DB-backed: the guests-group role clamp, redirect-field open-redirect validation, and rejection of unknown permission/role strings — the closed-vocabulary guard `CLAUDE.md` calls out. | — |
| `api/hooks.test.ts` | 1 product | Webhook URL validation (scheme, disallowed characters, `httpfoo://`), and per-site scoping of a hook. An outbound webhook is an egress channel. | — |
| `api/icons.test.ts` | 1 product | The icon picker is reachable by a page-rule `write:pages` grant with no group-wide permission — the exact case `config.permissions` cannot express and a handler check has to. | — |
| `api/index.test.ts` | 1 product | `siteEnabledPreHandler` wired into a real lifecycle, plus the structural scan that every site-scoped route inherits it and that `PUT /sites/:siteId` is deliberately exempt. See the structural-scan position above. | — |
| `api/liveData.test.ts` | 1 product | An anonymous caller may not present a `credentialId`. Without this the stored credential is fetchable by anyone who can guess an id. | — |
| `api/locales.test.ts` | 1 product / 3 restatement (~60/40) | The ETag/304 revalidation cycle on `/:code/strings` is real caching behaviour; the "documents a concrete 200 response schema" tests restate the route file. | The schema-shape tests would be gated by nothing, and lose nothing — `responseErrors.test.ts` covers the error half structurally. |
| `api/mail.test.ts` | 1 product | The SMTP failure taxonomy (auth → 400, unreachable → 502, TLS → 502, rejected recipient → 422) and the DKIM private-key mask round trip. The mask test is a secret-disclosure gate. | — |
| `api/navigation.test.ts` | 1 product | `site:navigation` delegation across sixteen endpoints plus `javascript:` target rejection, including nested children. The nested case is the one a naive top-level check misses. | — |
| `api/notifications.test.ts` | 1 product | 401 before touching the model, and 404 for a notification belonging to somebody else. | — |
| `api/pages/classification.test.ts` | 1 product | The classification floor: raising needs `write:pages`, lowering additionally needs `manage:classification`, and a mixed batch is refused whole. | — |
| `api/pages/collab.test.ts` | 1 product | The WYSIWYG seed claim's 404/403 preamble, and that a locked page is deliberately not a barrier — matching the collaboration websocket. | — |
| `api/pages/drafts.test.ts` | 1 product | Draft read/clear is gated on write, not read: a reader must not see somebody's unsaved draft. | — |
| `api/pages/export.pdf.test.ts` | 1 product | Refuses anonymous, refuses without `read:pages`, refuses a locked page — all *before* launching a browser. Both a permission gate and a resource-exhaustion one. | — |
| `api/pages/export.test.ts` | 1 product | `format=markdown` needs `read:source`; `format=html` does not. The distinction between rendered output and authored source is a real permission boundary. | — |
| `api/pages/history.test.ts` | 1 product | Deleted-page recovery: permission checked against both the source and the destination path, `authorEmail` never serialised, and cursor pagination through a permission filter. | — |
| `api/pages/import.test.ts` | 1 product | Per-file failure isolation in a batch import, the aggregate byte ceiling, and `write:pages` on the declared path before any conversion runs. | — |
| `api/pages/index.test.ts` | 1 product | Optimistic-concurrency (`expectedUpdatedAt` at millisecond precision) and the disabled-site guard across eight page routes. The 409 is what stops a silent lost update. | — |
| `api/pages/publishPermission.test.ts` | 1 product | `publish:pages` as a standalone grant: it alone changes `publishState`, and it alone cannot change anything else. Directly encodes the rule in `CLAUDE.md`. | — |
| `api/pages/publishState.test.ts` | 1 product | The same guardrail from the other side (an unchanged `publishState` is not a change). Overlaps `publishPermission.test.ts` substantially. | — |
| `api/pages/read.backlinks.test.ts` | 1 product | A linking page the caller may not read is dropped from the backlinks list. | — |
| `api/pages/read.search.test.ts` | 1 product / 3 restatement (~50/50) | The batched-join assertion ("once for every result sharing a path, not once per row") is a real N+1 guard; the `includeLocaleStatus` on/off pair restates the branch. | The N+1 half has no other gate. The branch half restates `read.ts`. |
| `api/pages/read.test.ts` | 1 product | `withContent` requires `read:source`, a password field is never serialised, alias reads honour TAG-scoped DENY rules, and pageview session writes respect `isEnabled`. | — |
| `api/pages/read.translationStatus.test.ts` | 1 product | An unpublished or unreadable translation is hidden from the status list rather than merely marked. | — |
| `api/pages/write.test.ts` | 1 product | Move/rename permission at the destination (not the source), the `includeTranslations` per-twin gate, and bulk-operation partial-failure reporting. | — |
| `api/replication.test.ts` | 1 product | The bearer-token mask round trip, cron-schedule floor enforcement, and the raw token never reaching the audit log. | — |
| `api/responseErrors.test.ts` | 1 product | Structural scan: every permission-gated route declares 401 and 403 as `ApiError`. Catches an omission in a route file nobody wrote a test for. See the structural-scan position above. | — |
| `api/routeTags.test.ts` | 1 product | Structural scan: an untagged route disappears from the API docs entirely under `hideUntagged`. Same reasoning. | — |
| `api/scheduler.test.ts` | 1 product | Every one of six routes is `manage:system`, plus the schema clamps on `limit`/`states`. The admin scheduler can run arbitrary system tasks. | — |
| `api/schemas/group.test.ts` | 3 restatement | Asserts the JSON Schema's `match` enum equals the TypeScript union it was written from. | Nothing. A drift here surfaces as a 400 the first time an admin saves a rule with the new match type — annoying, but not silent. |
| `api/schemas/hook.test.ts` | 3 restatement | Asserts a schema `description` string contains a particular sentence. | Nothing. This is prose linting. |
| `api/schemas/security.test.ts` | 1 product / 3 restatement (~60/40) | The `trustProxy` boolean-or-string branch really is a shape bug that shipped (#2366) and a wrong answer locks an admin out of a setting. The `apiRateLimit*` shape test restates the schema. | For the restatement half: nothing, and nothing is lost. |
| `api/schemas/site.test.ts` | 1 product | `buildSitePayload` returning exactly the allow-listed keys — an over-broad payload leaks the site's stored `search` config, which carries credentials. | — |
| `api/schemas/storage.test.ts` | 1 product / 3 restatement (~50/50) | Same `#2366` boolean-or-string branch as `security.test.ts`, for `sync.schedule`. | For the restatement half: nothing. |
| `api/search.test.ts` | 1 product | Engine selection validates the submitted config against the site's *stored* config for that engine, and a bad dictionary is refused with a coded error rather than half-applied. | — |
| `api/sites.locale.test.ts` | 1 product | DB-backed: deactivating a locale that still holds pages is refused with a 409 naming the count, rather than orphaning them. | — |
| `api/sites.test.ts` | 1 product | The largest permission matrix in the workspace: `manage:sites` vs `manage:theme` vs each `site:*` delegation against every settings surface, plus hostname schema validation and duplicate-catch-all refusal. | — |
| `api/storage.test.ts` | 1 product | An action a target does not declare is refused before dispatch, a disabled target cannot run one, and `confirmMassDelete` reaches the queued job. The last is a data-loss guard. | — |
| `api/system/extensions.test.ts` | 1 product / 3 restatement (~50/50) | "No route-level permission gates it" is a deliberate public-surface decision worth pinning; the key→`isInstalled` map assertion restates the handler. | For the restatement half: nothing. |
| `api/system/index.test.ts` | 1 product | DB-backed: `PUT /security` and `POST /history/purge` leave an audit row naming the actor and the changed keys, with no secret values in it. | — |
| `api/system/info.test.ts` | 1 product / 3 restatement (~50/50) | "`GET /instances` no longer exists" is a real removal guard; "reports the real configured port, not a hardcoded 0" is a fixed regression. The rest restates the serializer. | For the restatement half: nothing. |
| `api/system/replication.test.ts` | 1 product | The upload is streamed to disk rather than buffered, a non-gzip body is refused before a job is queued, and a failed enqueue deletes the saved file. Memory-exhaustion and orphaned-file guards. | — |
| `api/system/replicationExport.test.ts` | 1 product | The finished tarball is deleted once the stream closes, and a not-yet-finished job answers 409 rather than a truncated file. | — |
| `api/system/settings.test.ts` | 3 restatement / 1 product (~60/40) | Mostly "the toggle route toggles." The schema-refuses-a-missing-`isEnabled` test is the real one. | Schema validation is declared in the route file and enforced by Fastify; the toggles restate the handler. |
| `api/system/transfer.test.ts` | 1 product | Same streamed-upload guards as `system/replication.test.ts`, for the per-site import path. | — |
| `api/tags.test.ts` | 1 product | DB-backed: a tag rename skips pages the actor cannot manage rather than failing the batch, de-duplicates on collision, and is reflected in search afterwards. | — |
| `api/tree.test.ts` | 1 product | Folder delete cascades are refused whole when any descendant page or asset fails its own permission — the check that stops a partial, unrecoverable delete. | — |
| `api/users/admin.createWelcomeEmail.test.ts` | 1 product | Refuses `sendWelcomeEmail` *before* creating the user when mail is unconfigured, and a failed send still reports the user created. | — |
| `api/users/admin.fallbackAccounts.test.ts` | 1 product | Who may read the migrated-fallback-account report (`read:users` or `manage:users`, never a guest). | — |
| `api/users/admin.reassignContent.test.ts` | 1 product | A `manage:system`-protected user cannot have their content reassigned by a caller who does not hold it, and each model error code maps to its own 400. | — |
| `api/users/admin.sessionInvalidation.test.ts` | 1 product | DB-backed: exactly which group and user mutations clear live sessions, and which deliberately do not. A missed case leaves a revoked permission live until the cookie expires. | — |
| `api/users/index.test.ts` | 1 product | Unknown group ids refused before any write, and each `23503` FK constraint mapped to an actionable message naming what blocks the delete. | — |
| `api/users/profile.apiKeys.test.ts` | 1 product | A personal token is attributed to the session user and carries no `groups` field; revoking somebody else's token answers 404, not 403 (no existence oracle). | — |
| `api/users/profile.notifications.test.ts` | 1 product | 401 for anonymous, 401 when the session outlived its user, and an unknown event key silently dropped rather than stored. | — |
| `api/users/profile.test.ts` | 1 product | `requireSessionUser` is scoped to the profile sub-plugin only, and body validation still runs before it. Encapsulation-boundary behaviour Fastify makes easy to get wrong. | — |
| `api/watching.test.ts` | 1 product | 401 before the model, 404 when not watching, and an unknown body field stripped rather than persisted. | — |

### `backend/models/` — 76 files

Where the business logic lives, and where the DB-backed suites are concentrated: **57 of these 76
open a real Postgres schema**. Those are the highest-value files in the workspace — they exercise
constraints, transactions, concurrency and the page/tree/history tables staying in step, none of
which a mocked query builder can verify.

The pure files split cleanly. A pure suite over genuinely pure logic (`users.test.ts`'s
`updateSession`, `userCredentials.test.ts`'s `matchRecoveryCode`, `passkeys.test.ts`'s
`resolveOrigin`) is category 1. A pure suite that stubs the model's own collaborators and then
asserts the model called them is category 3.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `models/analytics.test.ts` | 3 restatement | Asserts each `definition.yml` declares the props it declares, and that the disk scan finds the three modules on disk. | Nothing, and nothing user-facing is lost — an admin filling the form would see the missing prop immediately. The "a failed scan leaves an empty array, not `undefined`" test is the one real assertion. |
| `models/apiKeys.test.ts` | 1 product / 3 restatement (~85/15) | DB-backed: scope narrowing never grants a permission the groups did not hold, a group membership change is honoured on the very next `verify()`, and a group-granted `read:pages` works through a key. The first four tests instead test the file's own `withFixedNow` helper. | For the `withFixedNow` tests: nothing, and they belong in `test/` if anywhere. |
| `models/approvalNotifications.test.ts` | 1 product | DB-backed: reviewers are notified exactly once per submission, a guest author is mailed directly rather than through the scheduler, and a partial approve short of the threshold notifies nobody. | — |
| `models/approvalRules.test.ts` | 1 product / 3 restatement (~50/50) | DB-backed, but four tests all asserting "the mutator calls `broadcastReload`" — which is the `ClusterReloaded` contract, tested once in `helpers/clusterCache.test.ts`. | `helpers/clusterCache.test.ts` gates the base-class contract. What is left here is "this model is on the base class," which the type system already says. |
| `models/approvals.lifecycle.test.ts` | 1 product | DB-backed: submission staleness, multi-approver thresholds, two concurrent approvals finalising exactly once, and the rollback when `updatePage()` throws after the state change. Real concurrency, real data loss if wrong. | — |
| `models/approvals.permissions.test.ts` | 1 product | DB-backed: a reviewer without `read:source` sees the queue entry with the content blanked, and one without `write:pages` cannot approve. Both are content-disclosure gates. | — |
| `models/approvals.test.ts` | 3 restatement | One test: `siteId` is threaded into the `RulePageRef` handed to `checkAccess`. Restates one argument of one call. | The behaviour it stands in for — a page rule scoped to the wrong site — is covered end to end by `models/groups.test.ts` and by every site-scoped route suite. |
| `models/assetServing.test.ts` | 1 product | Which storage target governs a given asset, and the disk-cache/db/direct-access decision tree behind serving its bytes. A wrong branch serves the wrong file or leaks a signed URL. | — |
| `models/assets.test.ts` | 1 product | SVG sanitisation on upload (a stored-XSS gate), inline-vs-download disposition, and every mutation awaiting both the webhook emit and the storage dispatch before resolving. | — |
| `models/auditLog.test.ts` | 1 product | DB-backed: `record`/`recordMany` field parity, actor resolution priority (session over API key), and `purge()` recording its own purge. Tamper-evidence. | — |
| `models/authentication.test.ts` | 1 product | DB-backed against the real `oauth2` definition on disk: a sensitive prop never leaves a read unmasked, and echoing the mask back leaves the stored secret unchanged. A secret-disclosure gate. | — |
| `models/blockCredentials.test.ts` | 1 product | DB-backed: the secret is absent from the create response, origin validation refuses a bare hostname or a query string, and a credential is not readable across sites. | — |
| `models/blocks.test.ts` | 1 product | DB-backed: concurrent `syncSite` producing exactly one row per block, a tag-collision race surfacing as a 409 rather than a raw `23505`, and per-site tag isolation. | — |
| `models/checklists.test.ts` | 1 product | DB-backed: concurrent first checks collapsing into one execution, idempotent re-checks keeping the original checker, and `itemKey` position validation. | — |
| `models/classificationLevels.test.ts` | 1 product | DB-backed: `meetsFloor` failing closed for an unresolvable id, the refusal to delete the last level or one a page still carries, and the `sortOrder` unique constraint. The floor invariant every page inherits. | — |
| `models/commentProviders.test.ts` | 1 product | DB-backed: exactly one provider enabled per site, a non-selectable module refused, and the sensitive-prop mask round trip. | — |
| `models/comments.test.ts` | 1 product | DB-backed: content length bounds, reply nesting depth, and the `comment:new`/`edit`/`delete` payloads carrying the right author identity for a guest vs a member. | — |
| `models/contentSync.test.ts` | 1 product | DB-backed: `countOutOfDate` and the error-staleness window computed identically under UTC and a non-UTC process `TZ`. A timezone bug here silently stops re-syncing content. | — |
| `models/diagramRender.test.ts` | 1 product | The PlantUML fetch uses `redirect: 'error'` with a bounded timeout, and a `server` field on the request cannot reach the model. SSRF containment. | — |
| `models/eventSubscriptions.test.ts` | 1 product | DB-backed: subscribe idempotency and strict per-event scoping of the subscriber list. | — |
| `models/export.test.ts` | 1 product | DB-backed: the tarball's contents, and `isSystem` groups excluded from a per-site export. Exporting the Administrators group into a portable archive is a real disclosure. | — |
| `models/extensions.test.ts` | 1 product / 3 restatement (~50/50) | The `install()` argv assertions are a real supply-chain gate (the exact, fully-ordered flag list). The `definition.yml` architecture/platform assertions restate the YAML. | For the definition half: nothing. An admin would see the wrong compatibility message. |
| `models/glossary.test.ts` | 1 product | DB-backed: case-insensitive duplicate and alias-collision refusal across the whole surface-form set, per-actor `read:pages` filtering of the resolved canonical link, and a bounded cache TTL. | — |
| `models/groups-import.test.ts` | 1 product | The migration's group writer stores permissions and rules verbatim, always non-system, and reloads the rules cache. Writing a system group here would grant an importer's group `manage:system`. | — |
| `models/groups.test.ts` | 1 product | DB-backed: `checkAccess` rule resolution, the DENY/FORCEALLOW ordering, `manage:system` bypass, and scope narrowing. The single most load-bearing permission file in the backend. | — |
| `models/hooks.test.ts` | 1 product | DB-backed: content and metadata stripped from a webhook payload when the hook opts out, per-site hook scoping, and one fan-out path failing not stopping the other. Egress-content control. | — |
| `models/icons.test.ts` | 1 product / 3 restatement (~50/50) | The `notFoundCache` bound and its eviction order are a real unbounded-growth guard. `DEFAULT_SETS` "has no duplicate prefixes" restates a literal. | For the `DEFAULT_SETS` half: nothing. |
| `models/import.test.ts` | 1 product / 4 environment (~90/10) | `runPandoc` is spawned with `--sandbox`, outside the repo root, behind a concurrency gate — all real containment. One test shells out to a real `pandoc` binary and is correctly `{ skip: !pandocAvailable }`. | The one environment test is contained by its own skip gate; it adds a real end-to-end conversion where the rest mock the spawn. Keep it gated. |
| `models/jobs.test.ts` | 1 product | DB-backed: the cron seed table has no two tasks on the same expression, and the heartbeat/retention cutoffs behave identically off UTC. A collision here starves one of the two jobs. | — |
| `models/liveData.test.ts` | 1 product | SSRF containment in depth: private-address refusal, a pinned undici agent built from the pre-validated addresses, `redirect: 'error'`, allow-list matching, and no credential over plain http. | — |
| `models/locales.test.ts` | 1 product / 3 restatement (~70/30) | Completeness computation, interpolation, sideload-pack parsing and merge are real. "Every language in `metadata.js` has a matching `<code>.json`" is a vendored-asset consistency scan. | For the vendored-asset half: nothing, though a missing file would surface as a broken locale at runtime rather than silently. |
| `models/login.passwordReset.test.ts` | 1 product | DB-backed: a deactivated or restricted account gets the same silent non-response as an unknown address, and a valid reset token still cannot log in a deactivated account. Account-enumeration and re-entry gates. | — |
| `models/login.providers.test.ts` | 1 product | DB-backed: `trustEmailForLinking` off refuses to link an existing account, a mismatched provider id is refused, and a locally-enrolled TOTP secret still gates a provider login. Account-takeover surface. | — |
| `models/login.registration.test.ts` | 1 product | DB-backed: `autoProvision` alone does not permit self-registration, `allowedEmailDomains`/`allowedEmailRegex` are applied case-insensitively, and a duplicate address answers a generic response. | — |
| `models/login.test.ts` | 1 product | Provider group sync never grants the root administrators group or a `manage:system` group, and 2FA code routing (TOTP vs recovery) is decided by shape before validation. Privilege-escalation gates. | — |
| `models/mail.test.ts` | 1 product / 3 restatement (~50/50) | The `classifyMailError` taxonomy and the "throws without calling `sendMail` when unconfigured" tests are real. `buildTransportOptions` mapping each config key onto its nodemailer key is a 76-test restatement of a field map. | For the transport-options half: the failure is a mail send that does not work, which every deployment discovers on its first test email — `api/mail.test.ts`'s test-send route covers the reachable path. |
| `models/navigation.test.ts` | 1 product | DB-backed, 3,420 lines: `javascript:` and scheme-relative target refusal including nested children, per-locale override listing, and `copyNav`. The largest single file in the workspace. | — |
| `models/pageClassification.test.ts` | 1 product | DB-backed: the classification floor invariant on create, update and move, including the auto-bump onto a stricter parent. | — |
| `models/pageDrafts.db.test.ts` | 1 product | DB-backed: raw Yjs bytes round-trip, one row per page rather than a history, and the FK cascade/nullify behaviour on page and author deletion. | — |
| `models/pageHistory.test.ts` | 1 product | DB-backed: `listRecoverable` cursor stability across a `versionDate` tie, `authorEmail` never in the projection, and recovery preserving a working password verifier without re-hashing. | — |
| `models/pageProblems.test.ts` | 1 product | DB-backed: the integrity scanner catches a drifted hash, an orphan tree entry, an orphan page row and a grandfathered locale-shadowing path. This is the tool that finds real corruption. | — |
| `models/pageWatchEvents.test.ts` | 1 product | DB-backed: a watcher who has since lost `read:pages` is dropped from the digest, live. A notification leak otherwise. | — |
| `models/pageWatching.test.ts` | 1 product | DB-backed: preference persistence semantics (first watch stores, re-watch does not overwrite) and the same lost-`read:pages` exclusion. | — |
| `models/pages.hasPermission.test.ts` | 1 product | A page-rule `write:scripts` grant with no global permission takes effect, and the same actor is refused outside the rule scope. Directly encodes the "page permissions are not global permissions" rule. | — |
| `models/pages.selection.test.ts` | 1 product / 3 restatement (~50/50) | "The emitted selection omits `searchContent`/`ts`/`historyData`/`links`" is a real over-fetch and payload-size guard (#1834). The `withContent` on/off pair restates the branch. | For the branch half: `api/pages/read.test.ts` covers `withContent` at the route. |
| `models/pages.test.ts` | 1 product | DB-backed, 3,099 lines: create/update/move/delete against the real locale-scoped uniqueness constraint, the create race surfacing as a 409, tree rows staying in step, and locale-shadowing path refusal. | — |
| `models/pageviews.test.ts` | 1 product | DB-backed: the visitor hash is keyed and not a bare sha256, key rotation changes it, and `record()` never throws. A privacy control. | — |
| `models/passkeys.test.ts` | 1 product | `resolveOrigin`: http refused on a real hostname, allowed on loopback, and a hostname mismatch distinguished from an insecure origin. WebAuthn origin binding. | — |
| `models/pdfExport.test.ts` | 1 product | The session cookie is scoped to loopback and the caller `Host` is spoofed, the browser is closed even on failure, and a never-settling page gives up rather than hanging. Credential-scoping and resource guards. | — |
| `models/rateLimits.test.ts` | 1 product | DB-backed: `retryAfter` decreasing monotonically rather than resetting on each hit during a ban, and concurrent attempts serialised by the upsert so exactly `max` are allowed. Brute-force containment. | — |
| `models/renderQueue.test.ts` | 1 product / 3 restatement (~50/50) | Three tests on `resolveSiteOrigin`; the `*` catch-all returning `undefined` is a real case, the others restate the builder. | For the restatement half: nothing. |
| `models/rendering-block-toggle.test.ts` | 1 product | Disabling a block strips its element but keeps the fenced body as visible text — the difference between a disabled block and lost content. | — |
| `models/rendering.test.ts` | 1 product | Re-sanitisation after `inlineIcons` (an entity-encoded `javascript:` href that only exists post-inline), and site-configured `allowedUrlSchemes` still refusing the hardcoded-blocked set. XSS gates. | — |
| `models/replication.test.ts` | 1 product | The scheduled pull only queues when genuinely due, an unparseable cron is skipped rather than thrown on, and a failed import does not reload caches or queue a reindex. | — |
| `models/replicationExport.test.ts` | 1 product | DB-backed: the instance-wide snapshot covers every site and *includes* `isSystem` groups, unlike the per-site export. Getting this backwards breaks a restore. | — |
| `models/replicationImport.db.test.ts` | 1 product | DB-backed: a version mismatch is refused before anything is touched, and a real import wipes and mirrors with ids preserved. The most destructive operation in the product. | — |
| `models/replicationImport.test.ts` | 1 product | Pure: reply ordering refuses a genuine cycle and a dangling `replyTo` rather than looping, and the format-version guard refuses an unrecognised archive. | — |
| `models/search.test.ts` | 1 product | The dispatcher resolves the engine from the page's own `siteId` and falls back to `db` when the configured engine has no implementation. A wrong resolution indexes one site's content into another's engine. | — |
| `models/security.test.ts` | 1 product | `validateTrustProxySpec` accepting exactly the address/CIDR/named-range forms, and the insecure-cookie risk detector. A wrong `trustProxy` makes every client IP spoofable. | — |
| `models/sessions.test.ts` | 1 product | DB-backed: `rotateSecret` invalidating already-signed cookies immediately, and per-user/per-group session clearing hitting exactly the right rows. | — |
| `models/settings.test.ts` | 1 product / 3 restatement (~60/40) | The real-boot-order test (`config.init()` before `initDbValues()`) is a genuine ordering guard. "Does not seed a search or icons row" restates the seed literal. | For the seed-literal half: nothing. |
| `models/siteImport.test.ts` | 1 product | DB-backed: archive size ceilings (a zip-bomb guard), gzip-magic-number refusal, the whole-transaction rollback, and chunking past one bind-parameter batch while still rolling back. | — |
| `models/sites.test.ts` | 1 product | DB-backed: hostname case-folding through `reloadCache`, strict-vs-catch-all resolution, and a PNG/SVG polyglot round-tripping as `image/png`. The polyglot test is a stored-XSS gate. | — |
| `models/storage.db.test.ts` | 1 product | DB-backed: the extension-sensitive dynamic import actually resolves each real storage module, and the sensitive-prop mask round trip. The import is invisible to the type checker. | — |
| `models/storage.test.ts` | 1 product | `validateTarget`'s disk-path checks (absolute, existing, writable, a directory), large-asset threshold classification at the boundary, and dispatch skipping pull-only or disabled targets. | — |
| `models/tags.test.ts` | 3 restatement | One test: `siteId` is threaded into the `RulePageRef`. Same shape as `models/approvals.test.ts`. | `api/tags.test.ts` (DB-backed) covers cross-site tag scoping for real. |
| `models/tree.test.ts` | 1 product | DB-backed: folder rename and delete cascading only within their own locale (bug #932), batched descendant-path rewrites past one chunk, and per-locale filtering when two locales share a `folderPath`. | — |
| `models/userCredentials.test.ts` | 1 product | `matchRecoveryCode` skips an already-consumed entry and checks every unconsumed one rather than stopping at the first non-match. A short-circuit here is a real auth bypass. | — |
| `models/userCredentials.tfa.test.ts` | 1 product | DB-backed: single-use TOTP counters persisted across a reload, two concurrent recovery-code redemptions consuming exactly one, and a code declined for a user deleted mid-verification. | — |
| `models/userCredentials.tokens.test.ts` | 1 product | DB-backed: a token issued moments ago validates as not-yet-expired under a non-UTC `TZ`. One test, but the bug it guards locks every user out. | — |
| `models/users-import.test.ts` | 1 product | The migration's user writer never re-hashes a source password, always resets 2FA rather than carrying it over, and downgrades a race unique violation to `skipped` rather than throwing. | — |
| `models/users.crud.test.ts` | 1 product | DB-backed: create/update/group-swap atomicity — an FK violation on the insert half rolls back the delete half, leaving prior membership intact. | — |
| `models/users.fallbackAccounts.db.test.ts` | 1 product | DB-backed: the fallback-account report lists only accounts with *both* markers set. A false positive here names an ordinary account as migration debt. | — |
| `models/users.notifications.test.ts` | 1 product | DB-backed: an event name outside `HOOK_EVENTS` is silently dropped, and inactive or system accounts are excluded from the subscriber list. | — |
| `models/users.profile.test.ts` | 1 product | DB-backed: a locale naming no installed locale is refused without touching the stored preference, and the avatar hash/blob cascade on user deletion. | — |
| `models/users.test.ts` | 1 product | `updateSession` regenerating the session id *before* writing authenticated state, and permission flattening across groups. Session fixation and the permission list every route hook reads. | — |

### `backend/helpers/` — 47 files

The pure-utility layer, and the part of the workspace that best matches what `CLAUDE.md` says the
suite should look like: small files, no `WIKI` global, no database, real logic under test. Most of
these are category 1 because the logic they cover *is* a security or correctness boundary —
`pageRules`, `network`, `redirectTarget`, `htmlSanitizePolicy`, `images`, `siteResolution`,
`rateLimit`. The restatement here is thin and mostly confined to format/shape assertions.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `helpers/advisoryLock.poolExhaustion.test.ts` | 1 product | Reproduces #2243: a burst of concurrent dispatches sized to the pool deadlocks, and does not once the pool has headroom. A real production hang. | — |
| `helpers/advisoryLock.test.ts` | 1 product | The lock releases even when `fn` throws, a contended acquisition backs off rather than blocking the pool, and a failed unlock discards the client instead of returning it. | — |
| `helpers/apiKeySite.coverage.test.ts` | 1 product | Structural scan: every registered route carrying a `:siteId` param sits under the prefix the pin hook checks. An uncovered route lets a site-scoped key read another site. See the structural-scan position. | — |
| `helpers/apiKeySite.test.ts` | 1 product | The site-pin comparison itself, plus the hook driven against real page and asset routes, refusing before the model is touched. | — |
| `helpers/appShell.test.ts` | 1 product | `dir="rtl"` on the served shell for an RTL locale, and the mtime-keyed template cache re-templating when the file changes. A stale cache serves the wrong direction to every reader. | — |
| `helpers/authSecret.test.ts` | 1 product | The 32-byte minimum is measured in bytes, not characters. A multi-byte string passing a character check would be a weak signing secret. | — |
| `helpers/authSecretSigner.test.ts` | 1 product | The signer re-reads `WIKI.config.auth.secret` per call, so a live rotation takes effect with no restart. This is the fix for the long-standing `FIXME` in `index.ts`. | — |
| `helpers/blobTarget.test.ts` | 1 product | The 1024-based threshold parser and the at-or-above boundary that files an asset as `large`. Getting the boundary wrong routes assets to the wrong bucket. | — |
| `helpers/blockDefinition.test.ts` | 1 product | The static-analysis gate on uploaded block source: rejects interpolated templates, computed keys, spreads, function calls and `on*`-shaped prop names. This is what stops an uploaded block smuggling executable expressions past the extractor. | — |
| `helpers/clusterCache.test.ts` | 1 product | `broadcastReload` reloads *before* it emits (so no listener sees a stale cache), and `subscribeToEvents` reloads without re-broadcasting (so the event does not echo forever). Both failure modes are cluster-wide. | — |
| `helpers/common.test.ts` | 1 product | Same-origin WebSocket handshake validation, `isUniqueViolation` recognising a wrapped `23505`, and `escapeLikePattern` escaping the backslash before the wildcards. | — |
| `helpers/config.test.ts` | 1 product | `$(VAR:default)` substitution, including two references on one line each falling back to their own default. A wrong parse silently misconfigures an instance. | — |
| `helpers/errorHandler.test.ts` | 1 product | An unmarked error collapses to a generic 500 leaking nothing from the original, on both the API and non-API surfaces. Error-message disclosure. | — |
| `helpers/fsPurge.test.ts` | 1 product | Removes only files past the TTL, returns 0 for a missing directory, and rethrows anything that is not a missing directory. A swallowed error here silently stops a purge. | — |
| `helpers/groupSync.test.ts` | 1 product | The guests group, a `manage:system` group and the root administrators group are never revocable, even when allow-listed. Privilege escalation via an IdP-reported group name. | — |
| `helpers/htmlSanitizePolicy.test.ts` | 1 product | Inline-CSS filtering gated by `write:styles` (`position: fixed`, `inset`, `z-index` dropped for an ordinary author), and `javascript:`/`vbscript:`/`data:` refused categorically whatever an admin configures. Clickjacking and XSS gates. | — |
| `helpers/httpCache.test.ts` | 1 product | The 304 short-circuit and the `nosniff` default on the shared cache helper every cacheable route uses. | — |
| `helpers/images.test.ts` | 1 product | Signature-based MIME detection including the PNG/SVG polyglot, and `sanitizeSvg` stripping scripts, `foreignObject`, SMIL and `javascript:` hrefs. Upload-path XSS. | — |
| `helpers/jobExecutionContext.test.ts` | 1 product | `AsyncLocalStorage` semantics the scheduler relies on: two concurrent contexts do not leak into each other, and a still-running continuation keeps its own. A leak here attributes a job result to the wrong job. | — |
| `helpers/jsonPath.test.ts` | 1 product | A path matching nothing throws a typed error rather than returning `undefined` — which is what lets `liveData` answer 400 instead of rendering "undefined" into a page. | — |
| `helpers/localeRouting.test.ts` | 1 product | Locale-prefix matching and the two placement refusals (`assertLocaleActive`, `assertPathNotReservedLocale`). A path whose first segment shadows a locale code is unreachable forever. | — |
| `helpers/metrics.test.ts` | 3 restatement | Asserts the Prometheus exposition formatter emits the format it emits. | Nothing directly, but a malformed exposition is rejected loudly by any scraper on first contact — this is not a silent failure. |
| `helpers/moduleProps.test.ts` | 1 product | The sensitive-config mask round trip: the mask echoed back drops the key rather than storing the literal mask as the secret. | — |
| `helpers/moduleRegistry.test.ts` | 1 product | `mergeModuleConfig` never takes a read-only prop from incoming and never overwrites a stored secret with an echoed mask, and `validateModuleConfig` enforces enum/type/required/pattern. Shared by all six module-backed models. | — |
| `helpers/network.test.ts` | 1 product | `isPrivateAddress` flagging the IPv4-mapped and IPv4-compatible IPv6 forms `URL.hostname` actually emits, and allow-list matching on scheme, host wildcard, port and path prefix. The SSRF primitive. | — |
| `helpers/openapi.test.ts` | 3 restatement / 1 product (~70/30) | Mostly asserts the Swagger `transform` renders permissions into a description string the way it renders them. "Does not declare the dead `apiKeyAuth` scheme" is a real removal guard. | For the rendering half: nothing, and the loss is a wrong sentence in the API docs. |
| `helpers/pageAccess.test.ts` | 1 product | `actorFrom` resolving a personal access token to a real `PageActor` with its scope, and `mayBypassPassword` against real nested DENY/FORCEALLOW rule chains. Password-protection bypass. | — |
| `helpers/pageLinkRewrite.test.ts` | 1 product | Link rewriting does not touch a longer path sharing the same prefix, escapes regex-special characters, and refuses an empty `oldPath` rather than matching every link opener. A greedy match corrupts page content on a rename. | — |
| `helpers/pageRules.nestedDeny.test.ts` | 1 product | Resolution is stable across every array ordering of the same six rules and never flaps between allow and deny. Non-determinism here is an intermittent permission bug nothing else would catch. | — |
| `helpers/pageRules.test.ts` | 1 product | The whole match vocabulary (START/END/EXACT/REGEX), case-insensitivity on DENY rules, and the compiled-pattern cache failing closed identically on every call for an invalid pattern. | — |
| `helpers/pageSerialization.test.ts` | 1 product | Front-matter round trip, and falling back to raw text rather than expanding a YAML alias bomb ("billion laughs"). A denial-of-service gate on import. | — |
| `helpers/pagination.test.ts` | 1 product | Both queries run concurrently, and a count query returning nothing reports zero rather than `undefined`. The `total` alias contract `CLAUDE.md` calls load-bearing. | — |
| `helpers/permissions.test.ts` | 1 product | The three permission vocabularies are closed, internally duplicate-free, and mutually disjoint, and are cross-checked against the frontend's own list. `CLAUDE.md`'s "never invent a permission name" rule, enforced. | — |
| `helpers/pubsub.test.ts` | 1 product | The LISTEN client reconnects with the same channels after an error, backs off, and checks out from the dedicated listener pool rather than the query pool. Exhausting the query pool with listeners is a real outage. | — |
| `helpers/puppeteer.test.ts` | 1 product | The launch semaphore never exceeds its ceiling, releases a failed launch's slot immediately, and rejects past the bounded waiter queue with a 503 rather than queueing forever. | — |
| `helpers/rateLimit.test.ts` | 1 product | Which identity each limiter keys on (API key over session over IP), that the two limiters never share a counter, and that `manage:system` is exempt. A shared key would let one caller exhaust another's budget. | — |
| `helpers/recoveryCodes.test.ts` | 1 product | The restricted alphabet excludes visually-ambiguous letters, codes are distinct, and the shape check rejects a 6-digit TOTP code. The shape check is what routes a submission to the right verifier. | — |
| `helpers/redirectTarget.test.ts` | 1 product | Refuses `//host`, `/\host` and `javascript://%0aalert(1)` — the exact strings a naive scheme-prefix regex passes. Open-redirect containment. | — |
| `helpers/replicationPostImport.test.ts` | 1 product | Every `ClusterReloaded` cache is broadcast-reloaded in order after an import, and a side-effect failure propagates rather than being swallowed. A missed reload leaves the instance serving pre-import state. | — |
| `helpers/requestLogContext.test.ts` | 1 product / 3 restatement (~50/50) | "Tolerates a request with no session at all" is a real guest-path crash guard; the field-mapping tests restate the builder. | For the mapping half: nothing, and the loss is a less useful log line. |
| `helpers/security.test.ts` | 1 product | CSP directive parsing refusing an unknown directive, CSP inline-script hashing against the real built app shell, and the CORS `REGEX` mode anchoring an unanchored pattern so it cannot match as a substring. The anchoring test is a real origin-bypass gate. | — |
| `helpers/siteResolution.test.ts` | 1 product | Hostname case-folding, the strict-vs-catch-all distinction, and the `X-Forwarded-Host` trust boundary driven through a real Fastify request. Host-header site confusion. | — |
| `helpers/siteRules.test.ts` | 1 product | The ALLOW < DENY < FORCEALLOW tie-break for site-scoped delegation, and that `path`/`match`/`locales` are ignored entirely for these rules. | — |
| `helpers/timeout.test.ts` | 1 product | The timer is cleared when the work wins (including when it rejects), and `unref` is honoured. A leaked referenced timer holds the process open on shutdown. | — |
| `helpers/totp.test.ts` | 1 product | The ±1-window drift allowance and no more, and every drift candidate compared even after a match (constant-time-shaped). Auth boundary. | — |
| `helpers/translationStaleness.test.ts` | 1 product | Strictly-before comparison (an equal `updatedAt` is current, not stale) and the primary locale never reporting a status for itself. An off-by-one here marks every translation stale. | — |
| `helpers/translationStatus.test.ts` | 1 product | The same comparison at the per-path level, plus ordering (primary first) and de-duplication of a repeated active locale. Overlaps `translationStaleness.test.ts` in subject. | — |

### `backend/core/` — 20 files

Boot, HTTP wiring, the scheduler, the database manager and the collaborative-editing protocol. The
`collab.*` cluster (7 files, ~2,000 LOC) is disproportionately large but every one of those files
covers a real distributed-systems failure mode — convergence, relay reassembly, buffer caps — that
has no other gate.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `core/collab.capture.test.ts` | 1 product | The pre-auth frame buffer's entry-count and byte caps, and connection ceilings per user and per address. An unbounded pre-auth buffer is a trivial memory-exhaustion attack. | — |
| `core/collab.crossInstance.db.test.ts` | 1 product | DB-backed: two instances cold-starting the same room converge byte-identically, and a session that edits offline and reconnects merges cleanly. Divergence here silently loses authored content. | — |
| `core/collab.draftPersist.test.ts` | 1 product | Debounce, the max-delay cap on continuous edits, and the ordering guarantee that an in-flight flush lands before `pageDrafts.clear()`. A reordering resurrects a stale draft over a saved page. | — |
| `core/collab.draftRecovery.test.ts` | 1 product | The departing connection's name is what the next persisted draft is attributed to. Wrong attribution on a recovery draft is user-visible. | — |
| `core/collab.relay.test.ts` | 1 product | Chunked relay reassembly (out-of-order, duplicate index, distinct senders), the peer-handshake timeout falling back to the stored page, and `RELAY_CHUNK_SIZE` staying under the 8000-byte NOTIFY cap. | — |
| `core/collab.test.ts` | 1 product | `participantInfo` counts an awareness client with no `user` field but contributes no name. A crash or a phantom name in the editor presence list. | — |
| `core/collab.wysiwygSeed.test.ts` | 1 product | Exactly one caller wins the seed claim, synchronously, across instances — and falls back to granting locally when no peer answers. Two winners double-seed the document. | — |
| `core/config.test.ts` | 1 product | DB-backed: exactly one of two concurrent callers seeds the database, `DB_PASS_FILE` is read and trimmed, and an unknown `config.yml` key warns once at any depth. | — |
| `core/db.test.ts` | 1 product | DB-backed: bound-parameter redaction in the query log (a PEM and a secret object never logged), the `dropSchemaIfDev` `IS_DEBUG` guard, at-most-once NOTIFY delivery, and the advisory lock across DDL and `migrate()`. Two of these are data-loss or secret-disclosure guards. | — |
| `core/http/authHooks.test.ts` | 1 product | `permissionPreHandler` in full: OR lists, nested AND entries, `manage:system` bypass, 401-vs-403, and an API key standing in for a session. The single hook every gated route depends on. | — |
| `core/http/errors.test.ts` | 1 product | The API and non-API branches answer their documented bodies and neither leaks the thrown message. | — |
| `core/http/server.test.ts` | 1 product | `/_assets/` hashed output served immutable and unhashed output on the 7-day default, and the trailing-slash normalisation. A wrong cache header on unhashed output ships stale UI to every reader. | — |
| `core/http/session.test.ts` | 1 product | An unmodified session does not write to the store (#2569). Without this every GET writes a session row. | — |
| `core/http/siteRouting.test.ts` | 1 product / 3 restatement (~50/50) | `isPageUrl` excluding every server-owned segment is real routing behaviour; "every entry is an underscore-prefixed single segment" restates the constant. | For the constant-shape half: nothing. |
| `core/logger.test.ts` | 1 product | JSON format serialises an `Error` with its stack rather than `{}`, and a context key colliding with a fixed field loses. Losing stacks in production logs is the whole value of the logger. | — |
| `core/processGuards.test.ts` | 1 product | The single `unhandledRejection` handler logs and exits, and a boot-phase rejection exits non-zero rather than leaving a half-booted process listening. | — |
| `core/scheduler.execution.test.ts` | 1 product | The claim subquery's ordering (`waitUntil` ASC NULLS FIRST, then `createdAt`), the task-timeout ceiling on both the worker and in-process paths, and a stale abandoned task keeping its own captured attempt. Job starvation and double-execution. | — |
| `core/scheduler.reaping.db.test.ts` | 1 product | DB-backed: stranded-job reaping under concurrency — two sweeps never both requeue the same job, a job the original runner already requeued is a no-op, and retries are eventually honoured. Also verified under a non-UTC `TZ`. | — |
| `core/scheduler.schema.db.test.ts` | 1 product | DB-backed: the `jobSchedule.task` unique index really exists in the migrated schema. Two rows for one task double-schedules it. | — |
| `core/scheduler.test.ts` | 1 product | Cron expansion capped at 10 rows with dedupe, completion-promise expiry producing no unhandled rejection, and `stop()` resolving even with a never-settling job in flight. | — |

### `backend/controllers/` — 7 files

Non-API HTTP surfaces. Every one of these is public or semi-public, and the suites are
correspondingly weighted toward caching headers, content-type lockdown and the disabled-site guard.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `controllers/blocks.test.ts` | 1 product | A malformed site or block id 404s before reaching the model, and the immutable cache header on served block code. | — |
| `controllers/files.test.ts` | 1 product | The SVG/HTML `Content-Security-Policy` lockdown on served assets, the disabled-site 403-vs-404 distinction, and the API-key site pin on a hostname-resolved route. Stored-XSS and cross-site read gates. | — |
| `controllers/metrics.test.ts` | 1 product / 3 restatement (~50/50) | "Issues all seven lookups concurrently, not serially" is a real latency guard on a scraped endpoint. "Renders the same exposition as the serial version" restates the renderer. | For the rendering half: `helpers/metrics.test.ts` already covers the formatter. |
| `controllers/seo.test.ts` | 1 product | `robots.txt` disallowing everything when either `index` or `follow` is off, and sitemap pagination into an index past the cap. Getting robots backwards publishes a private wiki to search engines. | — |
| `controllers/site.test.ts` | 1 product | ETag/304 on both the uploaded asset and the built-in fallback, the SVG CSP sandbox header, the disabled-site guard and the API-key site pin. | — |
| `controllers/thumb.test.ts` | 1 product | An unauthenticated request for a thumbnail answers 404 rather than the bytes, and a disabled site is refused before `checkAccess` is even asked. | — |
| `controllers/user.test.ts` | 1 product | A matching `If-None-Match` short-circuits to 304 *without* reading the avatar blob — a real per-request database-read saving on a route every page load hits. | — |

### `backend/mcp/` — 17 files

The in-process Model Context Protocol server. Every tool here is an authenticated write or read
surface reachable by an external client holding a bearer token, so the suites are almost entirely
about who may do what — which is category 1 by definition. The recurring shape is "refuse before the
model is touched, and never audit a refused call."

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `mcp/auth.test.ts` | 1 product | Token → identity → actor resolution, including that a site-scoped key is refused against a foreign site and that an admin-issued key with no `userId` grants no page rules. The MCP authorisation primitive. | — |
| `mcp/http.test.ts` | 1 product | Session hijack refusal (a different bearer token may not reuse a session id), per-request re-authorisation on a follow-up POST, rate limiting, and idle-session eviction with a hard cap. | — |
| `mcp/renderRefusal.test.ts` | 1 product / 3 restatement (~50/50) | The two mapped `CustomError` names produce actionable guidance; the two fall-through cases restate the `else`. | For the fall-through half: nothing. |
| `mcp/site.test.ts` | 1 product | An unscoped key resolves to the sole enabled site but refuses to guess when several exist, and an explicit `siteId` still cannot escape the key's pin. | — |
| `mcp/stdio.test.ts` | 1 product | Tools are registered against the *re-verifying* getter rather than a fixed closure, so a revoked key or a removed permission stops the next tool call. Without this a long-lived stdio session keeps privileges forever. | — |
| `mcp/stdioReverify.test.ts` | 1 product | The re-verify loop: `onRevoked` fires exactly once, `stop()` really stops it, and it ticks on its own timer. | — |
| `mcp/tools/createPage.test.ts` | 1 product | Refuses an admin-issued key outright (no author to attribute), refuses without `write:pages` on the target path, and never audits a refused call. | — |
| `mcp/tools/deleteAsset.test.ts` | 1 product | `manage:assets` on the asset, a not-found on a mid-operation vanish rather than a crash, and no audit row for a refusal. | — |
| `mcp/tools/getPage.test.ts` | 1 product | `includeSource` without `read:source` is withheld rather than refused, a password-protected page comes back locked with the body withheld, and an admin-issued key is `publicOnly`. Content-disclosure gates. | — |
| `mcp/tools/listAssets.test.ts` | 1 product | Filtering is item-by-item on `read:assets` — not `read:pages`, and not a single up-front check. A wrong permission here lists files the caller may not see. | — |
| `mcp/tools/listNavigation.test.ts` | 1 product | Each item's own classification is passed to `checkAccess` rather than a hardcoded default, and browsing-disabled sites refuse. | — |
| `mcp/tools/listSites.test.ts` | 1 product | A token with no global permission sees only the sites it holds `read:pages` on, and a site-scoped token sees only its pin even with `access:admin`. A site-enumeration gate. | — |
| `mcp/tools/renameAsset.test.ts` | 1 product | `manage:assets` on the containing folder, and no audit row for a refusal. | — |
| `mcp/tools/renderDiagram.test.ts` | 1 product | The render rate limit is keyed per user (per key for an admin-issued one) and bypassed only by `manage:system`. Diagram rendering launches a browser. | — |
| `mcp/tools/searchPages.test.ts` | 1 product | A caller without `write:pages` gets no drafts and no password-protected excerpts, and an admin-issued key is `publicOnly`. | — |
| `mcp/tools/updatePage.test.ts` | 1 product | Same admin-key refusal and `write:pages` gate as `createPage`, plus the render-refusal mapping. | — |
| `mcp/tools/uploadAsset.test.ts` | 1 product | `write:assets` on the destination, a cross-site `folderId` refused, and the configured upload size limit enforced. | — |

### `backend/migration/` — 36 files

The 2.5.x-to-3.0 import CLI. This directory is unusual: the "user" is an operator running a one-shot
consolidation, and the defects are *silent data corruption in the imported wiki* rather than a
runtime error. That makes the mapper and importer suites category 1 even though they are pure —
a wrong field map here writes wrong data that nobody notices until much later.

The category-3 tail here is a specific, identifiable shape: tests asserting that a phase reports
`not_implemented` against a connector stub. Those restate the stub's own existence and will be
deleted by the task that implements the connector, not by a pruning pass.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `migration/bootstrap.test.ts` | 1 product | DB-backed: the migration's minimal `WIKI` shell really satisfies every model a built importer calls, and `resolveUsersImportContext` throws rather than importing users under a missing root-admin id. A half-built shell fails deep inside an import. | — |
| `migration/cli.test.ts` | 1 product | Argument parsing refusing an incomplete Postgres source, an unknown `--only` phase and a non-numeric port. A misparsed flag runs the wrong migration against production data. | — |
| `migration/connectors/export-bundle.test.ts` | 1 product | The streaming JSON array parser: does not mistake structural characters inside a string value for object boundaries, throws on a truncated stream, and yields the first valid row without parsing the rest. Silent truncation would drop pages. | — |
| `migration/connectors/postgres.test.ts` | 1 product | DB-backed against a real 2.5.x-shaped schema: every entity generator's ordering, the tie straddling a batch boundary yielding each row exactly once, and the three-table asset collapse. Duplicate or dropped rows on a batch boundary is the classic import bug. | — |
| `migration/content-staging.test.ts` | 1 product | Author-id resolution with an operator fallback for an orphaned FK, and walking `connector.pages()` exactly twice (index pre-pass, then stream) rather than buffering the whole source. | — |
| `migration/exit-status.test.ts` | 1 product | A live run with a `not_implemented` phase exits 1; the identical dry run exits 0. This is what stops CI or an operator reading a partial import as a success. | — |
| `migration/id-map.test.ts` | 1 product | An unmapped old id falls back *and is flagged*, rather than silently writing the operator as the author of somebody else's page. | — |
| `migration/importers/asset-import.test.ts` | 1 product | A stream that throws mid-read becomes a typed failure rather than an unhandled rejection, and a folder path made entirely of disallowed characters is a folder error rather than reaching the destination raw. | — |
| `migration/importers/comment-import.test.ts` | 1 product | A registered author with no entry in the user map degrades to a guest-shaped comment rather than writing a dangling `authorId`. | — |
| `migration/importers/navigation-import.test.ts` | 1 product | Target mapping across every 2.x `targetType`, dropping a target whose page never imported, and the `mdi-<name>` → `mdi:<name>` icon translation. An unmapped target renders as a dead nav link. | — |
| `migration/importers/page-history-import.test.ts` | 1 product | Consecutive-version diffing reporting only genuinely changed fields, chunked inserts past the batch size, and orphaned history rows filed under one synthesized page id per source page. | — |
| `migration/importers/page-import.test.ts` | 1 product | `derivePublishState` across the isPublished/date matrix, editor-key mapping with a contentType fallback, and an unparseable date degrading to unset rather than throwing mid-import. | — |
| `migration/importers/users-groups.test.ts` | 1 product | The three importers' write order and cross-phase referential integrity, the provider-fallback path preserving the original `providerKey` as metadata, and a system group skipped rather than imported. Importing a 2.x system group over 3.0's own would grant its permissions. | — |
| `migration/mappers/authentication.test.ts` | 1 product | `buildAllowedEmailRegex` producing an anchored, escaped, exact-domain alternation — with an explicit test that the trailing `$` is load-bearing, because without it a malicious suffix domain matches. An authentication bypass. | — |
| `migration/mappers/blockFence.test.ts` | 1 product / 3 restatement (~50/50) | Two tests over a three-line function that wraps a body in fence markers. | For the restatement half: `mermaidFence`/`drawioFence` both exercise the same wrapper through a real conversion. |
| `migration/mappers/drawioFence.test.ts` | 1 product | A fence whose body is not decodable SVG, or whose SVG has no `content` attribute, is left untouched with a warning rather than corrupted. Silently mangling a diagram is unrecoverable after the source is decommissioned. | — |
| `migration/mappers/fixtures.test.ts` | 1 product | Three real captured 2.5.x payloads mapped end to end. This is the only place the mappers are exercised against genuine source data rather than a hand-written literal. | — |
| `migration/mappers/mermaidFence.test.ts` | 1 product | Every mermaid fence on a page is wrapped and an unrelated fenced block is not. A greedy match rewrites arbitrary code blocks. | — |
| `migration/mappers/shared.test.ts` | 1 product | `isPlainObject` accepting a class instance (which a `pg` row is) — the exact reason `CLAUDE.md` says not to swap these for `es-toolkit`'s — and the `pickDefined`/`pickPresent` distinction. | — |
| `migration/mappers/site-settings.test.ts` | 1 product | The security field-polarity inversions (open redirect, iframe) and the `uploads.*` → `security.*` cross-key move. An inverted polarity silently disables a security setting on the imported instance. | — |
| `migration/mappers/storage.test.ts` | 1 product | Enum value renames, a mode the target module does not support being dropped *and reported* rather than written, and per-site replay with no cross-call state. | — |
| `migration/orchestrator.test.ts` | 1 product | A phase reporting `error` does not stop later phases, and `--only` preserves relative order. Aborting the run on the first error would leave a half-imported instance. | — |
| `migration/path-normalization.test.ts` | 1 product | Segment folding and the cases that are genuinely unfixable (an all-disallowed segment returns null rather than an empty path). An empty segment produces an unreachable page. | — |
| `migration/phases/assets.integration.test.ts` | 1 product | DB-backed: a real nested-folder asset writing real tree and asset rows against a real destination. One of five integration phases that are the only proof the phases work end to end. | — |
| `migration/phases/content.integration.test.ts` | 1 product | DB-backed: real pages, tree, pageHistory and navigation rows written against a real destination. | — |
| `migration/phases/define-phase.test.ts` | 1 product | A dry run classifies every record but never invokes the write, and a stub generator reports `not_implemented` rather than aborting the run. The dry-run guarantee an operator relies on before a live import. | — |
| `migration/phases/dry-run.test.ts` | 1 product | `writeUnlessDryRun` never calling the write in a dry run. Four tests over the primitive every phase's safety depends on. | — |
| `migration/phases/locale-propagation.integration.test.ts` | 1 product | DB-backed: the settings phase changes the primary locale and the content/assets phases pick it up. Cross-phase ordering that unit tests cannot see. | — |
| `migration/phases/phases.test.ts` | 1 product / 3 restatement (~65/35) | The real half is the per-phase classification arithmetic (`found == wouldCreate + unmappable`) and dry-run/live report parity. Five tests assert a phase reports `not_implemented` against the current stubs, which restates the stub. | For the stub half: nothing, and these disappear when the connectors are finished — they are scaffolding, not coverage. |
| `migration/phases/route.test.ts` | 1 product | `routeOutcome` never invokes a destination write of its own — the phase already wrote before routing. A second write here duplicates every imported record. | — |
| `migration/phases/settings.integration.test.ts` | 1 product | DB-backed: the site-config patch, the instance-settings merge and a real authentication strategy created against a real destination. | — |
| `migration/phases/users.integration.test.ts` | 1 product | DB-backed: real groups/users/userGroups rows with remapped ids and a local password hash that round-trips. A broken hash import locks every migrated user out. | — |
| `migration/recorder.test.ts` | 1 product | A throwing write is not counted, and `snapshot()` returns copies. A miscounted report tells an operator an import succeeded when it did not. | — |
| `migration/report.test.ts` | 1 product / 3 restatement (~50/50) | `KNOWN_3_0_AUTH_MODULES` matching the real directory listing is a genuine drift guard. The table-formatting tests restate the renderer. | For the formatting half: nothing, and the loss is a misaligned report column. |
| `migration/verify-cli.test.ts` | 1 product | Verification-CLI argument parsing, including refusing a zero or negative sample size. | — |
| `migration/verify.test.ts` | 1 product | DB-backed: source-vs-destination count comparison, including the deliberate `+1` group delta and `source_not_implemented` reported instead of a false mismatch. This is the post-migration correctness check itself. | — |

### `backend/modules/` — 52 files

The pluggable-extension layer: authentication (18), comments (4), extensions (1), search (12),
storage (17).

This directory holds the workspace's clearest single restatement cluster. **Eleven
`definition.test.ts` files** — one per comments and search module plus a few auth ones — parse a
`definition.yml` and assert it declares the props it declares. They are category 3 without
qualification: they change whenever the YAML changes and cannot fail on a bug, because the
consequence of a wrong prop is a wrong field in an admin form, visible on first use. They are also
the cheapest rows in the workspace to remove.

The rest is genuinely valuable. The authentication modules encode real IdP protocol behaviour, and
the storage modules are the only place asset delivery to an external target is verified at all.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `modules/authentication/auth0/authentication.test.ts` | 1 product / 3 restatement (~50/50) | The issuer templating (`something.auth0.com` → `https://something.auth0.com`) and the delegation-not-duplication check are real. The `definition.yml` prop assertions are restatement. | For the definition half: `modules/authentication/presetAssets.test.ts` covers the shared branding convention across every preset. |
| `modules/authentication/cas/authentication.test.ts` | 1 product | CAS ticket validation and the service-URL round trip against a stubbed CAS server. An IdP protocol bug is an authentication bypass. | — |
| `modules/authentication/discord/authentication.test.ts` | 1 product | Discord is OAuth2-only, not OIDC, and its profile/guild mapping differs from every other preset. The one preset that genuinely cannot share the OIDC path. | — |
| `modules/authentication/gitlab/authentication.test.ts` | 1 product / 3 restatement (~50/50) | Same shape as `auth0`: issuer templating and delegation are real; the definition assertions restate the YAML. | For the definition half: `presetAssets.test.ts`. |
| `modules/authentication/google/definition.test.ts` | 3 restatement | Two tests: the description mentions SAML, and the module declares no group-sync props. | Nothing. An admin looking for group sync reads the description and finds it. |
| `modules/authentication/keycloak/authentication.test.ts` | 1 product / 3 restatement (~50/50) | Issuer templating from realm plus base URL is real; the definition assertions restate. | For the definition half: `presetAssets.test.ts`. |
| `modules/authentication/ldap/authentication.test.ts` | 1 product | LDAP bind, search-filter construction and group extraction, including TLS options. Filter injection here is an authentication bypass. | — |
| `modules/authentication/local/authentication.test.ts` | 1 product | An unknown address and a known address with no local entry produce the *identical* response. An account-enumeration gate. | — |
| `modules/authentication/microsoft/authentication.test.ts` | 1 product / 3 restatement (~50/50) | Tenant-templated issuer is real; the definition assertions restate. | For the definition half: `presetAssets.test.ts`. |
| `modules/authentication/oauth2/authentication.test.ts` | 1 product | The generic OAuth2 flow every preset that is not OIDC delegates to: state handling, token exchange, profile mapping and the group-claim path. | — |
| `modules/authentication/oidc/authentication.test.ts` | 1 product | The generic OIDC flow: discovery, the authorization URL, and claim-to-profile mapping. Eight of the presets are thin wrappers over this. | — |
| `modules/authentication/oidc/preset.test.ts` | 1 product | `buildOidcConfig`'s precedence rules — a template's issuer and scopes win over admin config, unset template fields fall through, and `mapGroups`/`groupsClaim`/`groupsScope` are *never* fixed by a template. The last is what stops a preset silently overriding an admin's group mapping. | — |
| `modules/authentication/okta/authentication.test.ts` | 1 product / 3 restatement (~50/50) | Issuer templating is real; the definition assertions restate. | For the definition half: `presetAssets.test.ts`. |
| `modules/authentication/presetAssets.test.ts` | 1 product / 3 restatement (~50/50) | "Every preset has a distinct icon path (no two sharing, and thus masking, one file)" is a genuine collision guard. The discovery sanity check restates the directory listing. | For the restatement half: nothing. |
| `modules/authentication/providerPresetAudit.test.ts` | 3 restatement | Asserts a table in a doc classifies each provider the way a work package decided. Pure decision-restatement; no code path reads it. | Nothing. This is a record of a scoping decision, not a gate — see the documentation-scan set below, of which this is a member in everything but location. |
| `modules/authentication/saml/authentication.test.ts` | 1 product | SAML assertion parsing and signature handling against the real `@node-saml` XML layer. Signature validation is the whole security model of SAML. | — |
| `modules/authentication/slack/authentication.test.ts` | 1 product / 3 restatement (~50/50) | Issuer templating and the Slack-specific claim shape are real; the definition assertions restate. | For the definition half: `presetAssets.test.ts`. |
| `modules/authentication/twitch/authentication.test.ts` | 1 product / 3 restatement (~50/50) | Same shape. | For the definition half: `presetAssets.test.ts`. |
| `modules/comments/artalk/definition.test.ts` | 3 restatement | Parses `definition.yml` and asserts it declares the two props it declares, and that the module is scaffold-only. | Nothing. A wrong prop shows up in the admin form the first time the module is configured. |
| `modules/comments/commento/definition.test.ts` | 3 restatement | Same shape, one prop. | Nothing, same reasoning. |
| `modules/comments/default/comments.test.ts` | 1 product | The Akismet spam check *fails open* (with a warning, never throwing) on an invalid key, an unreachable service or a rejected call, and the rate-limit window's boundary is inclusive. A fail-closed spam check would silently block every comment. | — |
| `modules/comments/disqus/definition.test.ts` | 3 restatement | Same shape, one prop. | Nothing, same reasoning. |
| `modules/extensions/definitions.test.ts` | 3 restatement | Asserts each extension's `definition.yml` description contains particular claims, and does not contain a superseded one. Prose linting against a YAML file. | Nothing. The description is admin-facing copy. |
| `modules/search/algolia/definition.test.ts` | 3 restatement | Declares the fields a `SearchEngineDefinition` needs, and marks two props required. | The required-prop half has a thin real value (an unusable engine saved without credentials), but `helpers/moduleRegistry.test.ts` already gates required-prop enforcement generically. |
| `modules/search/algolia/search.test.ts` | 1 product | Wired to `test/searchModuleContract.ts` — the claims every engine owes `models/search.ts` — plus the Algolia-specific index and permission-filtering shape. A leak here returns another actor's pages in search results. | — |
| `modules/search/aws-cloudsearch/definition.test.ts` | 3 restatement | Same shape, plus "orders the props for display." | Same as `algolia/definition.test.ts`. The display-order test gates nothing at all. |
| `modules/search/aws-cloudsearch/search.test.ts` | 1 product | The contract runner plus the CloudSearch-specific batching and document-size caps. 1,102 lines, the largest module suite. | — |
| `modules/search/azure-search/definition.test.ts` | 3 restatement | Same shape. | Same as `algolia/definition.test.ts`. |
| `modules/search/azure-search/search.test.ts` | 1 product | The contract runner plus Azure's own index schema and result mapping. | — |
| `modules/search/db/definition.test.ts` | 3 restatement | Same shape, plus "does not declare `dictOverrides` as a prop" — which is a real cross-file invariant, since `api/search.ts` attaches `dictOverrides` only to the `db` entry. | For the invariant: `api/search.test.ts` asserts the attachment at the route. The rest gates nothing. |
| `modules/search/db/search.test.ts` | 1 product | DB-backed: real Postgres full-text search, including permission filtering of results and the deliberate no-op `deleted`. The default engine every fresh install uses. | — |
| `modules/search/elasticsearch/definition.test.ts` | 3 restatement | Same shape, plus the removed `apiVersion` selector. | Same as `algolia/definition.test.ts`; the removal guard is thin. |
| `modules/search/elasticsearch/search.smoke.test.ts` | 4 environment | Runs against a real Elasticsearch cluster, correctly `{ skip: !hasElasticsearch() }`. Passes or fails on whether `ELASTICSEARCH_TEST_URL` points at a live cluster. | `elasticsearch/search.test.ts` (the contract runner, fully mocked) gates the module's own logic. This file adds the one thing a mock cannot: that the real client and the real index mapping agree. Keep it gated; it is never run by default. |
| `modules/search/elasticsearch/search.test.ts` | 1 product | The contract runner plus the Elasticsearch-specific mapping and the `totalHits` approximation. | — |
| `modules/search/shared.test.ts` | 1 product | `filterVisible` and `toSearchPagesResult` deriving `totalHits` off permission-filtered rows — the single place every engine's result count is computed. A wrong count leaks the existence of pages the caller cannot read. | — |
| `modules/storage/azure/storage.test.ts` | 1 product | Wired to `test/storageModuleContract.ts` plus the Azure Blob SDK shapes. The contract is the asset lifecycle every blob target owes. | — |
| `modules/storage/blobBase.test.ts` | 1 product | The shared activation cache (one client per target, rebuilt on config change, a failed activation not remembered), `keyFor`'s site scoping, and the error wrapping. Shared by s3, azure and gcs. | — |
| `modules/storage/db/storage.test.ts` | 1 product | DB-backed: `purge` nulls out asset data and preview for the target site while leaving tree and metadata intact. A destructive operation with a narrow correct blast radius. | — |
| `modules/storage/disk/storage.test.ts` | 1 product | `validateConfig`'s five real filesystem checks, deterministic re-runnable `dump`, and `importAll`'s page-vs-asset routing by extension. Also proves the module never reaches for a model it should not (via `createWikiStub`'s empty `models`). | — |
| `modules/storage/gcs/storage.test.ts` | 1 product | The contract runner plus the GCS SDK shapes. | — |
| `modules/storage/git/actions.test.ts` | 1 product | `purge` refusing when `localRepoPath` resolves to `WIKI.ROOTPATH` itself. That single test is the difference between a purge and deleting the repository. | — |
| `modules/storage/git/content.test.ts` | 1 product | Rename preserving history in one commit, a locale-only move relocating the file out of the old locale directory, and a translations cascade renaming every twin. | — |
| `modules/storage/git/repo.test.ts` | 1 product | Repository initialisation, remote configuration and the SSH key modes, against a real on-disk repo. | — |
| `modules/storage/git/sync.test.ts` | 1 product | The mass-delete safety guard (#2429): deletions at or above the threshold are held back unless explicitly confirmed. Without it a bad upstream pull deletes the wiki. | — |
| `modules/storage/s3/storage.emulated.test.ts` | 1 product / 4 environment (~80/20) | Runs the real AWS SDK against an in-process `s3rver`, so bytes genuinely round-trip. Environment-adjacent (it binds a local port and writes a temp directory) but self-contained — no external service, no skip gate needed. | For the environment share: `s3/storage.test.ts`'s mocked contract run covers the same lifecycle without the port bind. This file is what proves the SDK call shapes are real. |
| `modules/storage/s3/storage.pathstyle.test.ts` | 1 product | `s3ForcePathStyle` putting the bucket in the path rather than as a subdomain. Getting this wrong makes every self-hosted (MinIO-style) endpoint unreachable. | — |
| `modules/storage/s3/storage.test.ts` | 1 product | The contract runner plus the S3 SDK shapes, via `aws-sdk-client-mock`. | — |
| `modules/storage/sftp/assets.test.ts` | 1 product | Remote asset path construction and the upload/rename/delete lifecycle over a mocked client. | — |
| `modules/storage/sftp/connection.test.ts` | 1 product | Auth config validated *before* connecting (an empty password never reaches the wire), and `basePath` verified as existing, a directory and writable — with the write-test marker cleaned up. | — |
| `modules/storage/sftp/integration.test.ts` | 1 product / 4 environment (~80/20) | Drives a real in-process SSH server (`test/sftpServer.ts`) through password and private-key auth including a passphrase. Self-contained; no external service. | For the environment share: the three mocked sftp suites cover the logic. This file is what proves the auth options are wired correctly against a real server. |
| `modules/storage/sftp/pages.test.ts` | 1 product | Remote page path construction, locale namespacing and the content-type extension mapping. | — |
| `modules/storage/sftp/storage.test.ts` | 1 product | The module's declared handler set and `validateConfig`. | — |

### `backend/tasks/` — 18 files

Scheduled and CLI jobs. The four `*.test.ts` files that assert a CLI entry point is *not* imported
by `index.ts`/`worker.ts` and *not* under `tasks/simple/` are a distinct small cluster: they gate a
real defect (the scheduler auto-discovers `tasks/simple/` by filename, so a CLI dropped there would
be run on a cron) but they do it by grepping source text.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `tasks/migrate.test.ts` | 1 product / 3 restatement (~50/50) | "`migrate.ts` is not under `tasks/simple/`" gates a real accident — the scheduler would run the migration CLI on a cron. The "declares the npm script" test restates `package.json`. | For the npm-script half: nothing. The isolation half has no other gate. |
| `tasks/promote-admin.test.ts` | 1 product / 3 restatement (~50/50) | Same shape, for the admin-promotion CLI. Running that on a cron would be worse. | Same. |
| `tasks/promoteAdminRuntime.db.test.ts` | 1 product | DB-backed: refuses to promote the guest/system account, preserves existing memberships, and throws when the Administrators group cannot be resolved. A privilege-granting operation. | — |
| `tasks/simple/check-version.test.ts` | 1 product | Does nothing in offline mode, and the release fetch carries an `AbortSignal`. Offline mode is a hard requirement; an unbounded fetch hangs a scheduler worker. | — |
| `tasks/simple/dispatch-storage.test.ts` | 1 product | DB-backed: the handler runs inside `withLock` keyed by target id, a failure still releases the lock, and `recordSuccess` happens *after* the lock rather than inside it — the #2243 deadlock regression. | — |
| `tasks/simple/import-content.test.ts` | 1 product | Caches are reloaded and a rebuild queued exactly once on success and not at all on failure, and the upload is deleted even when a post-import side effect throws. | — |
| `tasks/simple/notify-event-subscribers.test.ts` | 1 product | One failed send does not stop the batch, and each subscriber is mailed in their own locale. | — |
| `tasks/simple/notify-event-subscription-subscribers.test.ts` | 1 product | Same batch-isolation guarantee for the second subscription mechanism. Substantially overlaps the file above in shape. | — |
| `tasks/simple/notify-page-watchers.test.ts` | 1 product | The `read:pages` re-check before an immediate send (#2173), and that a digest-mode watcher is deliberately not re-checked here. A notification leak otherwise. | — |
| `tasks/simple/purge-content-sync-state.test.ts` | 1 product | DB-backed: removes only rows whose page no longer exists. An over-broad purge forces a full re-sync of every target. | — |
| `tasks/simple/purge-page-watch-events.test.ts` | 1 product | DB-backed: retention-window boundary, regardless of delivery state. | — |
| `tasks/simple/purge-user-keys.test.ts` | 1 product | DB-backed: removes only the expired key. Purging a live one invalidates an in-flight password reset. | — |
| `tasks/simple/replication-import.test.ts` | 1 product | Same post-import cache/rebuild contract as `import-content`, for the replication path. | — |
| `tasks/simple/replication-pull.test.ts` | 3 restatement | Two tests: the task calls the model, and rethrows if the model throws. Restates a three-line delegation. | `models/replication.test.ts` covers `pull()` itself. |
| `tasks/simple/replication-tick.test.ts` | 3 restatement | Same shape, for `tick()`. | `models/replication.test.ts` covers `tick()` itself, including the cron logic. |
| `tasks/simple/send-watch-digests.test.ts` | 1 product | Per-(user, site) grouping, the `read:pages` re-check excluding an event from the digest while still marking it delivered, and a group with nothing readable skipped entirely. | — |
| `tasks/simple/update-locales.test.ts` | 1 product | DB-backed: offline mode is honoured, every fetch carries an abort signal, a non-flat strings payload is rejected before insert, and the cache reload is broadcast exactly once. | — |
| `tasks/verify-migration.test.ts` | 1 product / 3 restatement (~50/50) | Same CLI-isolation shape as `migrate.test.ts`. | Same. |

### `backend/scripts/` — 4 files

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `scripts/audit-site-scoped-rules.test.ts` | 1 product | The deploy-time audit's rule filter and report format. A missed site-scoped rule is a permission surprise on a real deployment. | — |
| `scripts/blockLocaleKeys.test.ts` | 1 product | The vue-i18n hazard detector (empty placeholders, unbalanced braces, linked-message `@:` syntax) plus a live drift check of the real `blocks/` tree against `locales/en.json`. A hazardous string breaks rendering for every reader in that locale. | — |
| `scripts/seed-rtl-test-locale.test.ts` | 1 product / 3 restatement (~60/40) | "Only uses keys that actually exist in the real `en.json`" and the CLDR RTL resolution (including the no-`.textInfo` fallback) are real; "every string is hand-translated, not copy-pasted" and "every string is non-empty" restate the fixture. | For the fixture-shape half: nothing. The fixture is only read by `e2e/rtl.spec.js`, which would fail visibly. |
| `scripts/verify-arm64-manifest.test.ts` | 1 product | Excluding attestation sub-manifests (`architecture: "unknown"`) from the platform list, and a single-platform image yielding an empty list rather than throwing. Both are real parse bugs against a real registry response shape. | — |

### `backend/test/` — 40 files

Two very different populations share this directory.

**The harness's own coverage** (6 files) plus **two round-trip suites that genuinely have no
co-located home** (`blockUploadServing`, `replicationRoundTrip`) plus `websocketOrigin` — 9 files
that belong here by `CLAUDE.md`'s own rule.

**Thirty-one documentation and CI-config consistency scans**, which are the largest single
category-3 block in the workspace. See [the documentation-scan set](#the-documentation-scan-set)
below for the consolidated position and the full list; the rows are here.

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `test/arm64NativeDeps.test.ts` | 3 restatement | Asserts the lockfile's install-script and native-binary set is exactly the five known packages. Restates a lockfile fact. | Nothing automated. The failure it anticipates — a prod `npm ci --omit=dev` running an unexpected install script, or sharp having no arm64 prebuild — surfaces as a broken container build, loudly. |
| `test/blockUploadServing.test.ts` | 1 product | DB-backed: a custom block uploaded through `api/blocks.ts` is served byte-identically by `controllers/blocks.ts`, and a cross-site id 404s. The round trip neither file's own suite can see. | — |
| `test/builders.test.ts` | 3 restatement | Tests the fixture builders. | Nothing — and per the harness exemption above, that is the point: a silent break in `makeGroupRule`/`makeActor` would weaken every permission suite without failing anything. **Not a pruning candidate.** |
| `test/changelog.test.ts` | 4 environment | Shells out to a real `git-cliff` binary against real repository history. Correctly `{ skip: !hasGitCliff() }`, so it is skipped everywhere by default. Passes or fails on the tool and the commit log, not the code. | Nothing. What it protects is that `cliff.toml`'s `commit_parsers` still categorise this repo's commits — a release-notes formatting concern, discovered at release time by reading the generated notes. |
| `test/dependabot-config.test.ts` | 3 restatement | Asserts `.github/dependabot.yml` has exactly five entries covering exactly the four workspaces. | Nothing. A missing workspace means that workspace stops getting dependency PRs — noticed within a release cycle. |
| `test/devcontainerDatabaseUrl.test.ts` | 3 restatement | Asserts the devcontainer compose file declares a `DATABASE_URL` on the right port and that the README says so. | Nothing. A wrong value breaks a developer's container on first boot, visibly. **Note for #2684**: this file reads `.devcontainer/`, which #2684 owns and is rewriting — it may need updating there. |
| `test/devcontainerPuppeteerVersion.test.ts` | 3 restatement | Asserts `app-init.sh` contains no literal Puppeteer version. A removal guard for a pin that was deleted. | Nothing. Same #2684 note as above. |
| `test/dockerfile.test.ts` | 3 restatement | Asserts the production Dockerfile declares the right `VOLUME`, `EXPOSE` and `HEALTHCHECK`, and none of three stale 2.x paths. | Nothing automated. A wrong healthcheck or volume surfaces on the first container deploy. |
| `test/dockerfilePuppeteerInstall.test.ts` | 3 restatement | Asserts the Dockerfile has no bare `npm install` and that the lockfile's puppeteer subtree is hash-checked. The "no bare `npm install`" assertion has a real supply-chain rationale. | Nothing. The supply-chain half is the only part worth keeping and is one assertion, not eight. |
| `test/docs-claude-md-fixme-bullet.test.ts` | 1 product / 3 restatement (~40/60) | The three permission-list assertions cross-check `CLAUDE.md` against `helpers/permissions.ts` and `helpers/siteRules.ts` — real, though `helpers/permissions.test.ts` already pins the vocabularies. The three "the bullet still exists and says X" tests are prose linting. | For the prose half: nothing. For the permission half: `helpers/permissions.test.ts`. |
| `test/docs-config-sample.test.ts` | 3 restatement | Asserts `config.sample.yml`'s comment header documents four things. | Nothing. An operator reading an incomplete comment misconfigures once. |
| `test/docs-markdown-syntax.test.ts` | 1 product / 3 restatement (~40/60) | "Each documented class still exists as a real selector in `_page-contents.scss`" is a genuine cross-file drift check with a user-visible failure (a documented class that does nothing). The rest asserts the doc says what it says. | For the drift half: nothing — this is the only place the doc and the stylesheet are compared. |
| `test/docs-tls-story.test.ts` | 3 restatement | Asserts a deleted admin page stays deleted, its locale strings stay removed, and a decision doc says particular things. | For the deletion guards: nothing, though a resurrected `AdminSsl.vue` would fail `frontend/`'s own suites. For the prose: nothing. |
| `test/docs-todo-fixme-audit.test.ts` | 3 restatement | Asserts one comment in `types/global.d.ts` no longer makes a stale claim. Three tests about the wording of a code comment. | Nothing. |
| `test/docs-todo-fixme-drift.test.ts` | 3 restatement | Scans `backend/` and `frontend/src/` for TODO/FIXME markers and asserts every one is named in `docs/variances.md`, and that deferral phrasings stay inside a closed vocabulary. | Nothing. This is a real and deliberate process discipline, not a product gate; #2689 should decide whether process discipline belongs in the test suite at all — that is the central question this whole block raises. |
| `test/docs-variances.test.ts` | 3 restatement | Asserts `docs/variances.md`'s header contains particular sentences and that every entry is a `##` heading. Prose linting of a process document. | Nothing. |
| `test/e2e-workflow.test.ts` | 3 restatement | Asserts `e2e.yml` narrows its token permissions and does not persist credentials. The rationale is genuinely a security one — but it is asserted by reading YAML, and the real enforcement is GitHub's. | Nothing automated. A widened token is a review-time catch. |
| `test/fastify.test.ts` | 3 restatement | Tests `buildTestApp` itself: the real permission hook refuses, `session: 'header'` seeds, `closeTestApp` restores the previous `WIKI`. | Nothing — **harness exemption**. A silent break here would make hundreds of route suites pass while gating nothing. **Not a pruning candidate.** |
| `test/localazy-config.test.ts` | 3 restatement | Asserts `localazy.json`'s upload/download folders resolve to the real locales directory. | Nothing. A wrong path breaks a translation sync, discovered on the next sync. |
| `test/lockfile-integrity.test.ts` | 3 restatement | Asserts every lockfile entry carries `resolved` + `integrity`. Real supply-chain rationale, asserted by reading a file `npm ci` already enforces. | `npm ci` itself refuses a lockfile entry with no integrity hash. This restates a guarantee the package manager already gives. |
| `test/mcp-getting-started-doc.test.ts` | 1 product / 3 restatement (~40/60) | "The documented tool list matches `registerAllTools()` 1:1, not a stale subset" is a genuine drift check against code. The other eleven tests assert the doc covers particular topics. | For the drift half: nothing. For the topic-coverage half: nothing, and the loss is an incomplete onboarding doc. |
| `test/migration-export-bundle-doc.test.ts` | 3 restatement | Asserts a migration spec doc enumerates every output file, entity and batch limit found in the vendored 2.x source. | Nothing. This one has more real content than most doc scans — it is comparing the doc against vendored source — but the failure is a stale spec, not a bug. |
| `test/migration-field-mapping-doc.test.ts` | 3 restatement | Same shape: the field-mapping doc's summary table is compared against the vendored 2.x `saveToDb` call sites. | Nothing. The mappers themselves are gated by `migration/mappers/*.test.ts`, which is where the actual behaviour lives. |
| `test/migration-mapping-doc.test.ts` | 3 restatement | Same shape, for the table-by-table mapping doc. | Nothing, same reasoning. |
| `test/migration-runbook-doc.test.ts` | 3 restatement | Asserts the runbook names real npm scripts and real CLI flags. The "names real flags" half is a genuine drift check against `migration/cli.ts`. | For the flag-drift half: `migration/cli.test.ts` covers what the flags actually are; nothing cross-checks the doc. An operator following a stale runbook gets an unknown-flag error, loudly. |
| `test/migration-schema-doc.test.ts` | 3 restatement | One assertion: the source-schema doc covers every target table. | Nothing. |
| `test/migration-source-scope-decision.test.ts` | 3 restatement | Asserts a decision record states its decision, and that `package.json` declares only `pg` as a driver. | The `pg`-only half is a real dependency-drift check with nothing else covering it; the rest is prose. |
| `test/migrationFixtures.test.ts` | 3 restatement | Tests the migration fixture builders and `LEGACY_SCHEMA_DDL`. | Nothing — **harness exemption**, same as `builders.test.ts`. `LEGACY_SCHEMA_DDL` is what every migration integration suite stands its source schema up from. **Not a pruning candidate.** |
| `test/mocks.test.ts` | 3 restatement | Tests `createWikiStub`/`installTestWiki`: the deep-merge semantics, the empty-`models` default, and restore behaviour. | Nothing — **harness exemption**. The deep-merge semantics in particular are subtle enough that every suite relying on them would misbehave silently. **Not a pruning candidate.** |
| `test/operations-doc.test.ts` | 1 product / 3 restatement (~30/70) | "Does not claim any `dataPath` subdirectory beyond the ones models actually populate" is a real drift check against the models. The other 35 assertions check that an operations doc mentions particular topics. | For the `dataPath` drift half: nothing. For the rest: nothing, and the loss is an operations doc that has drifted — real, but a docs concern. This is the single largest doc scan at 38 assertions. |
| `test/postgres-version-consistency.test.ts` | 3 restatement | Asserts four service definitions pin the same Postgres major. A genuine cross-file drift check with a real (if loud) failure mode. | Nothing. A mismatch surfaces as a migration failing on one environment and not another — which is exactly the kind of thing #2601's parity work exists to make impossible structurally rather than by assertion. Worth revisiting once #2684 lands. |
| `test/readme-admin-env-doc.test.ts` | 1 product / 3 restatement (~30/70) | "Cross-checks against the real seeding behavior in `models/users.ts`" is a drift check; the other eight assert the README has a section saying particular things. | For the drift half: nothing. For the rest: nothing. |
| `test/readme-generic-setup-doc.test.ts` | 3 restatement | Twelve assertions that the README does not name a non-existent workspace, does not say "Quasar", tells the reader to run `node backend`, and so on. | Nothing. A stale README is a first-run friction, caught by the next person who follows it. |
| `test/release-checklist-doc.test.ts` | 3 restatement | Twenty-three assertions that a checklist attributes each item to the right work package and phrases it a particular way. Pure process-document linting. | Nothing. |
| `test/release-workflow.test.ts` | 1 product / 3 restatement (~40/60) | "All hard-required quality gates run BEFORE the Docker publish step (fail closed)" and "fails closed when the tag is not on `scarlett`" are genuine release-safety invariants that a YAML reordering would silently break. The rest restates the workflow. | For the fail-closed half: nothing — and this is the strongest case in the whole doc-scan block for keeping a scan. For the rest: nothing. |
| `test/releasing-doc.test.ts` | 3 restatement | Fifteen assertions that a runbook contains particular commands and steps, including "is under 250 lines." | Nothing. |
| `test/replicationRoundTrip.db.test.ts` | 1 product | DB-backed: a real scheduled pull builds a snapshot from a source instance and mirrors it into a target, wiping the target first. Spans two models against two real databases; neither model's own suite can see it. | — |
| `test/routeRecorder.test.ts` | 3 restatement | Tests the route recorder, including that it *replays* a registered sub-plugin rather than no-oping it. | Nothing — **harness exemption**, and the strongest case of the six: a no-op `register` would make every route in a split resource invisible while `routeTags`/`responseErrors`/`apiKeySite.coverage` all still passed green. **Not a pruning candidate.** |
| `test/sourceFiles.test.ts` | 3 restatement | Tests the recursive source walker (`node_modules` skipped, extension filtering). | Nothing — **harness exemption**. A walker that silently skips a directory makes every source-scanning suite pass vacuously. **Not a pruning candidate.** |
| `test/websocketOrigin.test.ts` | 1 product | A foreign `Origin` is rejected by `verifyClient` *before* the controller handler runs, for both the terminal and collab sockets, while another site on the same instance is accepted. Cross-site WebSocket hijacking. | — |

### `backend/` root, `db/`, `locales/` — 6 files

| path | category | one-line reason | what gates this behaviour if the file goes away |
| --- | --- | --- | --- |
| `base.test.ts` | 1 product / 3 restatement (~50/50) | "`base.yml` does not define a default `auth.secret`" is a real and serious invariant — a shipped default signing secret would make every instance's cookies forgeable. "Declares an explicit, positive `pool.max`" is likewise real (the node-postgres default is 10). The two "has no top-level `ssl`/`channel`/`maintainerEmail`" tests are removal guards restating the YAML. | For the removal-guard half: nothing. The two real invariants have no other gate and should survive. |
| `dev-setup-script.test.ts` | 3 restatement / 4 environment (~70/30) | Asserts `dev/setup.sh` sets `-e -u -o pipefail`, installs four workspaces and builds two — and shells out to `bash -n` for a syntax check, which is what makes the environment share real (it needs a `bash` on `PATH`, ungated). | Nothing. A broken setup script fails on first use by a new contributor, loudly. The `bash -n` call is the one ungated external-binary dependency in the workspace — see the category-4 list. |
| `index.test.ts` | 1 product | The boot sequence calls `setReady()` only after all three phases and as the final statement (a premature ready flips the container healthcheck green on a half-booted process), plus which hooks fire on which path and a failing `dbManager.init()` exiting non-zero. | — |
| `db/schema.test.ts` | 1 product / 3 restatement (~55/45) | The FK cascade/nullify assertions are real data-integrity behaviour that the migration files alone do not make obvious (a `replyTo` self-reference that does not cascade orphans every reply). The "is named X", "has an id primary key" and index-listing assertions restate `schema.ts` line for line. | For the restatement half: `schema.ts` is the declaration and `db/migrations/` is the applied truth; a drift between them is caught the first time a migration runs. The cascade half is genuinely worth keeping and would be better expressed as a DB-backed test that deletes a row and observes the cascade. |
| `locales/en-admin-measurement-labels.test.ts` | 3 restatement | Asserts three admin titles read particular English strings. | Nothing. This is a translation-source file; the strings are Localazy-managed and reviewed there. |
| `locales/en.test.ts` | 3 restatement | Asserts `en.json` has no duplicate keys, is alphabetically sorted, and that four removed key clusters stay removed. A lint of a data file plus four removal guards. | Nothing. A duplicate key is a JSON-parse-order accident that the sort assertion would catch — but so would a formatter. The removal guards protect against resurrecting dead keys, which nothing else does. |

## Category 4 as a flat list

Everything classified as category 4 (**environment**), primary or as a named share.
**This is #2691's quarantine candidate set** — it is produced nowhere else in the Epic tree.

| path | primary? | precondition | already gated? |
| --- | --- | --- | --- |
| `test/changelog.test.ts` | yes | the `git-cliff` binary, plus real repository history | yes — `{ skip: !hasGitCliff() }` |
| `modules/search/elasticsearch/search.smoke.test.ts` | yes | a live Elasticsearch cluster at `ELASTICSEARCH_TEST_URL` | yes — `{ skip: !hasElasticsearch() }` |
| `dev-setup-script.test.ts` | share (~30%) | a `bash` on `PATH` (for `bash -n`) | **no** |
| `models/import.test.ts` | share (~10%) | the `pandoc` binary on `PATH` | yes — `{ skip: !pandocAvailable }` |
| `modules/storage/s3/storage.emulated.test.ts` | share (~20%) | a bindable local port and a writable temp directory (`s3rver`, in-process) | no gate, and none needed — self-contained |
| `modules/storage/sftp/integration.test.ts` | share (~20%) | a bindable local port (an in-process SSH server) | no gate, and none needed — self-contained |

Two things #2691 should take from this rather than re-derive:

1. **Category 4 is small and almost entirely already contained.** Only one file (`dev-setup-script`)
   depends on an external binary without a gate, and `bash` is present everywhere this project runs.
   There is no large pool of environment-flaky suites in `backend/` waiting to be quarantined.
2. **The real environment dependency in this workspace is Postgres, and it is not category 4.** The
   79 DB-backed suites pass or fail on the *code*, not the runtime; the database is a fixture, and
   the `hasTestDatabase()` gate is what keeps them out of category 4. If #2691's quarantine lane is
   meant to catch genuinely non-deterministic suites, the candidates are the concurrency-sensitive
   DB and collab suites (`models/approvals.lifecycle`, `models/rateLimits`,
   `core/scheduler.reaping.db`, `core/collab.crossInstance.db`), none of which is category 4 and
   none of which is known-flaky today. **Do not read this list as "these are flaky."**

There are, notably, **no clock-dependent category-4 rows**. Several suites go out of their way to
prove the opposite — `models/contentSync`, `models/jobs`, `models/userCredentials.tokens` and
`core/scheduler.reaping.db` each assert identical behaviour under UTC and a non-UTC process `TZ`.
That is a deliberate, already-paid-for defence, and it is why the clock does not appear here.

## The documentation-scan set

The consolidated list backing the position stated above. **35 files**: 31 under `backend/test/`,
plus `dev-setup-script.test.ts`, both `locales/en*.test.ts`, and
`modules/authentication/providerPresetAudit.test.ts`, which is a doc scan sitting in a module
directory.

```
backend/test/arm64NativeDeps.test.ts
backend/test/changelog.test.ts                        (also category 4)
backend/test/dependabot-config.test.ts
backend/test/devcontainerDatabaseUrl.test.ts          (reads .devcontainer/ — see #2684)
backend/test/devcontainerPuppeteerVersion.test.ts     (reads .devcontainer/ — see #2684)
backend/test/dockerfile.test.ts
backend/test/dockerfilePuppeteerInstall.test.ts
backend/test/docs-claude-md-fixme-bullet.test.ts
backend/test/docs-config-sample.test.ts
backend/test/docs-markdown-syntax.test.ts
backend/test/docs-tls-story.test.ts
backend/test/docs-todo-fixme-audit.test.ts
backend/test/docs-todo-fixme-drift.test.ts
backend/test/docs-variances.test.ts
backend/test/e2e-workflow.test.ts
backend/test/localazy-config.test.ts
backend/test/lockfile-integrity.test.ts
backend/test/mcp-getting-started-doc.test.ts
backend/test/migration-export-bundle-doc.test.ts
backend/test/migration-field-mapping-doc.test.ts
backend/test/migration-mapping-doc.test.ts
backend/test/migration-runbook-doc.test.ts
backend/test/migration-schema-doc.test.ts
backend/test/migration-source-scope-decision.test.ts
backend/test/operations-doc.test.ts
backend/test/postgres-version-consistency.test.ts
backend/test/readme-admin-env-doc.test.ts
backend/test/readme-generic-setup-doc.test.ts
backend/test/release-checklist-doc.test.ts
backend/test/release-workflow.test.ts
backend/test/releasing-doc.test.ts
backend/dev-setup-script.test.ts
backend/locales/en-admin-measurement-labels.test.ts
backend/locales/en.test.ts
backend/modules/authentication/providerPresetAudit.test.ts
```

**~4,600 test LOC, ~350 assertions, and not one of them can fail on a product defect.**

Six of the 35 carry a genuine cross-file drift check embedded among the prose assertions, and those
checks have no other gate. Named explicitly so #2690 does not lose them along with the rest:

| file | the assertion worth keeping |
| --- | --- |
| `test/mcp-getting-started-doc.test.ts` | the documented tool list matches `registerAllTools()` 1:1 |
| `test/operations-doc.test.ts` | no `dataPath` subdirectory is claimed beyond the ones models actually populate |
| `test/docs-markdown-syntax.test.ts` | every documented class exists as a real selector in `_page-contents.scss` |
| `test/readme-admin-env-doc.test.ts` | the documented default admin credentials match `models/users.ts`'s seeding |
| `test/release-workflow.test.ts` | every hard-required quality gate runs before the Docker publish, and a non-`scarlett` tag fails closed |
| `test/migration-source-scope-decision.test.ts` | `package.json` declares only `pg` as a database driver |

## What this audit does not decide

Left deliberately open for #2689 and #2690, with the evidence but not the verdict:

- **Whether process discipline belongs in the test suite.** `docs-todo-fixme-drift`,
  `docs-variances` and `release-checklist-doc` enforce real project conventions through `node --test`
  because there is nowhere else to put them. That is a policy question, not a per-file one.
- **Whether `*.db.test.ts` should be applied to all 79 or retired.** Finding 1 above states the
  problem; the fix is a convention change and belongs in the policy.
- **Whether the two 3,000-line model suites should be split.** Both are category 1 and neither
  should shrink in coverage; that is a reviewability question, not a value one.
- **Any deletion.** This document records what each file gates and what would gate it instead. It
  authorises nothing.

## Post-pruning re-measurement (OpenProject #2690)

Re-measured with `node docs/testing-audit/metrics.mjs` immediately before and after #2690's pass,
both on branch `wp-2690-prune-backend-suite` at the same commit (`b975f7b4c`) this audit's own
figures above were corrected against:

| | before | after | change |
| --- | ---: | ---: | ---: |
| test files | 419 | 378 | −41 |
| test LOC | 134,188 | 130,019 | −4,169 |
| test cases | 5,965 | 5,696 | −269 |
| test LOC / source LOC | 1.27 | 1.23 | −0.04 |
| DB-backed suites | 81 | 81 | unchanged |
| suites scanning repo files | 36 | 18 | −18 |

Per Epic #2600's second direction, stated plainly rather than left to be inferred: **this pass did
not, and was never going to, bring `backend/`'s test-LOC-to-source-LOC ratio below 1** — the parent
Feature's resolved scope is explicit that a target ratio is the same volume-as-a-proxy-for-quality
error the policy exists to correct, and `docs/decisions/testing-strategy.md`'s rollup found 85% of
the suite to be category-1 product behaviour with nothing to prune. The reduction above is real
(41 files, ~3% of test LOC, and the repo-file-scanning population exactly halved — the
documentation-scan set was where the volume without value actually lived) but bounded: #2690's own
scope note (posted as the work package's implementation-plan comment) records that this pass covered
the unambiguous, "nothing gates it" verdicts and the two named recurring restatement shapes
(documentation scans, `definition.yml`-prop-declaration), not the full ~106-row restatement surface
the audit found. A second pass over the remaining mixed-percentage `api/`/`models/` rows is left to
a follow-up work package if the parent Feature wants one; this note exists so that possibility isn't
silently foreclosed by reading this pass as exhaustive.
