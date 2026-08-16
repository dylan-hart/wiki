# Wiki.js 3.0 Epic Creation Implementation Plan

> **For agentic workers:** This plan creates OpenProject work packages via MCP tool calls — there is no
> code, no tests, no git commits. Execute tasks in order in a single session; no subagent dispatch or
> worktree isolation is needed, since every task is one already-fully-specified tool call against a live
> system of record (OpenProject itself), not a code change requiring independent review.

**Goal:** Create the 14 approved epics under OpenProject project `wiki-js-3-0`, each satisfying the
`epic-lifecycle` workflow's `wayfinder` step (non-blank description) on creation.

**Architecture:** Sequential `mcp__openproject__create_work_package` calls with `level: "epic"`, one per
row in the epic table from `docs/superpowers/specs/2026-08-16-wikijs-3-epic-roadmap-design.md`, followed by
one `get_workflow_state` verification call per epic.

**Tech Stack:** `openproject-mcp` MCP server tools only (`create_work_package`, `get_workflow_state`) — no
raw OpenProject API calls, per this repo's CLAUDE.md.

## Global Constraints

- Project identifier: `wiki-js-3-0` (confirmed via `list_projects`, id 8).
- Every `description` must be copied verbatim from the spec's epic table — no shortened or placeholder text,
  since a blank/near-blank description would fail the `wayfinder` step.
- No status transitions, no Features/Tasks, no `set_relationship` calls in this plan — epics are created and
  left at their default status only.

---

### Task 1–14: Create each epic

**Tool:** `mcp__openproject__create_work_package`

**Interfaces:**
- Consumes: `projectIdentifier: "wiki-js-3-0"`, `level: "epic"`, `subject`, `description` — exact text below.
- Produces: each call returns `{ id, subject, description }`; record the `id` for the verification task.

- [x] **1. Editing & Authoring Experience**
  `description`: "Markdown editor, WYSIWYG, plain HTML editor, diagrams (Mermaid-style), math (TeX/MathML) rendering. Largely implemented already (Editor*.vue, Monaco boot, markdown renderer pipeline); this epic verifies parity and closes gaps rather than building from scratch."

- [x] **2. Content, Versioning & Review Workflow**
  `description`: "Page CRUD, version history with diff/comparison, page export, the approvals/review workflow (pageEditSubmissions), page watching. Backend is substantial already (api/pages.ts, api/approvals.ts); focus is verifying diff/export UX and closing edge cases."

- [x] **3. Navigation**
  `description`: "Nav/sidebar builder and its admin UI. AdminNavigation.vue is one of the three files still on dead GraphQL calls — porting it to REST is in-scope here, not a separate cleanup epic."

- [x] **4. Search**
  `description`: "DB-based search parity plus pluggable external engines (2.5.x supports Algolia, Azure Search, Elasticsearch, AWS CloudSearch). models/search.ts exists; this epic verifies what's actually wired today and fills the gap to multi-engine support."

- [x] **5. Users, Auth & Permissions**
  `description`: "Fill out auth provider modules beyond the existing local/github/google/oidc (LDAP, SAML, CAS, Auth0, Okta as warranted), add 2FA, and port the self-registration flow (AuthLoginPanel.vue) off its dead GraphQL call to REST."

- [x] **6. Storage & Asset Sync Targets**
  `description`: "Implement actual read/write for the 7 currently-config-only storage targets (git, s3, azure, gcs, disk, sftp, db) — the largest concrete gap found. Likely needs its own priority order (e.g. disk/db first as they gate basic asset serving, git next for parity with 2.5.x's flagship sync feature)."

- [x] **7. Comments**
  `description`: "Build the subsystem from scratch: schema, model, REST API, and wiring AdminComments.vue to something real. Default provider governed by the existing group-permission verbs, matching 2.5.x's default (non-external) comment behavior. External providers (Disqus/Commento-equivalent) are a stretch goal, not required for parity."

- [x] **8. Admin & System Management**
  `description`: "Site settings, mail config, logs, utilities (AdminUtilities.vue is the third dead-GraphQL file — ported here), and the two scheduler.ts bug fixes (cron-parser return type, ignored useWorker option) as they're admin/scheduler-adjacent."

- [x] **9. Localization & Theming/Branding**
  `description`: "Verify locale/RTL parity against 2.5.x's 40+ languages (the Localazy pipeline and locales table already exist — this is largely a verification pass), plus custom CSS/JS injection and branding assets, extended to 3.0's per-site theming model."

- [x] **10. Extensibility Platform: Blocks & Modules**
  `description`: "Harden and finish the 19-component Blocks system (3.0-native, no 2.5.x equivalent) and verify/implement the modules/extensions/* (git, pandoc, puppeteer, sharp) implementations, which were flagged unverified in the survey. This is 3.0's actual plugin-extensibility story and the clearest \"exceeds 2.5.x\" epic."

- [x] **11. Multi-Site Platform**
  `description`: "Finish and harden multi-site (sites table, WIKI.sites/sitesMappings, AdminSites.vue, AdminInstances.vue) — a capability 2.5.x never had at all. Ensures every other epic's work is correctly scoped per-site rather than instance-wide where it matters (theming, storage, auth)."

- [x] **12. API, Webhooks & Integrations**
  `description`: "Round out REST API completeness/documentation (Swagger already exists), webhook support (api/hooks.ts exists — verify scope), and API token scoping — the REST-era answer to 2.5.x's GraphQL API surface."

- [x] **13. Migration & Upgrade Path from 2.5.x**
  `description`: "Dedicated epic per the department's hard requirement: tooling to import 2.5.x content, users, groups, assets, and settings into 3.0's schema, plus cutover documentation. Kept separate from functional epics so it's independently trackable and testable."

- [x] **14. Stabilization, QA & Release Readiness**
  `description`: "The five known bugs found in the survey that don't belong to a specific feature epic (sites.ts req.querystring, config.ts Promise.trim(), two scheduler.ts FIXMEs around cron-parser/useWorker), a zero-warnings/zero-errors enforcement pass (per this repo's CLAUDE.md standard), test coverage gaps, and variances.md discipline across the whole branch."

### Task 15: Verify wayfinder is satisfied for all 14

**Tool:** `mcp__openproject__get_workflow_state` (`skillId: "epic-lifecycle"`) for each of the 14 IDs recorded
above.

- [x] Call `get_workflow_state` for each epic ID.
- [x] Confirm every response is `{ currentStep: "spec", nextStep: "breakdown", unmetCondition: "Epic status has not reached \"Specified\" yet." }` (or equivalent phrasing) — i.e. `wayfinder` passed, nothing beyond creation happened.
- [x] If any epic reports `currentStep: "wayfinder"` (description was somehow blank), fix that epic's description with `update_work_package` and re-verify.

---

## Out of scope (explicitly, per the spec)

No Features, no Tasks, no status transitions past creation, no inter-epic `set_relationship` calls. Those
happen per-epic, in future sessions, when that epic's turn in the `epic-lifecycle` workflow comes up.
