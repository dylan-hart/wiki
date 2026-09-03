# Codebase Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove ~20k lines of dead code and duplication across all four workspaces and split the
long files by responsibility, with no user-visible change beyond the ten flagged decisions.

**Architecture:** Three file-disjoint lanes run in parallel inside the one `consolidation`
worktree — **Lane A** `backend/`, **Lane B** `frontend/`, **Lane C** `blocks/` + `e2e/` — each a
strict sequence of tasks (a task never starts before the previous task in its lane is committed).
A final docs-sync task (**Lane D**) runs after all three lanes. Deletions come first in every lane,
shared helpers next, splits after the helpers they depend on, test-harness consolidation last.

**Tech Stack:** Node 26 (type-stripped TS 7 on the backend, no build step), Fastify, Drizzle/Postgres,
Vue 3 + Vite + Vitest, Lit + rollup + Vitest, Playwright. oxlint + oxfmt.

**Spec:** `docs/superpowers/specs/2026-09-02-codebase-consolidation-design.md` — and the seven
survey reports beside it under `2026-09-02-consolidation-surveys/`. **Every task below names the
survey finding it implements (e.g. `API-F1`); that finding carries the exact `file:line` locations,
the verified duplication, and the proposed target shape. Read it before touching code.**

## Global Constraints

- Work only inside `/Users/dylangles/git/dylan.hart/requarks-wiki-fork/.claude/worktrees/consolidation`.
  `cd` there first. Never run `git stash`, `git checkout`, `git reset`, `git rebase` or `git worktree`
  — other agents share this worktree. Commit only the files your task touched (`git add <paths>`);
  if `git commit` fails with `index.lock`, wait a second and retry.
- Behaviour is preserved except where the spec's table **D1–D10** says otherwise. When a task
  implements one of those, say so in the commit body.
- CLAUDE.md conventions are binding (read it): `es-toolkit` not lodash, `Temporal` not luxon,
  `import type` for types, no `enum`/`namespace`, relative imports carry the real `.ts` extension,
  co-located `*.test.ts`/`*.test.js`, `catch (err: any)`, `node:assert/strict`, `W*` components via
  `components/shared/index.js`, no invented permission names, no legacy fallbacks, the five
  extension-sensitive dynamic `import()` strings stay literal.
- A block's `static definition = {…}` stays a plain object literal in its own `component.js`.
- `api/routeTags.test.ts`, `api/responseErrors.test.ts`, `api/index.test.ts` scan `api/` non-recursively
  and `import().default(app)` every top-level `.ts` — the first task that creates an `api/<dir>/`
  makes them recursive; no non-route module ever sits at `api/*.ts`.
- Format: no semicolons, single quotes, no trailing commas, 2-space indent (`.oxfmtrc.json`). Run
  `npx --prefix backend oxfmt <touched paths>` (from the worktree root) before committing.
- Verification per task, all must be clean (zero errors, zero warnings):
  - backend: `cd backend && npm run typecheck && npx oxlint --deny-warnings` then
    `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56001/postgres node --test <every touched *.test.ts>`
  - frontend: `cd frontend && npx oxlint --deny-warnings && npx vitest run <touched test files>`
  - blocks: `cd blocks && npx oxlint --deny-warnings && npx vitest run <touched test files>`
  - root: `npx --prefix backend oxfmt --check <touched paths>`
  Never run a whole workspace's test suite; run the co-located tests of every file you touched.
- One commit per task. Message: `refactor(<area>): <what>` (or `chore`/`test`/`docs`), body cites
  the finding id and any D-flag. End with the Co-Authored-By / Claude-Session trailer used on this
  branch (see `git log -1 --format=%B`).
- Do not edit `CLAUDE.md` in Lanes A–C. Instead append a bullet to
  `docs/superpowers/plans/claude-md-notes.md` (create if absent) saying what CLAUDE.md must now say.
  Lane D folds those in.
- Do not edit `docs/variances.md` except where a task says so.

---

# Lane A — backend

### Task A1: Delete `backend/importer/` and the dead helper files

**Files:**
- Delete: `backend/importer/` (whole directory), `backend/helpers/redirect.ts`, `backend/helpers/redirect.test.ts`
- Modify: `backend/core/db.ts:161-166` (WikiDbOrTx doc example), `backend/models/assets.ts:184` (comment)
- Findings: CORE-F1, CORE-F7, TEST-F12

- [ ] **Step 1: Prove nothing imports them.**
  `cd backend && grep -rn "importer/" --include='*.ts' . | grep -v node_modules | grep -v '^./importer/' | grep -v migration/importers` → only two comments. `grep -rn "helpers/redirect.ts\|isFollowableRedirect\b" --include='*.ts' . | grep -v node_modules | grep -v test` → only the definition.
- [ ] **Step 2: Delete** `importer/`, `helpers/redirect.ts`, `helpers/redirect.test.ts`. Reword the two comments so they no longer name `importer/` (`db.ts` example points at `models/tree.ts#addAsset`; `assets.ts` note says `sanitizeFileName`/`kindOf` are exported for `modules/storage/disk/storage.ts` and `modules/storage/git/sync.ts`).
- [ ] **Step 3: Verify** `npm run typecheck && npx oxlint --deny-warnings`; `node --test helpers/redirectTarget.test.ts core/db.test.ts`.
- [ ] **Step 4: Commit** `chore(backend): delete orphaned importer/ and helpers/redirect.ts`.

### Task A2: Migration dead code

**Files:** `backend/migration/path-normalization.ts`, `content-staging.ts`, `page-import.ts`, `importers/asset-import.ts`, `importers/comment-import.ts`, `importers/users-groups.ts`, `page-history-import.ts`, `id-map.ts` (+ test), `context.ts`, `mappers/authentication.ts`, `mappers/storage.ts`, `phases/define-phase.ts`, `phases/settings.ts`, `report.ts`, `cli.ts`, `orchestrator.ts`, and their `*.test.ts`.
- Findings: CORE-F2 (items 1a–1g, including 1f per **D5**), CORE-F14 CLI `--only` dedupe.

- [ ] **Step 1:** For each symbol listed in CORE-F2, run `grep -rn "<symbol>" migration tasks --include='*.ts' | grep -v '\.test\.ts:'` and confirm zero production callers.
- [ ] **Step 2:** Delete: `assignTreePaths` + `PathAssignmentResult/Failure/FailureReason` + private `locationKey` (keep `page-import.ts`'s `streamedLocationKey`, fix its false comment); `ContentStagingIndex.locations`; `siblingsByOldId`/`localeSiblingOldIds`/`StagedPage.hash`/`sourceAuthorId`/`sourceCreatorId`; `importPages`/`importAssets`/`importComments`/`importUsersAndGroups` + result types + `stubConvertGroup`/`stubConvertUser`; the `pages` loop in `page-history-import.ts`; `IdMap` class (replace `pageIdMap` with `Map<number,string>` like `userIdMap`); `AuthenticationMapperState`, `ConflictPolicy`, `disambiguateDisplayName`, `remapAutoEnrollGroups`, `'conflict-skipped'` handling, `createdRows`, `StorageMappingResult.updates`, `Known3_0StorageModule`, `strategyMapping`; `staticUnmappable`; `'no-destination-table'`; `PageImporter.failed/.warnings`; the unreachable second `--only` validation in `orchestrator.ts`.
- [ ] **Step 3:** Delete the tests that only exercised those (listed in CORE-F2 "Test coverage"); keep every test of a live path.
- [ ] **Step 4: Verify** typecheck, lint, `DATABASE_URL=… node --test migration/**/*.test.ts` (this directory's tests only).
- [ ] **Step 5: Commit** `chore(migration): remove batch wrappers, IdMap, multi-source conflict policy and other post-reset dead code` (body: D5).

### Task A3: Storage/search/core dead code

**Files:** `backend/models/storage.ts`, `backend/api/storage.ts` (+schemas), `backend/modules/storage/git/storage.ts`, `backend/modules/search/{aws-cloudsearch,algolia,elasticsearch,db}/search.ts` (+tests), `backend/models/search.ts`, `backend/helpers/siteRules.ts`, `backend/helpers/common.ts`, `backend/index.ts`, `backend/core/db.ts`, `backend/core/processGuards.ts` (+test).
- Findings: CORE-F15 (**D4**), CORE-F6 (**D8**), CORE-F19, CORE-F9 (**D9**), CORE-F12 "delete" row, API-F9.

- [ ] **Step 1:** Storage setup surface: delete `StorageDefinition.setup`, `StorageTarget.setup`, `StorageModule.setup/setupDestroy`, `buildSetupValues`, `runSetup`, `destroySetup`, the two `api/storage.ts` routes + their schema entries, and the `git/storage.ts` `ensureRepo` handler export. Update `api/storage.test.ts`/`models/storage.test.ts` accordingly.
- [ ] **Step 2:** Search fallbacks: delete `hasUnbackfilledDocuments` + gate + doc + its tests; replace `updatedAt instanceof Date ? … : …` with `.toTemporalInstant().toString({ smallestUnit: 'millisecond' })` (match azure/aws); confirm drizzle's `db.execute()` return type once and delete the five `rows.rows ?? rows` branches in `db/search.ts`. Un-export the seven in-file-only search symbols; delete `models/search.getActiveEngine` + its test describe.
- [ ] **Step 3:** Delete `siteRules.ts#rulesAllowSite` (+ its test), un-export `common.ts#getTypeDefaultValue`, delete the commented-out 2.x code in `index.ts` (`:314-316`, `:474`, `:483`, `:1183-1190`) and `core/db.ts:23`.
- [ ] **Step 4:** Keep one `unhandledRejection` handler: give `registerUnhandledRejectionHandler` an `exit?: boolean` option (`process.exit(1)` after logging when set), call it with `{ exit: true }` from `index.ts`, delete the inline handler + its comment; add a test case in `core/processGuards.test.ts` that the exit callback fires (inject `exit` as a function for testability: `{ exit: () => void }`).
- [ ] **Step 5:** API-F9: delete the six `req.query.limit ?? N` / `page ?? 1` fallbacks; tighten the route generics so `limit`/`page` are non-optional.
- [ ] **Step 6: Verify** typecheck, lint, tests of every touched file.
- [ ] **Step 7: Commit** `chore(backend): drop storage setup extension point, search old-data fallbacks, dead exports and second unhandledRejection handler` (body: D4, D8, D9).

### Task A4: Models dead code and un-exports

**Files:** `backend/models/contentSync.ts` (+test), `approvals.ts` (+test), `sessions.ts`, `authentication.ts`, `blockCredentials.ts`, `commentProviders.ts` (+test), `rendering.ts` (+test), `tree.ts`, `api/tree.ts` (+test), `assets.ts`, `groups.ts`, plus the un-export list.
- Findings: MOD-F4, MOD-F8 (`listDescendantPages`, `getById` → private), MOD-F9, addendum F6/F7.

- [ ] **Step 1:** `contentSync.ts`: delete `getState`, `getStatesForContent`, `getStatesForTarget`, `getOutOfDatePages`, `getOutOfDateAssets`, `ContentSyncStateRow`, `OutOfDateContent`; collapse `countOutOfDatePages`/`countOutOfDateAssets` into `countOutOfDate(contentType: 'page' | 'asset', …)` keeping both public names as one-line wrappers only if callers use them (grep). Rewrite the test's read-backs to `fixtures.db.select().from(contentSyncStateTable)`. Reword the `docs/variances.md` sentence that names `getState`/`getStatesForTarget` (allowed here).
- [ ] **Step 2:** Delete `approvals.countSubmissions` (tests use `WIKI.db.$count(pageEditSubmissionsTable, where)`), `sessions.getByUser`/`clearAllSessions`, `authentication.getStrategy`, `blockCredentials.deleteSiteCredentials`, `commentProviders.canonicalPageUrl`/`getActiveProvider` (+ their test blocks; fix the stale comment at `setActiveProvider`), `rendering.sanitize` (tests call `sanitizeHtml(html, sanitizeOptions(...))`), `tree.listDescendantPages` (`api/tree.ts` uses `(await listDescendants(...)).pages`; update `api/tree.test.ts` mocks), `AssetAtPath`, `ReviewerScope.actor`, the redundant clause in `groups.mayHoldPermissionSomewhere`. Make `tree.getById` private.
- [ ] **Step 3:** Drop `export` from the in-file-only symbols listed in MOD-F9 and addendum F7 (keep `TREE_UPDATE_CHUNK_SIZE` exported — test-used).
- [ ] **Step 4: Verify** typecheck, lint, tests of every touched file (DB-backed).
- [ ] **Step 5: Commit** `chore(models): delete dead methods and narrow exports`.

### Task A5: Duplicate-test cleanup and relocations

**Files:** `backend/api/pages.test.ts`, `api/pagesExportPdf.test.ts`, `helpers/apiKeySite.test.ts`, `models/users.test.ts`, `locales/en.test.ts`, `locales-en.test.ts` (delete), `locales/en-admin-measurement-labels.test.ts`, `dev-setup-script.test.ts`, `test/readme-generic-setup-doc.test.ts`, `test/apiKeySitePinCoverage.test.ts` → `helpers/apiKeySite.coverage.test.ts`.
- Findings: TEST-F13 items 1–5, 10.

- [ ] **Step 1:** Move the two `api/pages.test.ts` describes (`:3853-3962` → fold into `pagesExportPdf.test.ts` with the #2258/#2262 docblock; `:154-308` → `helpers/apiKeySite.test.ts`, preserving the `userId`-less `apiKeyHeader` variant that `:297-307` depends on).
- [ ] **Step 2:** Merge the two `describe('users.setUserGroups (DB-backed)')` blocks into one with one `setupTestDb()`.
- [ ] **Step 3:** Merge the three `en.json` duplicate-key guards into `locales/en.test.ts` (union of dead-key lists); delete `locales-en.test.ts`. Move the README/`dev/setup.sh` describe from `dev-setup-script.test.ts` into `test/readme-generic-setup-doc.test.ts`. `git mv test/apiKeySitePinCoverage.test.ts helpers/apiKeySite.coverage.test.ts` and fix its relative paths.
- [ ] **Step 4: Verify** run each touched test file. **Step 5: Commit** `test(backend): merge duplicate describes and relocate misplaced suites`.

### Task A6: `helpers/pageAccess.ts`

**Files:**
- Create: `backend/helpers/pageAccess.ts`, `backend/helpers/pageAccess.test.ts` (absorbing `api/pages.actorFrom.test.ts`, `api/pages.mayBypassPassword.test.ts`, and the `mayOnPage`/`pagePermissionsFor` describes of `api/pages.test.ts`)
- Modify: `backend/api/pages.ts:110-372`, `api/assets.ts:32`, `api/tree.ts:84-140`, `api/watching.ts`, `api/approvals.ts`, `api/notifications.ts`, `api/comments.ts`, `api/checklists.ts`, `api/tags.ts`, `controllers/collab.ts`, `controllers/files.ts:63-70`, `controllers/thumb.ts:51-60`, `helpers/permissions.ts:26` (comment), `models/pages.test.ts:1962` (comment), `mcp/` doc references.
- Findings: API-F1, API-F6, API-F8 (`callerOf`/`watcherOf`, `splitList`).

**Interfaces (Produces):**
```ts
export function actorFrom(req): { id: string | null; permissions: string[]; groupIds: string[] } // unchanged body
export function mayBypassPassword(req, siteId: string, page): boolean
export function unlockedFor(req, pageId: string): boolean
export function mayOnPage(req, permission: string, siteId: string, page): boolean
export function pagePermissionsFor(req, siteId: string, page): string[]
export function loadReadablePage(req, siteId: string, pageId: string, opts?: { withContent?: boolean; withPassword?: boolean }): Promise<Page | null>
export function requireReadablePage(req, reply, siteId: string, pageId: string, opts?: { permission?: string; forbiddenMessage?: string; withContent?: boolean; allowLocked?: boolean }): Promise<Page | null> // sends 404/403 itself, returns null once a reply is sent
export function requireActorId(req, reply, message?: string): string | null // replaces callerOf/watcherOf
export function mayOnAsset(...same params as api/assets.ts#mayOnAsset today)
export function mayOnFolder(...), visibleTreeItems(...)
export function splitList(value: string | undefined): string[]  // [] for empty; tree's call sites append `?? null` semantics via `.length ? list : null`
```

- [ ] **Step 1:** Move the helper-only tests first (`git mv` the two test files into `helpers/pageAccess.test.ts` sections) and repoint their imports to `../helpers/pageAccess.ts`; run → fail (module missing).
- [ ] **Step 2:** Create `helpers/pageAccess.ts` by moving the functions verbatim (keep every comment that explains a rule). Implement `loadReadablePage` options so `api/approvals.ts#loadSuggestablePage` ≡ `loadReadablePage(req, siteId, id, { withContent: true, withPassword: true })` and `api/watching.ts#loadWatchablePage` ≡ `loadReadablePage(req, siteId, id)`. Implement `requireReadablePage` exactly as the 13 preambles in API-F6 (404 `'This page does not exist.'`, 403 with `forbiddenMessage`, 403 `'This page is password protected.'` unless `allowLocked`).
- [ ] **Step 3:** Repoint every importer; replace the 13 preambles, the two `mayOnAsset` inline copies, `callerOf`/`watcherOf`, both `splitList`s.
- [ ] **Step 4: Verify** typecheck, lint, and run: `helpers/pageAccess.test.ts`, `api/pages.test.ts`, `api/pages-export.test.ts`, `api/pagesExportPdf.test.ts`, `api/comments.test.ts`, `api/checklists.test.ts`, `api/watching.test.ts`, `api/notifications.test.ts`, `api/approvals.test.ts`, `api/tags.test.ts`, `api/tree.test.ts`, `api/assets.test.ts`, `controllers/files.test.ts`, `controllers/thumb.test.ts`, `controllers/collab.test.ts`, `helpers/apiKeySite.test.ts`.
- [ ] **Step 5: Commit** `refactor(backend): move page/asset access helpers to helpers/pageAccess.ts and dedupe route preambles`.

### Task A7: Site preamble hook, params `$ref`s, delegation gate

**Files:** `backend/helpers/common.ts:340-362` (`siteEnabledPreHandler`), `backend/api/index.ts`, create `backend/api/schemas/params.ts`, `backend/models/groups.ts` (+test), and every route file in API-F2/F3/F4 plus their tests.
- Findings: API-F2 (**D1**), API-F3, API-F4.

**Interfaces:**
```ts
// helpers/common.ts — siteEnabledPreHandler now also does:
//   if (req.params?.siteId && !WIKI.sites[req.params.siteId]) return reply.notFound('This site does not exist.')
// api/schemas/params.ts
export function registerParamsSchemas(app): void // $ids: SiteIdParams, SitePageParams, SiteFolderParams, SiteTagParams, SitePageCommentParams
// models/groups.ts
checkSiteAdminAccess(req, globalPermission: string, sitePermission: string, siteId: string): boolean
```

- [ ] **Step 1:** Add an `'unknown site → 404'` case to `api/index.test.ts`'s hook describe; fail. Implement in `siteEnabledPreHandler`; rewrite its doc comment (it currently explains leaving the 404 to routes). Delete all 36 site-existence blocks. For per-file suites that mount a plugin alone, register the hook in their `buildApp` (one line) so their existing unknown-site tests still pass; harmonise the one message assertion in `api/authentication.test.ts`.
- [ ] **Step 2:** Create `schemas/params.ts`, register it in `api/index.ts` before the routes, replace the per-file `siteIdParam`/`pageIdParam` constants and the pure inline `siteId` / `siteId+pageId` `params:` blocks with `$ref`s. Compound params with extra keys stay inline.
- [ ] **Step 3:** Add `checkSiteAdminAccess` with a unit test in `models/groups.test.ts`; replace `mayAdministerApprovals`, `mayManageBlocks`, `mayManageCredentials`, `canManageNavigation`, `maySaveSiteImage` (keep the per-kind mapping inline at its one call site) and write the shared rationale comment once.
- [ ] **Step 4: Verify** typecheck, lint, every touched route test + `api/index.test.ts` + `api/routeTags.test.ts` + `api/responseErrors.test.ts` + `models/groups.test.ts`.
- [ ] **Step 5: Commit** `refactor(api): shared unknown-site 404 hook, params schema refs, checkSiteAdminAccess` (body: D1).

### Task A8: Small backend helper bundle

**Files:** create `backend/helpers/httpCache.ts` (+test), `backend/helpers/timeout.ts` (+test), `backend/mcp/tools/shared.ts`; modify `helpers/common.ts` (add `siteIdForHostname`, `isUniqueViolation`, `escapeLikePattern`), `api/diagrams.ts`, `index.ts:944,1102`, `models/sites.ts:131`, `api/authentication.ts:1086`, `api/users.ts`, `api/apiKeys.ts`, `api/approvals.ts`, `api/sites.ts:311-322`, `controllers/site.ts:63-69`, `controllers/{site,files,thumb,blocks,user,icons}.ts`, `api/locales.ts`, `core/scheduler.ts`, `models/rendering.ts`, `models/diagramRender.ts`, `models/search.ts`, `models/pdfExport.ts`, `mcp/site.ts`, `mcp/tools/*.ts`, `models/{pages,users,glossary,blocks,tree,groups}.ts`, `modules/search/db/search.ts`, `helpers/puppeteer.ts`, create `helpers/fsPurge.ts` (+test), `models/export.ts`, `models/siteImport.ts`, `models/mail.ts`.
- Findings: API-F8 (rest), API-F10, CORE-F10, CORE-F11 (**D2**), CORE-F16, CORE-F17, MOD-F7, MOD-F10 (`escapeLikePattern`, bcrypt const), addendum F3, F4, F5.

**Interfaces:**
```ts
// helpers/httpCache.ts
export function notModifiedOrPrepare(req, reply, opts: { etag: string; cacheControl: string }): boolean // true when 304 already sent
// helpers/timeout.ts
export function withTimeout<T>(work: Promise<T>, ms: number, onExpire: () => Error, opts?: { unref?: boolean }): Promise<T>
// helpers/common.ts
export function siteIdForHostname(hostname: string | undefined): string | undefined
export function isUniqueViolation(err: unknown): boolean   // err.code === '23505' || err.cause?.code === '23505'
export function escapeLikePattern(value: string): string
export const BCRYPT_ROUNDS = 12
// helpers/puppeteer.ts
export function isPuppeteerAvailable(): Promise<boolean>
export function assertPuppeteerAvailable(errorName: string, message: string): Promise<void>
export function closeQuietly(closable: { close(): Promise<unknown> } | null | undefined, label: string): Promise<void>
// helpers/fsPurge.ts
export function purgeFilesOlderThan(dir: string, ttlSeconds: number): Promise<number>
// mcp/tools/shared.ts
export function toResult(payload: unknown): CallToolResult
export const siteIdArg, localeArg  // the repeated zod fields
// models/groups.ts — one owner for "are these real group ids": hasUnknownGroupIds(ids: string[]): Promise<boolean>
// core/scheduler.ts — private notifyJobCompleted(id, state, errorMessage?)
// models/mail.ts — private sendTemplate(to, locale, key, params, { textSuffix?, htmlSuffix? })
```

- [ ] **Step 1:** Write unit tests for `notModifiedOrPrepare`, `withTimeout` (resolves, rejects with `onExpire()`, clears the timer, `unref`), `siteIdForHostname` (case-insensitive, `*` fallback), `isUniqueViolation`, `escapeLikePattern`, `purgeFilesOlderThan` (temp dir, ENOENT → 0). Run → fail.
- [ ] **Step 2:** Implement each helper, then replace every call site named in the findings. `api/diagrams.ts` now goes through `siteIdForHostname` (D2). `diagramRender.withTimeout`, `rendering.withRenderTimeout`, `pdfExport.waitForBlocksToSettle`'s race and the three scheduler races become `withTimeout` calls (`drainInFlightJobs` resolves instead of rejecting — wrap accordingly). `mcp/site.ts#defaultLocale` is deleted in favour of `common.ts#defaultLocale(site.id)`. Shared API-key creation validation (`validateApiKeyInput`/`issueKey`) lives in `models/apiKeys.ts`; `users.ts`/`apiKeys.ts` routes call it.
- [ ] **Step 3: Verify** typecheck, lint, every touched test (`controllers/*.test.ts`, `api/locales.test.ts`, `core/scheduler.test.ts`, `models/{rendering,diagramRender,search,pdfExport,export,siteImport,mail}.test.ts`, `mcp/**/*.test.ts`, `api/{users,apiKeys,approvals,sites,notifications,watching}.test.ts`, `helpers/common.test.ts`, the new helper tests).
- [ ] **Step 4: Commit** `refactor(backend): shared httpCache, withTimeout, siteIdForHostname, isUniqueViolation, fsPurge, mcp tool helpers` (body: D2).

### Task A9: `helpers/moduleRegistry.ts`

**Files:** create `backend/helpers/moduleRegistry.ts` (+test); modify `models/storage.ts`, `models/search.ts`, `models/authentication.ts`, `models/commentProviders.ts`, `models/analytics.ts`, `models/extensions.ts` (+ their tests).
- Finding: MOD-F1.

**Interfaces:**
```ts
export interface ModuleDefinitionRecord { key: string; props: ModuleProp[]; [k: string]: unknown }
export async function readModuleDefinitions<T extends ModuleDefinitionRecord>(dirPath: string, opts: { label: string; parseProps?: boolean; sortPropsByOrder?: boolean; skipUnavailable?: boolean; decorate?: (def: any, key: string) => T }): Promise<T[]>
export function mergeModuleConfig(props: ModuleProp[], incoming: Record<string, unknown>, existing: Record<string, unknown>): Record<string, unknown>   // the four byte-identical buildConfig bodies
export function validateModuleConfig(props: ModuleProp[], incoming: Record<string, unknown>, opts?: { refuseUnknown?: boolean; requiredAndPattern?: boolean; moduleTitle?: string }): void // throws CustomError as today
export function moduleHasFile(dirPath: string, key: string, file: string): Promise<boolean>
export async function loadModule<M>(cache: Map<string, M>, key: string, importer: () => Promise<{ default: M } | M>, label: string): Promise<M> // the import() string stays literal at the call site
export async function syncSiteModuleRows(...)  // select-existing → insert-missing → delete-orphaned skeleton, rowFor callback
```

- [ ] **Step 1:** Write `helpers/moduleRegistry.test.ts` for `mergeModuleConfig` (readOnly never taken from incoming, sensitive unmask, default fill) and `validateModuleConfig` (enum/boolean/number/string switch; `refuseUnknown`; required/pattern pass) using the cases already present in `models/storage.test.ts:718-746` and `models/search.test.ts:534-972`. Run → fail.
- [ ] **Step 2:** Implement; convert the six models one at a time, running each model's test after conversion. The `WIKI.models.*` public method names do not change. Rewrite `search.ts:436-444`'s "kept as its own method" comment.
- [ ] **Step 3: Verify** typecheck, lint, the six model tests + the helper test. **Step 4: Commit** `refactor(models): one moduleRegistry helper for definition scan, config merge/validate, module load and site sync`.

### Task A10: `helpers/clusterCache.ts` and model-local dedupes

**Files:** create `backend/helpers/clusterCache.ts` (+test); modify `models/groups.ts`, `sites.ts`, `approvals.ts`, `classificationLevels.ts`, `locales.ts`, `users.ts`, `pages.ts`, `tree.ts`, `assets.ts`, `navigation.ts`, `pageHistory.ts`, `hooks.ts`, `auditLog.ts`, `jobs.ts`, create `helpers/pagination.ts` (+test), and the touched models' tests.
- Findings: MOD-F3, MOD-F2, MOD-F5, MOD-F6, MOD-F8, MOD-F10 (rest), MOD-F14 (`assetSelection`/`toAsset` only), MOD-F15, MOD-F16, MOD-F17, addendum F2.

**Interfaces:**
```ts
// helpers/clusterCache.ts
export abstract class ClusterReloaded { protected abstract readonly reloadEvent: string; abstract reloadCache(): Promise<void>; async broadcastReload(): Promise<void>; subscribeToEvents(): void }
// helpers/pagination.ts
export async function paginate<T>(opts: { rows: () => Promise<T[]>; total: () => Promise<number> }): Promise<{ total: number; rows: T[] }>  // Promise.all of both; call sites keep their own query builders; both `count()` spellings → drizzle count()
// helpers/common.ts
export function assertLocaleActive(siteId: string, locale: string): void   // throws pageInvalidLocale
export function assertPathNotReservedLocale(path: string): void
// models/users.ts
private patchStrategyAuth(userId: string, strategyId: string, mutate: (entry: Record<string, any>) => Record<string, any> | null, opts?: { db?: WikiDbOrTx; mirrorInto?: { auth: Record<string, any> } }): Promise<boolean>
private requireStrategyAuth(userId: string, strategyId: string, opts?: { tfaActive?: boolean }): Promise<{ user; auth; entry }>
function localUserRow(input: { email; name; passwordHash; … }): typeof usersTable.$inferInsert
private describeLinkedProviders(user, opts?: { forProfile?: boolean })
export const userSelection, export type UserCore, UserPage   // groups.ts imports them
// models/pages.ts
private announce(event: string, siteId: string, data: Record<string, unknown>, extra?: { metadata?; dispatchExtra? }): Promise<void>  // hooks.emit then storage.dispatch, payloads byte-identical to today
private invalidateSiteCaches(siteId: string, opts?: { glossary?: boolean }): void
private assertNoPageAt(siteId, locale, path, exceptId?): Promise<void>
private assertClassificationMeetsFloor(requested, floorId): Promise<void>
// models/tree.ts
private requireFolderById(id, siteId, db?): Promise<Folder>; private assertFolderNameFree(siteId, locale, folderPath, name, exceptId?, db?): Promise<void>; private duplicateEntryError(): CustomError
export function holdsVisiblePagesUnder(encodedParentPath: string, publicOnly: boolean, aliasSuffix: string): SQL
// models/assets.ts
const assetSelection = {...}; function toAsset(row): Asset
// models/pageHistory.ts
const entrySelection; function toEntry(row); function keysetAfter(after?: string | null): SQL | undefined
```

- [ ] **Step 1:** `clusterCache.test.ts`: a subclass with a spy `reloadCache`; `broadcastReload` reloads then emits `WIKI.events.outbound` with `reloadEvent`; `subscribeToEvents` registers on `inbound` (use `test/mocks.ts#createEventsStub`). Run → fail; implement; convert the five models (delete their duplicated methods + the ~10-line echo comment, write it once on the base class).
- [ ] **Step 2:** `paginate` + `assertLocaleActive`/`assertPathNotReservedLocale` tests → implement → convert the six pagination sites and the pages/tree/navigation validation sites.
- [ ] **Step 3:** `users.ts`: implement `patchStrategyAuth`, convert all 14 sites (three early-return sites return `null` from `mutate`); `requireStrategyAuth` for the 4+2 preflights; `localUserRow` for the three row literals; `describeLinkedProviders`; `register()` calls `assertAllowedProviderEmail`; export `userSelection`/`UserCore`/`UserPage` and import in `groups.ts` (delete `GroupUser`/`GroupUserPage`).
- [ ] **Step 4:** `pages.ts` `announce`/`invalidateSiteCaches`/`assertNoPageAt`/`assertClassificationMeetsFloor` (payloads unchanged — `pages.test.ts:953-963` and `assets.test.ts:574-674` assert them); `tree.ts` `requireFolderById`/`assertFolderNameFree`/`duplicateEntryError`/`holdsVisiblePagesUnder` (navigation calls it and drops its redundant `ne(type,'asset')`); `assets.ts` `assetSelection`/`toAsset`; `pageHistory.ts` `entrySelection`/`toEntry`/`keysetAfter`.
- [ ] **Step 5: Verify** typecheck, lint, DB-backed tests of every touched model + `api/groups.test.ts`. **Step 6: Commit** `refactor(models): ClusterReloaded base, paginate, patchStrategyAuth and shared validation/projection helpers`.

### Task A11: Schema-inferred model types

**Files:** `backend/models/{comments,apiKeys,hooks,classificationLevels,blockCredentials,glossary,approvals,users,tags,locales}.ts`, `backend/db/schema.ts` (`.$type<…>()` on `approvalRules.match`, `locales.strings` only if the type can be imported without pulling a model in — otherwise keep the intersection).
- Finding: addendum F1.

- [ ] **Step 1:** Replace each column-for-column interface with `typeof <table>.$inferSelect` (or `Pick`/`Omit`) per the addendum table; delete `keySelection`/`hookSelection` and the listed `as X` casts. Move `approvalMatchModes` to `helpers/approvalMatch.ts` if `schema.ts` needs it.
- [ ] **Step 2: Verify** `npm run typecheck` (type-only change), lint, run the ten co-located tests. **Step 3: Commit** `refactor(models): derive row types from the schema instead of restating them`.

### Task A12: Storage blob factory and sftp threshold convergence

**Files:** create `backend/modules/storage/blobBase.ts` (+test); modify `modules/storage/{s3,azure,gcs}/storage.ts` (+tests incl. `s3/storage.emulated.test.ts`), `modules/storage/sftp/assets.ts` (+test), `models/storage.ts:20-32`, `modules/storage/disk/storage.ts:26-34`, `modules/storage/git/content.ts:28`, `helpers/pageSerialization.ts`.
- Findings: CORE-F3, CORE-F4 (**D3**), CORE-F18.

**Interfaces:**
```ts
export interface BlobDriver<C> { label: string; build(config): C | Promise<C>; put(c: C, key: string, body: Buffer, mimeType: string, config): Promise<void>; remove(c: C, key: string): Promise<void>; copy(c: C, from: string, to: string, config): Promise<void>; sign(c: C, key: string, ttlSeconds: number): Promise<string> }
export function blobStorageModule<C>(driver: BlobDriver<C>): StorageModule
export const DIRECT_ACCESS_TTL_SECONDS = 3600  // the value declared three times today
export function keyFor(target, folderPath, fileName): string  // tests import it from here
```

- [ ] **Step 1:** `blobBase.test.ts` with a fake driver: activation cache keyed by `JSON.stringify(config)`, failed activation not remembered, `assetUploaded`/`assetDeleted`/`assetRenamed`/`getDirectUrl`/`exportAll` call the driver with the keys `keyFor` computes. Run → fail; implement.
- [ ] **Step 2:** Rewrite s3/azure/gcs as `blobStorageModule({...})`, keeping their SDK imports, `buildClient`, `ensureBucket` and the five callbacks; drop the 12 impossible-shape `??` fallbacks; repoint the 12 `keyFor` test references. Run all three suites + the emulated/pathstyle s3 suites.
- [ ] **Step 3:** sftp: delete `assets.ts:96-160`, use `belongsInTarget`; rewrite `sftp/assets.test.ts:85-130` against the canonical semantics (D3). Run `sftp/assets.test.ts`, `sftp/integration.test.ts`.
- [ ] **Step 4:** One content-type→extension map: export it from `helpers/pageSerialization.ts` and derive the three others from it, keeping `disk`'s `redirect: 'json'` as an explicit override (its tests pin it).
- [ ] **Step 5: Verify + Commit** `refactor(storage): blobStorageModule factory for s3/azure/gcs; sftp adopts blobTarget thresholds` (body: D3).

### Task A13: Search engine shared helpers and base class

**Files:** create `backend/modules/search/shared.ts` (+test), `backend/modules/search/externalBase.ts`; modify `modules/search/{algolia,elasticsearch,azure-search,aws-cloudsearch,db}/search.ts` (+tests), `models/search.ts` (`getEngineConfig` adoption).
- Finding: CORE-F5 (phased).

**Interfaces:**
```ts
// shared.ts (pure)
export const SCAN_CAP = 500
export function escapeHtml(s: string): string
export function normalizeMarkers(...)
export function filterVisible(rows, actor, checkAccess): rows
export function toSearchPagesResult(rows, opts): { results; totalHits; totalHitsApproximate; suggestion: null }
export function batchBySize(docs, maxBytes, maxCount): docs[][]
export function buildSearchDocument(page): SearchDocument
export function publishStateConditions(...)
export async function* pageStream(siteId, opts): AsyncGenerator<SearchIndexablePage[]>   // replaces RebuildPageSource + keyset loops
// externalBase.ts
export abstract class ExternalSearchModule<TClient> implements SearchModule { protected clientFor(config): TClient; protected configFor(siteId); created/updated/deleted/renamed forwarders; protected safeWrite(fn, label); protected safeRemove(fn, label); abstract indexPage/removePage/query/rebuild pieces }
```

- [ ] **Step 1 (phase 1, −90):** move the `diff`-identical azure/aws blocks and the three `escapeHtml` copies into `shared.ts` with tests; run all five engine suites.
- [ ] **Step 2 (phase 2, −100):** `SCAN_CAP`, never-throws wrappers, the 3-line forwarders, `batchBySize`, `buildSearchDocument` into `shared.ts`/`externalBase.ts`; algolia + elasticsearch extend the base; run their suites.
- [ ] **Step 3 (phase 3, −130):** azure + aws extend the base; `pageStream` replaces `RebuildPageSource`; declare aws's field list in the SDK's own shape (drop the 117-line translation). Run their suites.
- [ ] **Step 4 (phase 4, −130):** unify config reads on `getEngineConfig` (confirm `index.ts` calls `refreshFromDisk()` before `initActiveEngines()`); drop the hand-applied `definition.yml` defaults.
- [ ] **Step 5 (phase 5, last):** `filterVisible` + `toSearchPagesResult` across all four — `db/search.test.ts:266,629` must stay untouched and green.
- [ ] **Step 6: Verify** typecheck, lint, all five engine suites + `models/search.test.ts`. **Step 7: Commit** one commit per phase, `refactor(search): …`.

### Task A14: Split `helpers/common.ts`

**Files:** create `backend/helpers/siteResolution.ts`, `backend/helpers/localeRouting.ts`, `backend/helpers/moduleProps.ts` (+ split `common.test.ts` accordingly); modify the ~40 importers (`grep -rln "helpers/common.ts"`).
- Finding: CORE-F13.

- [ ] **Step 1:** `git mv`-style: move the three clusters (line ranges in CORE-F13) verbatim, un-interleave the misplaced `guardSiteEnabled` doc comment, add `siteIdForHostname` to `siteResolution.ts`. `common.ts` keeps `import`-free re-exports? **No** — repoint every importer (typecheck finds them all); no re-export shim.
- [ ] **Step 2:** Split `common.test.ts` into `siteResolution.test.ts`, `localeRouting.test.ts`, `moduleProps.test.ts` + remainder.
- [ ] **Step 3: Verify** typecheck, lint, the four helper tests + `api/index.test.ts`. **Step 4: Commit** `refactor(helpers): split common.ts into siteResolution, localeRouting, moduleProps`.

### Task A15: Split `index.ts` into `core/http/*`

**Files:** create `backend/core/http/{security,session,openapi,authHooks,siteRouting,errors,routes}.ts` (+ `authHooks.test.ts`, `openapi.test.ts`, `errors.test.ts`); modify `backend/index.ts`, `helpers/openapi.ts`, `helpers/errorHandler.ts`, `models/sessions.ts` (`sessionStoreAdapter()`), `api/index.ts:9-41` → `export async function registerAllSchemas(app)`.
- Findings: CORE-F12, TEST-F2 production-side extractions.

**Interfaces (Produces, used by A16 `buildTestApp`):**
```ts
// core/http/authHooks.ts
export function permissionPreHandler(req, reply): Promise<void> | void   // the exact body of index.ts:886-918 incl. the req.apiKey branch
export function registerAuthHooks(app): void
// helpers/errorHandler.ts
export function apiErrorHandler(err, req, reply): void   // index.ts:1128-1152's /_api branch, shape { ok, error, statusCode, message }
// helpers/openapi.ts
export function swaggerTransform({ schema, url }): { schema; url }
// core/http/*.ts — each: export function register<X>(app): Promise<void>
// api/index.ts
export async function registerAllSchemas(app): Promise<void>
```

- [ ] **Step 1:** Unit tests for `permissionPreHandler` (OR list, nested AND, `manage:system` bypass, `req.apiKey` branch), `swaggerTransform` (permissions folded into description), `apiErrorHandler` (JSON shape). Run → fail; extract the pure functions; pass.
- [ ] **Step 2:** Move each block of `initHTTPServer()` into its `core/http/*.ts` register function verbatim (table in CORE-F12); collapse the session store's three `try { clb(null, await …) } catch (err) { clb(err, null) }` wrappers into `models/sessions.ts#sessionStoreAdapter()`; dedupe the two trailing-slash trims and the two hostname lookups via `siteIdForHostname`. `index.ts` becomes the ~250-line boot script.
- [ ] **Step 3: Verify** typecheck, lint, new tests + `api/index.test.ts` + `helpers/errorHandler.test.ts` + `helpers/openapi.test.ts` + boot smoke: `cd .. && timeout 25 node backend` (from the worktree root, expect the log line that the HTTP server is listening, then exit code 124 from timeout; any stack trace = fail). **Step 4: Commit** `refactor(backend): split index.ts HTTP wiring into core/http/*`.

### Task A16: Backend test harness (`createWikiStub`, `buildTestApp`, builders, recorder, fixtures)

**Files:** modify `backend/test/mocks.ts`, `backend/test/db.ts`; create `backend/test/fastify.ts`, `backend/test/routeRecorder.ts`, `backend/test/builders.ts`, `backend/test/migrationFixtures.ts`, `backend/test/sourceFiles.ts`; then convert test files directory by directory (`modules/storage/` first, then `modules/search/`, `api/` no-auth files, the six permission-replica files, the rest, `migration/`).
- Findings: TEST-F1, F2, F7, F9, F10, F15.

**Interfaces:**
```ts
// test/mocks.ts
export function createSilentLogger(): any            // moved from db.ts
export function createWikiStub(overrides?: DeepPartial<WikiGlobal>): WikiGlobal  // defaults: silent logger, cache/events/scheduler stubs, config/sites/sitesMappings/models = {}, data.systemIds
export function installTestWiki(overrides?): { restore(): void }
// test/fastify.ts
export async function buildTestApp(opts: { routes: FastifyPluginAsync | FastifyPluginAsync[]; wiki?: DeepPartial<WikiGlobal>; schemas?: 'all' | Array<(app) => void>; session?: false | 'header' | object | ((req) => object); permissions?: boolean; apiKeySitePin?: boolean; ajv?: boolean; swagger?: boolean; prefix?: string }): Promise<FastifyInstance>
export async function closeTestApp(app): Promise<void>
export function makeRequestStub(overrides?), makeReplyStub(), makeDoneStub()
// test/routeRecorder.ts
export function createRecordingApp(), listApiRouteFiles(apiDir) /* recursive */, recordRoutesFrom(file), referencesApiError(schema), stubWikiForRegistration()
// test/builders.ts
export function makeGroupRule(overrides?), makeRulePageRef(overrides?), makeActor(overrides?), makeSite(overrides?), makeStorageTarget(module, overrides?), makeIndexablePage(overrides?) /* the azure 28-field superset */, stubSelect(row, { joins? })
// test/migrationFixtures.ts
export async function* iterate<T>(items: T[]), stubSourceConnector(overrides?), makeSourcePageRow(overrides?), makeStagedPage(overrides?), LEGACY_SCHEMA_DDL: Record<string, string>
// test/sourceFiles.ts
export function listSourceFiles(root: string, opts?: { ext?: string[]; skip?: string[] }): string[]
```

- [ ] **Step 1:** Land all six harness files with their own small tests (`buildTestApp` mounts a trivial route with `session: { user: { id } }` and `permissions: true` and asserts 403/200 through the real `permissionPreHandler`). `db.ts#installTestWiki` becomes a caller of `mocks.ts`'s. Keep default `models` as `{}` (disk storage test relies on absent members throwing).
- [ ] **Step 2:** Convert directory by directory, running each converted file. Delete every local `buildApp`, `setErrorHandler` copy, permission replica, hexcolor ajv block, `WIKI = {…}` literal, logger object, save/restore dance, `makeReq/makeReply`, recording app, `iter`, NYIE connector stub, page-row literal, file walker. The three scanner tests use `listApiRouteFiles` (recursive, skipping `schemas/`, using a directory's `index.ts`).
- [ ] **Step 3: Verify** every converted file + typecheck + lint. **Step 4: Commit** in batches per directory: `test(backend): …`.

### Task A17: Split `api/pages.ts`, `api/users.ts`, `api/system.ts`, `api/authentication.ts`

**Files:** create `backend/api/pages/{index,read,write,import,classification,history,export}.ts`, `backend/api/users/{index,admin,profile}.ts`, `backend/api/system/{index,info,settings,extensions,maintenance,transfer}.ts`, `backend/api/auth/{index,site,provider,strategies}.ts`; delete the four originals; split their tests along the describe ranges in API-F5 / TEST-F14 (`api/pages/*.test.ts`, etc., born on `buildTestApp`); `api/index.ts` registers the four `index.ts` aggregators; `controllers/metrics.ts` imports `getClusterNodes` from `api/system/info.ts`; `mcp/bootstrap.ts` imports `whoAmI` from `api/users/admin.ts`.
- Findings: API-F5, API-F7, TEST-F14 (api rows).

- [ ] **Step 1:** For `system/settings.ts`, first add PUT tests for `/api`, `/metrics`, `/pageviews` toggles (three injects each: enable, disable, audit event recorded) in the new `system/settings.test.ts`; then implement `registerFlagToggle(app, { path, configKey, auditEvent, summary, description, extraGet? })` and delete the triplet (API-F7).
- [ ] **Step 2:** `pages/import.ts` owns the `addContentTypeParser('*')` + `fastifyMultipart` registration — confirm no JSON route relied on the `'*'` buffer parser (its own comment says none should). `users/profile.ts` registers `addHook('preHandler', requireSessionUser)` and drops the 20 inline gates. `system/transfer.ts` owns the gzip parser.
- [ ] **Step 3:** Each aggregator `index.ts` is `export default async function (app) { await app.register(read); … }` so route paths, tags and permissions are unchanged (compare `GET /_api/openapi.json` before/after: `node --test api/routeTags.test.ts api/responseErrors.test.ts api/index.test.ts` and a manual diff of the swagger doc produced by a booted app).
- [ ] **Step 4: Verify** typecheck, lint, all new split test files + the three scanners + `helpers/apiKeySite.coverage.test.ts` + `test/apiKeySitePinCoverage`-style structural tests. **Step 5: Commit** one commit per file split: `refactor(api): split pages.ts into api/pages/*`, etc.

### Task A18: Split `models/rendering.ts`, `users.ts`, `approvals.ts`, `assets.ts`, `pages.ts`

**Files:** create `backend/helpers/htmlSanitizePolicy.ts`, `backend/models/renderQueue.ts`, `backend/models/userCredentials.ts`, `backend/models/login.ts`, `backend/models/approvalRules.ts`, `backend/models/approvalNotifications.ts`, `backend/models/assetServing.ts`, `backend/models/pageClassification.ts`; modify `models/index.ts`, `types/global.d.ts` (if it enumerates models), every caller (`api/authentication.ts` → `WIKI.models.login.*`, `api/approvals.ts`, `core/maintenance.ts`, `core/db.ts`, `tasks/simple/render-pages.ts`, `pages.ts`, `mcp/`); split the tests along TEST-F14's model rows, pure describes into their own files.
- Findings: MOD-F11, F12, F13 (+ `reviewerScopeFor`), F14, F18; TEST-F14 model rows, TEST-F16.

- [ ] **Step 1:** One model per commit, verbatim moves with `models/index.ts` registration. `approvals.reviewerScopeFor(req, siteId, page?)` replaces `api/approvals.ts#reviewerFor`'s rebuild.
- [ ] **Step 2:** After each move: typecheck, lint, the model's DB-backed tests (now split) + its API tests.
- [ ] **Step 3: Commit** `refactor(models): split rendering.ts into sanitizer policy / post-process / render queue`, `… users.ts into users / userCredentials / login`, `… approvals.ts …`, `… assets.ts serving cache`, `… pages.ts classification cluster`.

### Task A19: Migration shapes and comment trim

**Files:** create `backend/migration/phases/route.ts`, `phases/dry-run.ts`, `mappers/shared.ts`; modify `phases/{users,content,assets,define-phase,settings}.ts`, `importers/users-groups.ts`, `mappers/{authentication,storage,site-settings}.ts`, `cli.ts`, `verify-cli.ts`, `source-args.ts`, `orchestrator.ts` → merged into `tasks/migrate.ts`, `render.ts` + `unmappable.ts` → `report.ts`, `importers/user-converters.ts` → `users-groups.ts`, `verify.ts`, `navigation-import.ts` (`NavigationWriteModel.ensureSiteNav(siteId, locale)`), `git mv page-import.ts page-history-import.ts navigation-import.ts importers/`; tests follow.
- Finding: CORE-F14.

- [ ] **Step 1:** `phases/route.ts#routeOutcome` with a unit test covering the three-way branch; delete the three copies and `trackWriteCapability` + the unreachable `not_implemented` reclassification. `phases/dry-run.ts` two helpers; `mappers/shared.ts` (`pick` keeping the two `undefined` behaviours explicit, `isPlainObject`, `transformConfig`, `unwrapKnexValue`) — do **not** swap to es-toolkit's `isPlainObject`.
- [ ] **Step 2:** Generic group/user importer; CLI dedupe; `verify.ts` uses its own `countOrNotImplemented`; fix `NavigationWriteModel` and delete the adapter; move the three root importers under `importers/` and repoint ~14 imports.
- [ ] **Step 3:** In each file touched, delete comment blocks that narrate deleted code or read as task-number changelogs; keep every "why" comment (bind-parameter ceiling, context, bootstrap).
- [ ] **Step 4: Verify** typecheck, lint, `DATABASE_URL=… node --test migration/**/*.test.ts tasks/migrate.test.ts` (if present). **Step 5: Commit** `refactor(migration): shared routeOutcome/dry-run/mapper helpers, importers/ layout, comment trim`.

### Task A20: Search/storage contract runners and remaining test splits

**Files:** create `backend/test/searchModuleContract.ts`, `backend/test/storageModuleContract.ts`; rewrite `modules/search/*/search.test.ts` and `modules/storage/{azure,gcs,s3}/storage.test.ts` onto them (vendor-specific builders stay local); split `core/scheduler.test.ts` and `core/collab.test.ts` per TEST-F14 (`FakeSocket` → `test/collabWorker.ts`); lift `models/storage.test.ts`'s single DB describe into `models/storage.db.test.ts`.
- Findings: TEST-F6, TEST-F14 (core rows), TEST-F16.

- [ ] **Step 1:** Ship the byte-identical helpers (`fakePage`, `fakePageSource`, `fakeDb`, `makeTarget`) into `test/builders.ts` first; run all suites.
- [ ] **Step 2:** `runSearchModuleContract(name, { makeModule, config, siteConfig })` emitting the 13 contract tests named `"<engine>: <claim>"`; `runStorageModuleContract(name, { makeTarget, stubSdk })` emitting the 10 asset-lifecycle tests. Wire each engine/module; a `db/search` gap (`renamed()`/`totalHits`) that the runner surfaces is fixed in the engine only if it is a test-expression gap, otherwise reported.
- [ ] **Step 3:** Split scheduler/collab suites; move the `before()` that mutates `scheduler.tasks`/`maxWorkers` with its describe.
- [ ] **Step 4: Verify + Commit** `test(backend): shared search/storage contract runners; split scheduler and collab suites`.

---

# Lane B — frontend

### Task B1: Frontend dead code

**Files:** delete `frontend/src/helpers/monacoTypes.js`, `components/shared/WRating.vue`, `WTree.vue`, `WTreeNode.vue`, `components/MailTemplateEditorOverlay.vue`, `pages/AdminRendering.vue`; modify `components/shared/index.js`, `router/routes.js`, `layouts/AdminLayout.vue` (nav item + commented overlay line), `pages/AdminMail.vue` (templates card + `editTemplate`), `backend/locales/en.json` (`admin.rendering.*`, `admin.mail.templateEditor`/template-card keys — Lane B may edit `en.json` only for keys it deletes; Lane A never touches those keys), `docs/variances.md:28-31` (monacoTypes bullet), `components/UserEditOverlay.vue` (`sendWelcomeEmail` + its card row; `deleteUser` opens `UserDeleteDialog` — **D7**), `components/EditorWysiwyg.vue:980-985`, commented-out pug blocks (`AdminStorage.vue`, `Search.vue`, `EditorWysiwyg.vue`, `GroupEditOverlay.vue`, `UserSearchDialog.vue`), `pages/AdminStorage.vue:1013-1018` (`configIfCheck`) and `:1235-1253,1269,1391` (`las` glyphs → `img:` SVG — **D10**), `css/_animation.scss`, `css/_base.scss:82-95`, `css/_theme.scss` (`$accent`, `$header`, `$info`), `boot/{externals,eventbus,api}.js`, `router/index.js`, `components/HeaderSearch.vue:543,551`, `pages/AdminSystem.vue:381-393` (SSR branches), `stores/editor.js:22-30`, `stores/site.js:87,116` (dead keys), `helpers/pageRedirect.js` (`emptyRedirect` + test), `helpers/accessibility.js` (`meetsWcagAA` → inline in `WBtn.test.js`).
- Findings: INFRA-F1, F2, F7, F13, F18, F21, F24; VIEW-F8 (**D6**), F9 (**D6**), F10 (**D7**, **D10**).

- [ ] **Step 1:** Re-run each grep quoted in the findings to confirm zero importers, then delete.
- [ ] **Step 2:** `UserEditOverlay.vue`: replace `async function deleteUser() {}` with opening `UserDeleteDialog` via `dialog({ component: UserDeleteDialog, componentProps: { userId } })` the way `AdminUsers.vue` opens it (read that call site and mirror it); add a test in `UserEditOverlay.test.js` that clicking the button opens the dialog.
- [ ] **Step 3:** `_animation.scss`: keep lines 1-24, 57-71, 91-107, 145-153. Confirm `css/_base.test.js` doesn't assert on the removed `_base.scss` rules.
- [ ] **Step 4: Verify** `npx oxlint --deny-warnings`, `npx vitest run` on every touched file's test + `src/i18nSourceGate.test.js` + `router/routes.test.js` + `wComponentAttributeDrift.test.js`; `cd backend && node --test locales/en.test.ts` (dead-key list) and `node --test test/docs-todo-fixme-drift.test.ts` (variances bullet). **Step 5: Commit** `chore(frontend): delete dead components, stub pages, SSR branches, dead styles and store keys` (body: D6, D7, D10).

### Task B2: Module-config form, site images, delete dialogs, password strength, guests id, overlay route

**Files:** modify `pages/{AdminAnalytics,AdminAuth,AdminComments,AdminStorage}.vue`, `components/ModuleConfigForm.vue` (adopt the `div`/`text-orange` readOnly rendering); create `composables/siteImage.js` (+test), `helpers/systemIds.js`, `composables/adminOverlayRoute.js` (+test); modify `helpers/siteImages.js` (`isSharpAvailable`), `pages/{AdminGeneral,AdminLogin}.vue`, delete `components/{Group,Webhook,Asset,Folder}DeleteDialog.vue` and convert `pages/AdminGroups.vue`, `pages/AdminWebhooks.vue`, `components/FileManager.vue` to `confirm({ destructive: true, persistent: true, … })`; `helpers/passwordStrength.js` (`passwordStrengthBadge(password, t)`), `helpers/randomPassword.js` (`PASSWORD_CHARSET`, `PASSWORD_CHARSET_UNAMBIGUOUS`), `components/{UserCreateDialog,ChangePwdDialog,UserChangePwdDialog,AuthLoginPanel}.vue`; `components/{ApiKeyCreateDialog,UserCreateDialog,UserEditOverlay,GroupEditOverlay}.vue`, `pages/AdminAuth.vue`, `stores/user.js` → `GUESTS_GROUP_ID`; `pages/{AdminUsers,AdminGroups}.vue` → `useAdminOverlayRoute`.
- Findings: VIEW-F1, F2, F4, F5, F6, F12.

**Interfaces:**
```js
// composables/siteImage.js
export function useSiteImage(kind /* 'logo'|'favicon'|'loginBg' */, { siteId, has, i18nPrefix, loading }) // → { upload, clear, timestamp }
// helpers/siteImages.js
export async function isSharpAvailable()
// helpers/passwordStrength.js
export function passwordStrengthBadge(password, t) // → { color, label } against common.password.*
// helpers/randomPassword.js
export const PASSWORD_CHARSET, PASSWORD_CHARSET_UNAMBIGUOUS
// helpers/systemIds.js
export const GUESTS_GROUP_ID = '10000000-0000-4000-8000-000000000001'
// composables/adminOverlayRoute.js
export function useAdminOverlayRoute({ overlay, listPath, onClosed })
```

- [ ] **Step 1:** Tests first for `useSiteImage` (upload success/invalid-type/error toasts, `has` flag, timestamp bump), `passwordStrengthBadge` (the five bands), `useAdminOverlayRoute` (route-param watcher opens the overlay; closed → `onClosed`). Run → fail; implement.
- [ ] **Step 2:** Convert the pages; the three admin i18n `pwdStrength*` keys become unused — delete them from `en.json` (Lane B owns those keys). Delete the four dialogs and `AdminStorage.configIfCheck`.
- [ ] **Step 3: Verify** lint, vitest on every touched component/page test + `helpers/{moduleConfig,passwordStrength,randomPassword}.test.js` + `components/ModuleConfigForm.test.js` + `stores/user.test.js` + `src/i18nSourceGate.test.js`; `cd backend && node --test locales/en.test.ts`. **Step 4: Commit** `refactor(frontend): shared module-config form, site image composable, destructive confirm, password badge, guests id, overlay route`.

### Task B3: `useAdminSettings`

**Files:** create `frontend/src/composables/adminSettings.js` (+test); modify the 16 settings pages (`AdminGeneral`, `AdminTheme`, `AdminLogin`, `AdminLocale`, `AdminEditors`, `AdminAnalytics`, `AdminBlocks`, `AdminComments`, `AdminSearch`, `AdminStorage`, `AdminApprovals`, `AdminGlossary`, `AdminNavigation`, `AdminPagesDeleted`, `AdminMail`, `AdminSecurity`, `AdminFlags`, `AdminSystem` — site-scoped ones pass `siteScoped: true`) and the seven `refresh()` copies.
- Finding: VIEW-F3.

**Interface:**
```js
export function useAdminSettings({ i18nPrefix, siteScoped = true, defaults, fetch, pick, commit, onSavedCurrentSite })
// → { state /* { loading, config } */, load, save, refresh }
// load: state.loading++, loading.show(), fetch(siteId) → toMerged(defaults(), pick(site)), on error notify.negative({ message: t(`${i18nPrefix}.loadFailed`), caption: apiErrorMessage(err) }), finally hide/--
// save: state.loading++, commit(siteId, state.config), notify.positive saveSuccess, on error caption: t(`${i18nPrefix}.${err.data?.error}`, apiErrorMessage(err)), finally --; then onSavedCurrentSite if adminStore.currentSiteId matches siteStore.id
// refresh: await load(); notify.positive(t(`${i18nPrefix}.refreshSuccess`))
// siteScoped: watch(() => adminStore.currentSiteId, load) + onMounted guard
```

- [ ] **Step 1:** `adminSettings.test.js` covering load/save/refresh happy + error paths, the site watcher, `onSavedCurrentSite` gating. Run → fail; implement.
- [ ] **Step 2:** Convert one page at a time, running its `Admin*.test.js` after each (they assert toast/loading behaviour). Normalise the drift the finding lists (missing captions, raw `'An unexpected error occured.'` fallbacks → `apiErrorMessage`).
- [ ] **Step 3: Verify + Commit** `refactor(frontend): useAdminSettings for the settings pages`.

### Task B4: Tree loader, API-key surfaces, library composables, stores

**Files:** create `helpers/treeNodes.js` (+test), `helpers/apiKeyState.js` (+test), `composables/apiKeyCreateForm.js` (+test), `composables/fieldFrame.js` (+test), `components/shared/WFieldFrame.vue` (internal, not registered), `components/shared/metrics.js`, `composables/anchoredFloat.js` (+test), `helpers/pointerDrag.js` (+test), `composables/toggleModel.js` (+test), `helpers/markdownFences.js` (+test); modify `components/{FileManager,TreeBrowserDialog,LinkPickerDialog}.vue`, `components/{ApiKeyCreateDialog,ProfileApiKeyCreateDialog}.vue`, `pages/{AdminApi,ProfileApi}.vue`, `components/shared/{WInput,WSelect,WIcon,WSpinner,WCircularProgress,WSignal,WAvatar,WTable,WTd,WMenu,WTooltip,WColorPicker,WRange,WCheckbox,WToggle}.vue`, `composables/screen.js` (+ 8 `gt.*` readers), `stores/page.js`, `stores/editor.js` (`markClean`, `markDirty`, `ensureConfigs`), the 8 component sites writing `lastChangeTimestamp` bare, `stores/user.js` (+test, one `formatDateTime`), `helpers/datetime.js` (+ `isPast(iso)` used by `AdminApi`/`ProfileApi`), `helpers/injectCss.js`, `helpers/fonts.js`, `App.vue` (`replaceHeadStyle`), `helpers/{markdownBlocks,markdownTable}.js`, `helpers/renderedContent.js` (`interceptableUrl`).
- Findings: VIEW-F7, F11; INFRA-F3, F10, F11, F12, F14–F17, F19, F20, F23.

**Interfaces:**
```js
export function mergeFolderEntries(treeNodes, entries, parentId) // → { roots }  (pure)
export async function fetchTreeEntries(siteId, { parentId, parentPath, types, locale, initLoad })
export function isExpired(key), keyState(key), stateHint(key, t), isUsable(key), siteName(key, sites), classificationLevelName(s)(...)   // helpers/apiKeyState.js
export function useApiKeyCreateForm({ endpoint, i18nPrefix, extraJson }) // → { state, expirations, siteOptions, allowedClassifications, keyNameValidation, loadSites, create }
export const fieldProps; export function useFieldFrame({ props, active, error, hovered, hasValue, hasLeadingAdornment, noFrame }) // → { hasFloatingLabel, isFloating, floatColorClass, frameColor, frameWidth, controlStyle, outlineStyle, controlClasses, showsBottom, errorMessage, validate }
export const NAMED_SIZES, CELL_ALIGN; export function resolveSize(size)
export function useAnchoredFloat({ placeholderEl, floatEl, closest, anchor, self, offset, beforeMeasure }) // → { triggerEl, floatStyle, reposition }
export function trackPointerDrag(ev, el, onMove)
export function useToggleModel(props, emit) // → { isOn, toggle }
export function linesOutsideFences(lines, visit)
// stores/editor.js: markClean(extra?), markDirty(), ensureConfigs()
// stores/page.js: module-level pagePatch(pageData), BLANK_PAGE
// stores/user.js: formatDateTime(t, date, { seconds = false, zone = false })
// helpers/injectCss.js: replaceHeadStyle(id, css); helpers/datetime.js: isPast(iso)
```

- [ ] **Step 1:** Pure helpers with tests first (`treeNodes`, `apiKeyState`, `markdownFences`, `pointerDrag`, `toggleModel`, `anchoredFloat`, `fieldFrame`), run → fail → implement → pass.
- [ ] **Step 2:** Convert components/stores; `WInput`/`WSelect` keep their public props and emitted events exactly (their 389/424-line tests are the gate); `screen.js` drops `gt`; `user.js` collapses the four formatters and its test's three describes become option cases.
- [ ] **Step 3: Verify** lint + vitest on every touched test (`WInput`, `WSelect`, `WForm`, `WMenu`, `WTooltip`, `WRange`, `WCheckbox`, `WToggle`, `WIcon`, `WTable`, `FileManager`, `TreeBrowserDialog`, `ApiKeyCreateDialog`, `ProfileApiKeyCreateDialog` incl. the real-Chromium describes, `AdminApi`, `ProfileApi`, `stores/{page,editor,user}`, `screen`, `injectCss`, `fonts`, `markdownBlocks`, `markdownTable`, `renderedContent`, `App`, `PageHeader`, `EditorMarkdown`, `EditorWysiwyg`, `EditorCode`, `EditorAsciidoc`, `EditorRedirect`, `PageTags`). **Step 4: Commit** `refactor(frontend): shared field frame, tree loader, api-key form, float/drag/toggle composables, store dedupes`.

### Task B5: Frontend long-file splits

**Files (each its own commit, verbatim moves):**
1. `renderers/markdown.js` → `renderers/modules/markdown-it-icon-shortcode.js`, `markdown-it-tex.js`, `markdown-it-mdc-compat.js` (INFRA-F25)
2. `pages/Index.vue` → `pages/index/pageRouting.js` (`enterCreateMode(route)`, `enterEditMode(route)`, `loadPageForRoute(route, generation)`), `helpers/blockScan.js` (`collectBlocksToLoad(root, blocksIndex)`) (VIEW-F13.1)
3. `components/EditorMarkdown.vue` → `helpers/markdownInsert.js`, `composables/previewResize.js`, `composables/markdownCollab.js` (update `EditorMarkdown.deadcode.test.js`'s path) (VIEW-F13.2)
4. `components/FileManager.vue` → `composables/fileUpload.js`, `composables/fileManagerActions.js` (VIEW-F13.3)
5. `components/GroupEditOverlay.vue` → `components/GroupRulesEditor.vue` (v-model `rules`), `components/GroupUsersPanel.vue` (prop `groupId`) (VIEW-F13.4)
6. `components/AuthLoginPanel.vue` → `components/AuthTfaScreens.vue`, `components/AuthRegisterScreen.vue` (VIEW-F13.5)
7. `pages/AdminStorage.vue` → `helpers/storageDeliveryGraph.js` (`generateGraph(targets)` pure, with a unit test) (VIEW-F13.6)
8. `pages/Graph.vue` → `pages/graphDraw.js`, `pages/graphSimulation.js` (VIEW-F13.7)
9. `components/PageHeader.vue` → `composables/pageSaveFlow.js` (VIEW-F13.8)
10. `components/PageHistoryOverlay.vue` → `composables/monacoDiff.js` (VIEW-F13.9)
11. `components/EditorWysiwyg.vue` → `helpers/wysiwygMenuBar.js` (`buildMenuBar(editorRef, { TEXT_COLORS, HIGHLIGHT_COLORS })`) (VIEW-F13.10)

- [ ] For each: move code verbatim behind the named seam, keep the SFC's template and public props/emits identical, run that file's existing tests (they are the regression net; `Graph.test.js`, `Index.test.js`, `EditorMarkdown.test.js` are large — run them whole), lint, `npm run icons:check` if any literal icon string moved files, then commit `refactor(frontend): split <file> — <what moved>`.

### Task B6: Frontend test harness and suite splits

**Files:** create `frontend/test/i18n.js`, `test/router.js`, `test/mount.js`, `test/fixtures.js`, `test/sourceFiles.js`; modify `test/mocks.js` (`stubApi`), `test/setup.js` (register `BlueprintIcon` globally — pick that policy); convert test files (`createI18n` ×196, `createRouter` ×103, the 76 mount helpers, 92 store seeds, 24 `mockImplementation` URL switches, 7 file walkers, 7 `docsBase` scanners → one in `src/i18nSourceGate.test.js` style); split `stores/page.test.js`, `pages/Graph.test.js` (+ `pages/graphFixtures.js`), `components/EditorMarkdown.test.js` (+ `editorMarkdownHarness.js`), `pages/Index.test.js`, `App.test.js` (logout → `App.logout.test.js`), `components/PageActionsCol.test.js` (+ harness), `components/HeaderSearch.test.js`; express the byte-identical cross-component `it()`s as `describe.each`.
- Findings: TEST-F3, F4, F5, F11, F13.8/9, F14 (frontend rows), F15.

**Interfaces:**
```js
export function createTestI18n(messages = {})  // nests under en; accepts flat-dotted or nested; missingWarn/fallbackWarn off
export async function createTestRouter(routes = ['/'], initialPath = '/') // strings → stub routes, objects pass through; push + isReady
export function mountWithApp(Component, { props, messages, routes, initialPath, stores: { site, user, page, admin, editor, flags }, stubs = { teleport: true }, components, attachTo }) // → { wrapper, siteStore, userStore, pageStore, adminStore, editorStore, flagsStore }
export function seedSite(overrides), seedUser(overrides), seedPage(overrides), seedAdmin(overrides), stubRouter(overrides)
export function stubApi(routes, { method = 'get', fallback } = {}) // string keys exact, RegExp keys prefix, function values per-call; returns { calls }
export function listSourceFiles(root, { ext, skip })
```

- [ ] **Step 1:** Land the harness with its own tests; convert `pages/Admin*` first, then `components/*Dialog`, then the rest; keep store seeding opt-in (`ProfileInfo.test.js` asserts on the unseeded store). `FileManager.test.js`'s five `createWebHistory()` routers: verify each test still passes on memory history before converting, otherwise pass the object form through.
- [ ] **Step 2:** Split the seven oversized suites along the describe ranges in TEST-F14.
- [ ] **Step 3: Verify** every converted/split file, lint. **Step 4: Commit** in batches: `test(frontend): shared i18n/router/mount harness …`, `test(frontend): split oversized suites`.

---

# Lane C — blocks + e2e

### Task C1: Blocks/e2e dead items and shared primitives

**Files:** delete `e2e/fixtures/test-upload.png`; modify `e2e/playwright.config.js:43` (drop `BASE_URL` export), `blocks/package.json` (drop `main`), `blocks/vitest.config.js:21-24` (stale comment), `blocks/shared/compress.js:1-5` (comment: `pako` still used by drawio); create `blocks/shared/styles.js` (`errorBox`, `captionStyles`), `blocks/shared/props.js` (`boolean`), `blocks/shared/body.js` (`readFencedSource`), `blocks/shared/render.js` (`renderError`), `blocks/shared/figure.js` (`explainSourceFailure`), extend `blocks/shared/icons.js` (`MDI_PATHS`, `inlineIcon`), unify `fetchSite()` in `shared/site.js` (config.js imports it; one `_resetSiteCache()`); convert all 21+9+9 block call sites; tests for each new shared file (`shared/*.test.js`, not ending in `.test.js` only for helpers under `blocks/test/`).
- Findings: BLK-F1, F4 (helpers), F5, F7, F8.

**Interfaces:**
```js
export const errorBox = css`.error { color: var(--q-negative, #c10015); border: 1px dashed color-mix(in srgb, currentColor 50%, transparent); border-radius: 5px; padding: 1rem; white-space: pre-wrap }`
export const captionStyles = css`.caption { … } :host([dark]) .caption { … }`
export const boolean = { converter: { fromAttribute: (v) => v !== null && v !== 'false', toAttribute: (v) => (v ? 'true' : null) } }
export function readFencedSource(el) // → { source, fenced }
export function renderError(message) // → html`<div class="error">${message}</div>`
export function explainSourceFailure(verb, err, fenced) // "This <verb> could not be …: <msg>" + fence hint when !fenced
export const MDI_PATHS = { previous, next, close, zoomIn, zoomOut, open }; export function inlineIcon(path)
export async function fetchSite() // one promise-cached GET /_api/sites/current, cleared on failure
export function _resetSiteCache()
```

- [ ] **Step 1:** Tests for the six shared files (converter `"false"` path, `readFencedSource` with and without `<pre>`, `explainSourceFailure` hint, `fetchSite` single request across `getSiteId`+`getBlockConfig`). Run → fail; implement.
- [ ] **Step 2:** Convert every block: `static styles = [errorBox, css\`…\`]` (delete the duplicated `.error` rules incl. the ten double declarations; `block-index`'s `.no-links` and `block-include`'s inline style adopt it), `boolean` import, `readFencedSource`, `renderError`, `inlineIcon`. Ten tests that reset caches switch to `_resetSiteCache()`.
- [ ] **Step 3: Verify** `npx oxlint --deny-warnings`, `npx vitest run shared/ block-*/component.test.js definitions.test.js` (all block suites are touched, so run them), `node scripts/check-locale-keys.mjs` if it exists as an npm script (`npm run` to list), `npm run build`. **Step 4: Commit** `refactor(blocks): shared error box, boolean converter, fenced-source read, single site fetch`.

### Task C2: Video-embed and diagram-image base classes; pdf split

**Files:** create `blocks/shared/video-embed.js` (+test), `blocks/shared/diagram-image.js` (+test); modify `block-youtube`, `block-vimeo`, `block-dailymotion`, `block-m365-video`, `block-kroki`, `block-plantuml`, `block-drawio` (styles only), `block-katex`, `block-mathjax`, `block-diagram` (figure helpers); create `block-pdf/styles.js`, `block-pdf/toolbar.js`.
- Findings: BLK-F2/INFRA-F5, BLK-F3/INFRA-F4, BLK-F4, BLK-F9.

**Interfaces:**
```js
export class VideoEmbedElement extends LitElement { static styles = [errorBox, playerStyles]; static properties = { url, width, height, autoplay, controls, fs, loop }; _size(v); _frameStyle(); render() /* calls this._parse(url) → id | null, this._embedUrl(parsed); invalid → renderError(I18n string) */ }
export class DiagramImageElement extends LitElement { static styles = [errorBox, captionStyles, diagramStyles]; static properties = { server, format, caption, align, _src, _error }; firstUpdated() /* readFencedSource → this._ready = this._draw(source) */; _draw(source) /* MAX_DIAGRAM_URL_LENGTH guard */; _measure(); _explain(response); render(); abstract _url(source); _explainBody(response) { return null } }
// block-pdf/styles.js: export const viewerStyles, textLayerStyles; block-pdf/toolbar.js: export function renderToolbar(state, handlers)
```

- [ ] **Step 1:** Base-class tests with a minimal subclass each (invalid URL → error, `aspect-ratio` default style, width/height px; diagram: empty source error, URL-too-long error, `_explainBody` hook honoured). Run → fail; implement.
- [ ] **Step 2:** Convert the six blocks — each keeps its literal `static definition`, its parser/encoder and its two hooks; vimeo/dailymotion adopt the `I18n` error strings youtube resolves. m365 overrides the source hook. Move pdf styles/toolbar out.
- [ ] **Step 3: Verify** lint, vitest on the ten block suites + new shared tests + `definitions.test.js`, `npm run build`. **Step 4: Commit** `refactor(blocks): VideoEmbedElement and DiagramImageElement bases; pdf styles/toolbar split`.

### Task C3: Blocks test harness and e2e helpers

**Files:** create `blocks/test/mount.js` (`mountBlock(tag, { text, html, pre, props, attrs, settle })`, `resetBlockDom()`, `stubSiteFetch()`), `blocks/test/darkMode.js` (`describeDarkMode(mount, { inverted })`); convert all 26 `component.test.js` (delete the 26 mount copies, 11 dark-mode describes — keep `block-diagram`'s bespoke one — and 4 `stubFetch`s; add `describeDarkMode` to the 10 blocks that use `DarkMode` with no assertion); e2e: `e2e/helpers/admin.js` gains `submitLogin(page, email, password)`, `openMarkdownEditor(page, { path, title, origin, locale })`, `typeBody(page, body, { paste })`, `savePage(page, path, { locale })`; `createAndPublishPage` composes them; `expectAuthenticatedShell` uses `authenticatedShellMarker`; `multi-site.spec.js`, `permissions.spec.js`, `csp.spec.js`, `assets.spec.js` call the helpers.
- Findings: TEST-F8, BLK-F6.

- [ ] **Step 1:** Land the two harness files; convert block suites; run `npx vitest run` over all `block-*/component.test.js` + `shared/`.
- [ ] **Step 2:** e2e helpers; syntax/lint check only (`cd e2e && npx oxlint --deny-warnings` if configured, else `node --check` each file) — the Playwright suite needs a built stack and is run in Lane D.
- [ ] **Step 3: Commit** `test(blocks,e2e): mountBlock/describeDarkMode harness; composable e2e login and editor helpers`.

---

# Lane D — after A, B, C complete

### Task D1: Documentation sync, full gates, build and e2e

**Files:** `CLAUDE.md`, `docs/variances.md` (only if a lane left a note), delete `docs/superpowers/plans/claude-md-notes.md` after folding it in.

- [ ] **Step 1:** Fold every bullet of `claude-md-notes.md` into CLAUDE.md in the section it belongs to; delete the stale first blocks paragraph (the one claiming checklist/index/include still read SPA globals); fix the Testing (blocks) bullet claiming `shared/` has no tests and the "copy verbatim" sentence (point at `describeDarkMode`); document `helpers/pageAccess.ts`, `siteResolution.ts`/`localeRouting.ts`/`moduleProps.ts`, `core/http/*`, `moduleRegistry.ts`, `clusterCache.ts`, `test/fastify.ts#buildTestApp`, `test/mocks.ts#createWikiStub`, frontend `test/mount.js#mountWithApp`, `composables/adminSettings.js`, `blocks/shared/{styles,props,body,video-embed,diagram-image}.js`, the `api/pages/` etc. layout, the models split, and the D1–D10 behaviour notes where CLAUDE.md describes the affected behaviour. Keep CLAUDE.md's existing voice; do not add a changelog.
- [ ] **Step 2:** Full gates from the worktree root: `cd backend && npm run typecheck && npx oxlint --deny-warnings`; `cd frontend && npx oxlint --deny-warnings && npm run icons:check`; `cd blocks && npx oxlint --deny-warnings`; `npx --prefix backend oxfmt --check backend frontend blocks`; `cd backend && node --test 'test/**/*.test.ts'` (the structural/doc suites — they guard CLAUDE.md/docs against the tree); `cd frontend && npx vitest run src/i18nSourceGate.test.js src/wComponentAttributeDrift.test.js`; `cd blocks && npx vitest run definitions.test.js`.
- [ ] **Step 3:** `cd frontend && npm run build`; `cd blocks && npm run build`; then `cd e2e && DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56001/postgres E2E_PORT=3010 npm test` (port 3000 is taken on this machine; install browsers first with `npm run install-browsers` if missing). Report the result verbatim; a failure here is investigated with superpowers:systematic-debugging, not waved through.
- [ ] **Step 4:** `git diff --shortstat scarlett..HEAD` per workspace for the PR summary; commit `docs: sync CLAUDE.md with the consolidated layout`.
