# Wiki.js 3.0 Epic Roadmap — Design

**Date:** 2026-08-16
**Status:** Approved pending final user review
**Scope of this document:** the top-level OpenProject epic breakdown for finishing the `scarlett` branch
(Wiki.js 3.0) to beat feature parity with Wiki.js 2.5.x, plus a migration path from 2.5.x. Feature- and
task-level breakdown is explicitly out of scope here — that happens per-epic, later, via the OpenProject
workflow lifecycle described below.

## Why this exists

`scarlett` is the multi-year 3.0 working branch of requarks/wiki. It has substantial unmerged/unreleased
work, is buggy and unstable, and has whole subsystems that are stubbed or missing. The upstream maintainer
has been slow to move it forward. The plan: bring this fork to a state that meets or exceeds Wiki.js 2.5.x
(the latest stable 2.x release, 2.5.314) feature-for-feature, with a simple migration path from 2.5.x, then
publish it — either to pressure upstream into re-engaging, or to stand alone as the department's
self-maintained fork.

Two constraints from the requester, both binding on every epic below:

1. **Match or exceed/transform 2.5.x's spirit.** Where 3.0 already does something 2.5.x never could
   (multi-site, the Blocks system), that ambition gets finished and hardened — not abandoned in favor of
   parity-only scope.
2. **A simple migration path from 2.5.x must exist.** Not "theoretically possible" — an actual tool/process
   a department running 2.5.x can use to move.

## How the epics were derived

Two research passes (full reports available in this session's transcript, not reproduced here) grounded the
breakdown instead of guessing:

- **2.5.x baseline** — primary-source research (WebSearch/WebFetch against docs.requarks.io, github.com/requarks/wiki,
  js.wiki) covering editor, content/pages, navigation, search, auth/permissions, admin, storage sync targets,
  comments, localization, theming, API, and deployment. Confirmed 2.5.x is single-site only, and that its
  two-tier permission model (global permissions + path-scoped page rules) is the same shape this repo's
  CLAUDE.md documents for 3.0 — a straight carryover, not new territory.
- **3.0 current-state survey** — direct repo inspection (schema, routes, modules, FIXMEs) across the same
  subsystem groupings, verifying claims against actual code rather than trusting CLAUDE.md's prose alone.

Headline findings that shaped epic boundaries:

- **Comments are entirely absent** from 3.0: no `comments` table, no model, no API route. `AdminComments.vue`
  exists but has nothing to talk to. Big enough, and cross-cutting enough (its own permission verbs
  `read:comments`/`write:comments`/`manage:comments` already exist in the permission model), to be its own epic.
- **Storage sync is 100% unimplemented**: 7 target modules are defined (`azure`, `db`, `disk`, `gcs`, `git`,
  `s3`, `sftp`) but `models/storage.ts`'s own `hasImplementation()` check would fail for every one — zero
  `storage.ts` files exist. This is the single largest gap against 2.5.x, which has working Git bidirectional
  sync plus several push-only cloud targets.
- **Auth is comparatively solid** (local/github/google/oidc all have real implementations) but is missing
  several 2.5.x providers (LDAP, SAML, CAS, Auth0, Okta) and 2FA.
- **Blocks (19 components) and multi-site are 3.0-native capabilities 2.5.x never had.** These are where
  "exceed/transform" actually lives and need their own epics so they don't get deprioritized as
  parity work gets scoped.
- Five concrete known bugs surfaced (`sites.ts` using `req.querystring` instead of `req.query`,
  `config.ts` calling `.trim()` on a Promise, two `scheduler.ts` FIXMEs around `cron-parser` and
  `useWorker`, plus three frontend files still on dead `APOLLO_CLIENT` calls) — enough to warrant a
  dedicated stabilization epic rather than trusting each subsystem epic to self-report its own bugs.

## The 14 epics

Subsystem-based grouping: it maps predictably onto both 2.5.x's own feature areas and this codebase's
actual layout (`backend/api/*`, `backend/modules/*`, `frontend/src/pages/*`), which keeps each epic small
enough to drive through the `epic-lifecycle` workflow independently once its turn comes.

| # | Epic | Scope |
|---|------|-------|
| 1 | **Editing & Authoring Experience** | Markdown editor, WYSIWYG, plain HTML editor, diagrams (Mermaid-style), math (TeX/MathML) rendering. Largely implemented already (`Editor*.vue`, Monaco boot, markdown renderer pipeline); this epic verifies parity and closes gaps rather than building from scratch. |
| 2 | **Content, Versioning & Review Workflow** | Page CRUD, version history with diff/comparison, page export, the approvals/review workflow (`pageEditSubmissions`), page watching. Backend is substantial already (`api/pages.ts`, `api/approvals.ts`); focus is verifying diff/export UX and closing edge cases. |
| 3 | **Navigation** | Nav/sidebar builder and its admin UI. `AdminNavigation.vue` is one of the three files still on dead GraphQL calls — porting it to REST is in-scope here, not a separate cleanup epic. |
| 4 | **Search** | DB-based search parity plus pluggable external engines (2.5.x supports Algolia, Azure Search, Elasticsearch, AWS CloudSearch). `models/search.ts` exists; this epic verifies what's actually wired today and fills the gap to multi-engine support. |
| 5 | **Users, Auth & Permissions** | Fill out auth provider modules beyond the existing local/github/google/oidc (LDAP, SAML, CAS, Auth0, Okta as warranted), add 2FA, and port the self-registration flow (`AuthLoginPanel.vue`) off its dead GraphQL call to REST. |
| 6 | **Storage & Asset Sync Targets** | Implement actual read/write for the 7 currently-config-only storage targets (git, s3, azure, gcs, disk, sftp, db) — the largest concrete gap found. Likely needs its own priority order (e.g. disk/db first as they gate basic asset serving, git next for parity with 2.5.x's flagship sync feature). |
| 7 | **Comments** | Build the subsystem from scratch: schema, model, REST API, and wiring `AdminComments.vue` to something real. Default provider governed by the existing group-permission verbs, matching 2.5.x's default (non-external) comment behavior. External providers (Disqus/Commento-equivalent) are a stretch goal, not required for parity. |
| 8 | **Admin & System Management** | Site settings, mail config, logs, utilities (`AdminUtilities.vue` is the third dead-GraphQL file — ported here), and the two `scheduler.ts` bug fixes (`cron-parser` return type, ignored `useWorker` option) as they're admin/scheduler-adjacent. |
| 9 | **Localization & Theming/Branding** | Verify locale/RTL parity against 2.5.x's 40+ languages (the Localazy pipeline and `locales` table already exist — this is largely a verification pass), plus custom CSS/JS injection and branding assets, extended to 3.0's per-site theming model. |
| 10 | **Extensibility Platform: Blocks & Modules** | Harden and finish the 19-component Blocks system (3.0-native, no 2.5.x equivalent) and verify/implement the `modules/extensions/*` (git, pandoc, puppeteer, sharp) implementations, which were flagged unverified in the survey. This is 3.0's actual plugin-extensibility story and the clearest "exceeds 2.5.x" epic. |
| 11 | **Multi-Site Platform** | Finish and harden multi-site (`sites` table, `WIKI.sites`/`sitesMappings`, `AdminSites.vue`, `AdminInstances.vue`) — a capability 2.5.x never had at all. Ensures every other epic's work is correctly scoped per-site rather than instance-wide where it matters (theming, storage, auth). |
| 12 | **API, Webhooks & Integrations** | Round out REST API completeness/documentation (Swagger already exists), webhook support (`api/hooks.ts` exists — verify scope), and API token scoping — the REST-era answer to 2.5.x's GraphQL API surface. |
| 13 | **Migration & Upgrade Path from 2.5.x** | Dedicated epic per the department's hard requirement: tooling to import 2.5.x content, users, groups, assets, and settings into 3.0's schema, plus cutover documentation. Kept separate from functional epics so it's independently trackable and testable, per earlier design decision. |
| 14 | **Stabilization, QA & Release Readiness** | The five known bugs found in the survey that don't belong to a specific feature epic, a zero-warnings/zero-errors enforcement pass (per this repo's CLAUDE.md standard), test coverage gaps, and `variances.md` discipline across the whole branch. |

## How epics turn into features and tasks (the "workflow")

This is what the requester meant by "workflow" — not something to design, but an existing mechanism in the
`openproject-mcp` server (`src/workflow/`, exposed via the `get_workflow_state` MCP tool). Two built-in
lifecycle skills apply here:

- `epic-lifecycle` (applies to Epics): **wayfinder → spec → breakdown → implementation → review → release**
- `feature-lifecycle` (applies to Features, one level down): same six steps

Step completion is mechanical, evaluated against live OpenProject state:

| Step | Completion check |
|------|-------------------|
| wayfinder | description is non-blank |
| spec | status has reached at least "Specified" |
| breakdown | has at least one child at the next level down |
| implementation | has at least one such child, and all are closed |
| review | status has reached at least "Tested" |
| release | status has reached "Closed" |

**This session's deliverable is exactly the 14 epics, each satisfying `wayfinder`** (every epic below gets a
real description, not a placeholder — see the table above). Nothing beyond that runs now. "Child items should
be developed as part of the workflow completing each epic in turn" means: a future session picks one epic,
calls `get_workflow_state` to confirm it's sitting at `spec`, moves it through spec (fleshing out the
description, transitioning status to "Specified"), then `breakdown` (creating Features under it — this is
where the next round of research/design happens, scoped to that one epic), and so on through
implementation/review/release — before moving to the next epic. Epics are not required to be worked strictly
in the table's order; dependency relationships (`set_relationship` with `kind: blockedBy`) between epics are
deliberately **not** set up in this pass — that's a judgment call better made once each epic has an actual
spec, not before.

## What this session actually does

1. ~~Create a new OpenProject project~~ — done manually by the requester, since `openproject-mcp`'s Project
   Tools group is read-only (`list_projects` only; no `create_project` tool exists, confirmed by reading
   `src/mcp/tools/projects.ts` directly). Per this repo's CLAUDE.md, that gap doesn't get routed around with
   a raw API call — it's a real missing capability in that MCP server, worth a future feature request there.
   Project identifier: **`wiki-js-3-0`** (name "Wiki.js 3.0", id 8), confirmed via `list_projects`.
2. Create all 14 epics under that project via `create_work_package` (`level: "epic"`), each with the
   description text from the table above (satisfies `wayfinder` on creation).
3. Verify with `get_workflow_state` (`skillId: "epic-lifecycle"`) that each epic correctly reports
   `currentStep: "spec"` with `nextStep: "breakdown"` — confirming wayfinder is satisfied and nothing further
   was accidentally triggered.

No Features, Tasks, status transitions beyond creation, or inter-epic relationships are created in this pass.
