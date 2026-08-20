# Per-site scoping audit

Feature [#408](../../../work_packages/408) "Cross-subsystem per-site scoping audit" walked every
table in `backend/db/schema.ts` that has **no** `siteId` column and recorded why instance-wide
scoping is (or isn't) the correct call for it. This is task
[#693](../../../work_packages/693) of that Feature.

## Scope

Excluded from the table below, because they're already settled elsewhere:

- **`sites`** itself — it's the table every `siteId` column references, not a candidate for having
  one of its own.
- Every table Feature 408's own description already confirmed carries `siteId` with a supporting
  index: `pages`, `pageHistory`, `pageEditSubmissions`, `pageWatching`, `pageRenderQueue`, `assets`,
  `navigation`, `tags`, `tree`, `approvalRules`, `blocks`, `siteAssets`, `storage`.
- **`groups`, `users`, `userGroups`** — already documented as deliberately instance-wide by
  `CLAUDE.md`'s Permissions section (a group's permissions and page-rules apply across every site an
  actor can reach). Listed below for completeness of the walk, but the rationale is inherited rather
  than re-derived.

Everything else without a `siteId` column is walked table-by-table below.
`backend/db/schema.test.ts` enforces that this list stays exhaustive: it introspects `schema.ts` at
test time for every table missing a `siteId` column (`sites` aside) and fails if this document
doesn't name it, so a table added later without an entry here is a red test, not a silent gap.

## Table-by-table verdicts

| Table | `siteId`? | Verdict | Rationale | `schema.ts` ref |
| --- | --- | --- | --- | --- |
| `apiKeys` | N | Global — correct | `apiKeys.groups` is a jsonb array of group IDs, resolved against the global `groups` table on every request (`models/apiKeys.ts`). The key's permissions come entirely from those groups, so scoping the key row itself per-site would be inconsistent with how its access is actually granted. | `backend/db/schema.ts:38` |
| `authentication` | N | Global — correct | `authentication.autoEnrollGroups` resolves the same global `groups` table (`models/authentication.ts`). A login strategy (e.g. an OIDC provider) is instance-wide infrastructure shared by every site's login page, not a credential scoped to one site. | `backend/db/schema.ts:116` |
| `blockCode` | N | Scoped via FK — correct | One-to-one with `blocks` (`blockId` references `blocks.id` `onDelete: cascade`), and `blocks` itself already carries `siteId`. The compiled code is inseparable from the block row it belongs to, so scoping lives on `blocks` and this table inherits it rather than duplicating the column. | `backend/db/schema.ts:252` |
| `contentSyncState` | N | Scoped via FK — correct | `targetId` references `storage.id` `onDelete: cascade`, and `storage` already carries `siteId`. A sync-state row cannot outlive or cross the target it tracks, so it inherits that target's site scope rather than needing its own `siteId` column (which `contentId` couldn't safely pair with anyway, since it addresses either `pages` or `assets` depending on `contentType` and isn't a real foreign key). | `backend/db/schema.ts:154` |
| `groups` | N | Global — correct (per `CLAUDE.md`) | A group's permissions and page rules apply across every site an actor can reach — the deliberate architecture the closed permission list documents, not an oversight. | `backend/db/schema.ts:147` |
| `hooks` (webhooks) | N | **Gap — tracked separately** | Every `hooks.emit()` call site already carries `siteId` in its event payload (e.g. `WIKI.models.hooks.emit('page:create', { ..., siteId, ... })` in `backend/models/pages.ts:564`), but `Hooks.emit()` (`backend/models/hooks.ts:232-267`) filters only on event name, not site — a webhook fires identically for every site's activity. This is one of Feature 408's two known gaps; see task [#698](../../../work_packages/698) "Decide and implement per-site webhook scoping" for the resolution rather than duplicating the analysis here. | `backend/db/schema.ts:162` |
| `iconSets` | N | Global — correct | Icons are addressed by a flat `<prefix>:<name>` string with no site component anywhere content, nav items, or page relations store it. `CLAUDE.md`'s Icons section documents set enable/disable as deliberately instance-wide. | `backend/db/schema.ts:186` |
| `icons` | N | Global — correct | The permanent memoized store for resolved icon bodies, keyed on `(prefix, name)`, fetched once from the Iconify API and shared by every site that renders that icon (`models/icons.ts`). Same instance-wide rationale as `iconSets`. | `backend/db/schema.ts:200` |
| `jobHistory` | N | Global — correct | The scheduler is one poolifier thread pool shared by the whole process (`core/scheduler.ts`); a job like `renderPages` or `purgeRateLimits` is instance infrastructure, not a per-site concern, so its execution log has no site to scope by. | `backend/db/schema.ts:230` |
| `jobSchedule` | N | Global — correct | Same scheduler-is-instance-wide reasoning as `jobHistory`: a cron entry configures a system task, not site content. | `backend/db/schema.ts:247` |
| `jobLock` | N | Global — correct | One row per task key, coordinating the same scheduler across however many instances of the process are running so a scheduled job isn't picked up twice concurrently. The coordination is instance-to-instance; a task name has no site dimension. | `backend/db/schema.ts:258` |
| `jobs` | N | Global — correct | The pending-job queue backing the same shared scheduler. A job that does act on one site's data carries that `siteId` inside its jsonb `payload` (task-specific), rather than as a table column, since the queue is heterogeneous across task types while `payload`'s shape is not. | `backend/db/schema.ts:265` |
| `locales` | N | Global — correct | Interface translation strings (`backend/locales/en.json` et al. sync here) are the platform's own UI chrome, not site content. Every site presents the same interface-language picker regardless of which content locales its pages use. | `backend/db/schema.ts:280` |
| `pageEditSubmissionApprovals` | N | Scoped via FK — correct | `submissionId` references `pageEditSubmissions.id` `onDelete: cascade`, and `pageEditSubmissions` already carries `siteId`. One reviewer's sign-off toward a submission's approval threshold cannot outlive or cross the submission it counts against, so it inherits that submission's site scope rather than duplicating the column. Added alongside the multi-approver-threshold work (OpenProject #828). | `backend/db/schema.ts:799` |
| `rateLimits` | N | Global — correct | Keyed by an actor-identity string such as `auth:<ip>` (`models/rateLimits.ts`), not by what's being acted on. A login-throttling counter has to cap attempts by who is knocking, not which site's login page they knocked on — scoping it per-site would let an attacker reset their budget by trying a different hostname. | `backend/db/schema.ts:586` |
| `sessions` | N | Global — correct | One session cookie authenticates a browser against the whole instance (`models/sessions.ts` keys purely by session id / `userId`). Scoping sessions per-site would force a re-login on every hostname a multi-site install serves, which isn't how the login flow works. | `backend/db/schema.ts:609` |
| `settings` | N | Global — correct | Holds instance-wide configuration such as `mail` (SMTP transport — host/port/user/pass, `models/settings.ts`) and icon defaults. There is no per-site mail-sending model at all yet (a future mail subsystem is out of this Feature's scope), so SMTP transport configuration has no per-site concept to scope against today. | `backend/db/schema.ts:603` |
| `userAvatars` | N | Global — correct | One row per user `id` — an account's profile image. Accounts are already global per the `groups`/`users` precedent above, so there is no per-site avatar concept. | `backend/db/schema.ts:744` |
| `userKeys` | N | Global — correct | Passkey/WebAuthn credentials keyed to `userId` (`models/users.ts`). Credentials authenticate the account — the same instance-wide entity as `sessions` and `userAvatars` above — not a site-specific login. | `backend/db/schema.ts:750` |
| `users` | N | Global — correct (per `CLAUDE.md`) | An account authenticates once for the whole instance; which sites it may act on is governed by which groups it belongs to and what those groups' page rules allow, not by a per-site user row. | `backend/db/schema.ts:767` |
| `userGroups` | N | Global — correct | Pure join table between `users` and `groups`. Scoping it would require scoping one of its two endpoints first, which the platform deliberately doesn't. | `backend/db/schema.ts:791` |

## Known gaps from this pass

Two gaps survived this audit and are their own tasks under Feature 408 rather than resolved here —
see each task for the full analysis instead of duplicating it in this table:

- **Webhooks** — `hooks` has no `siteId` at all despite every emit call already carrying one in its
  payload; see the `hooks` row above and task
  [#698](../../../work_packages/698) "Decide and implement per-site webhook scoping".
- **TLS/SSL** — not a `schema.ts` table, so it has no row above, but it's the other gap this Feature
  scopes: the app boots plain HTTP only with no built-in certificate handling, and the 2.5.x
  `AdminSsl.vue` admin page is dead code, unreachable from the router and built against the removed
  GraphQL server. See task [#701](../../../work_packages/701) "Resolve the TLS/SSL story for
  multi-hostname deployments" — whose eventual decision should stay consistent with (or explicitly
  supersede) Feature 388/task 599's prior decision to delete the equivalent dead SSL UI stub in favor
  of reverse-proxy TLS termination, since both branches touch the same question independently.

## Extending this audit

A later epic that adds a table with no `siteId` column (comments, mail, extensions, a
storage-sync-target, or anything else) should add a row here using the same five columns before
shipping it, rather than re-deriving the reasoning from scratch. If schema introspection says the
table is unscoped and it deliberately should be, name it in this document — `backend/db/schema.test.ts`
checks that mechanically. If it should carry `siteId` instead, add the column (see `CLAUDE.md`'s
`db-generate` step) and the table needs no row here at all.
