# Codebase consolidation — design

Date: 2026-09-02. Branch: `consolidation` (worktree off `scarlett` @ `e19aaa72`). To be reviewed
and merged back into `scarlett` as one PR.

## Goal

Same functionality, cleaner and smaller codebase. Four kinds of change, in priority order:

1. **Delete dead code** — orphaned modules, hollow features, impossible fallbacks, unused exports.
2. **Extract utilities** — logic copy-pasted across N files becomes one helper / composable / base
   class / shared test fixture.
3. **Split long files** by responsibility (never by line count), following seams the code already has.
4. **Rewrite** a feature only where a clean rewrite preserving behaviour is clearly smaller than
   incremental cleanup. The surveys found exactly one such candidate (the `system.ts` flag-toggle
   triplet); everything else is extraction or relocation.

## Non-goals

- Security review (a separate pass will do that). Nothing here is motivated by security.
- Behaviour changes, new features, dependency upgrades, cosmetic renames, reformatting untouched files.
- Test coverage reduction. Test *expression* is consolidated; no assertion is dropped unless the
  code it asserts on is deleted.

## Evidence

Seven read-only survey reports under `2026-09-02-consolidation-surveys/` — one per area — with
verified `file:line` citations for every finding plus a "checked and rejected" list each, so
reviewers need not re-derive them. Finding IDs below (`API-F1`, `MOD-F2`, `CORE-F3`, `VIEW-F4`,
`INFRA-F5`, `BLK-F6`, `TEST-F7`) refer to those reports. The survey directory is review evidence and
can be dropped at merge time.

## Ground rules for every change

- Baseline is green: `npm run typecheck` (backend), `npx oxlint --deny-warnings` in
  `backend/`, `frontend/`, `blocks/`, and `npx --prefix backend oxfmt --check backend frontend blocks`
  all pass at `e19aaa72`. Every task leaves them green.
- Tests scoped to the files touched run per task (the user's standing rule is never to run whole
  suites); DB-backed suites run against the local test Postgres (`DATABASE_URL` on port 56001).
- CLAUDE.md conventions are binding: `es-toolkit` not lodash, `Temporal` not luxon, `import type`,
  erasable-only TS syntax, co-located tests, `W*` components via the registry, no invented
  permission names, no legacy fallbacks, extension-sensitive dynamic imports stay literal.
- A `static definition = {…}` in a block's `component.js` must stay a plain literal (the rollup
  manifest, the locale-key checker and `definitions.test.js` read it from the AST) — only styles,
  properties, helpers and lifecycle can move to `blocks/shared/`.
- Three backend structural tests (`api/routeTags.test.ts`, `api/responseErrors.test.ts`,
  `api/index.test.ts`) scan `api/` **non-recursively** and `import().default(app)` every top-level
  `.ts`. Any `api/<name>/` split must make those scanners recursive in the same change, and no
  non-route module may sit at `api/*.ts`.
- One commit per task, conventional message, so the PR is reviewable task by task.
- CLAUDE.md is updated in the same task that changes what it documents (new helpers, moved files,
  the stale blocks paragraph, the stale test-coverage bullets).

## Decisions taken without asking (flagged for review)

These are behaviour-adjacent. Each is judged correct and small; any can be reverted at review.

| # | Decision | Why |
| --- | --- | --- |
| D1 | Unknown `:siteId` → one `404 'This site does not exist.'` from the shared `siteEnabledPreHandler`, for **every** `:siteId` route, replacing 36 hand-written checks in two spellings. | Routes that lacked the check already answered 404 (as "page does not exist"); this harmonises message and status. |
| D2 | `api/diagrams.ts` hostname lookup goes through `normalizeHostname` like every other lookup. | It was the one case-sensitive lookup the helper exists to prevent (CORE-F11). |
| D3 | `sftp` storage adopts `helpers/blobTarget.ts` thresholds (1024-based, `>=`) instead of its private 1000-based `>` copy. | `blobTarget.ts` is the documented single parser (OpenProject #927); sftp was the outlier (CORE-F4). |
| D4 | Delete the storage `setup`/`setupDestroy` extension point and its two always-throwing API routes. | Zero implementors; the routes could never succeed (CORE-F15). |
| D5 | Delete `migration/`'s multi-source conflict-policy machinery (`AuthenticationMapperState`, `ConflictPolicy`, `disambiguateDisplayName`, `remapAutoEnrollGroups`). | Zero production callers; the importer was just reset into a one-shot tool (CORE-F2 1f). |
| D6 | Delete `AdminRendering.vue` (empty `load`/`save`, fake data) and `MailTemplateEditorOverlay.vue` (imports an uninstalled package, never registered) with their routes, nav entries and i18n keys. | Both are experimental-flag-gated hollow scaffolding that renders nothing useful (VIEW-F8/F9). |
| D7 | `UserEditOverlay`'s "Delete user" button opens the existing `UserDeleteDialog` instead of calling an empty function. | A live button wired to `async function deleteUser() {}` is a bug, and the dialog already exists (VIEW-F10). |
| D8 | Drop the three CLAUDE.md-banned "old data" fallbacks in search engines (`hasUnbackfilledDocuments`, `updatedAt instanceof Date`, `rows.rows ?? rows`). | Impossible-case handling the project rules forbid (CORE-F6). |
| D9 | `index.ts` keeps exactly one `unhandledRejection` handler: `processGuards.ts`'s, given an `exit` option. | The second could never run (CORE-F9). |
| D10 | `AdminStorage`'s delivery-graph `las` webfont glyphs become inline SVG `img:` icons. | No such font is loaded; the glyphs render as tofu (VIEW-F10). |

Found during implementation, in the same spirit — each is a consequence of folding two near-identical
things into one, not an independent change of intent:

| # | Decision | Why |
| --- | --- | --- |
| D11 | `api/apiKeys` + `users/profile` API-key creation: a body with TWO faults now reports a different fault first (name → siteId → classifications → groups; was name → groups → siteId → classifications). Single-fault messages unchanged. | One shared validator for both routes; the order is the shared one (A8). |
| D12 | `block-plantuml` inherits kroki's `_measure()`/`is-unsized` fallback. | Falls out of the shared `DiagramImageElement`; only fires for an image with no intrinsic size (C2). |
| D13 | `block-vimeo`/`block-dailymotion` resolve their error strings through `I18n` (one locale fetch on connect, cached per locale). | Matches `block-youtube`; the four keys do not exist yet, so both still render their unchanged English fallbacks (C2). |
| D14 | Password-strength label "Medium" → "Average" in the three admin password dialogs. | Unified onto the one `common.password.*` key set (B2). |
| D15 | The webhook/asset/folder/group delete confirmations use `WConfirmDialog` (`destructive`): no in-dialog loading state, no retry-in-place on failure (the toast still reports it). | Four bespoke dialogs that only confirmed, folded into the shared one (B2). |
| D16 | `autocomplete="new-password"` now applies to sensitive module-config inputs on Analytics/Auth/Comments. | The shared `ModuleConfigForm` already did this; the three private copies did not (B2). |
| D17 | `useAdminSettings`: save-failure captions on Analytics/Flags/Security try the `admin.<page>.<errorCode>` key before the raw message; Refresh on AdminBlocks/AdminEditors raises the loading overlay; the success toast precedes the store patch on Theme/Editors. | The settled shape every other settings page already had (B3). |
| D18 | `GroupUsersPanel` renders a loading table instead of a blank page when landing directly on a group's users section. | Falls out of the shared panel's own loading state (B5). |
| D19 | `models/userCredentials.verifyTfaCode` returns `false` for an account deleted mid-verification (was `true`). | The extracted `patchStrategyAuth` re-reads the row inside the advisory lock and declines the write when there is no row (A10). |
| D20 | s3 `getDirectUrl` failure string "Failed to presign …" → "Failed to generate a direct-access URL for …"; a malformed sftp `largeThreshold` falls back to `Infinity` instead of throwing out of `exportAssets`. | Matches azure/gcs and `helpers/blobTarget.ts` respectively (A12, D3). |
| D21 | A live migration run in which a phase created nothing exits 0 (was reclassified `not_implemented` → exit 1). | `trackWriteCapability` is gone: every phase has a real write path, so an empty phase is an empty phase (A19). |
| D22 | `helpers/treeNodes.js#fetchTreeEntries` omits `locale` from the query when nullish (File Manager previously sent `locale=null`). | One loader for three callers; `null` in a query string was the outlier (B4). |
| D23 | `stores/page.js#pageUnlock` also resets `password`/`removePassword` (via `pagePatch`). | The shared patch is what "unlock" means; the partial reset was an omission (B4). |
| D24 | After the api splits, an unmatched `Content-Type` sent to a route in `api/pages/`, `api/users/` or `api/system/` outside the sub-plugin owning the parser answers 415 (`FST_ERR_CTP_INVALID_MEDIA_TYPE`) instead of being parsed by the resource-wide parser and failing validation with 400. Notably `application/octet-stream` to a non-transfer `/system` route no longer writes an upload file before failing. | `register()` is a real encapsulation boundary; the narrower scope is the correct one (A17). |

Left alone as genuine behaviour questions (noted for triage, not changed): `approvals.getActorGroupIds`
vs `groups.groupIdsForRequest` on API-key requests; `approvals.matchesPage` case folding;
`WCircularProgress`/`WSpinner` merge; dropping `pako`.

## Workstreams

Ordered so that deletions land first (they simplify everything after), shared helpers next, then
the splits that depend on the helpers, then tests. Within a workstream, tasks are sequenced to avoid
two agents editing one file; across workstreams (backend / frontend / blocks) they are independent.

### WS0 — Deletions (all workspaces, low risk, ≈ −6,500 LOC)

| Item | Ref |
| --- | --- |
| `backend/importer/` (5 src + 7 test files) and the two prose references | CORE-F1 / TEST-F12 |
| `helpers/redirect.ts` + test; `createDeferred` → `Promise.withResolvers` | CORE-F7, F8 |
| Migration dead code: `assignTreePaths` & types, `ContentStagingIndex.locations`, `siblingsByOldId`/`hash`/`sourceAuthorId`/`sourceCreatorId`, batch wrappers + result types + stub converters, `IdMap` class, conflict-policy machinery (D5), `staticUnmappable`, `'no-destination-table'`, `PageImporter.failed/.warnings`, duplicate `--only` validation, `streamedLocationKey` dup | CORE-F2 |
| Storage `setup`/`setupDestroy` surface (D4); `git/storage.ts` undispatchable `ensureRepo` handler | CORE-F15 |
| Search "old data" fallbacks (D8); seven in-file-only `export`s; `models/search.getActiveEngine` | CORE-F6, F19 |
| `rulesAllowSite`, `getTypeDefaultValue` un-export; `index.ts`/`db.ts` commented-out 2.x code; second `unhandledRejection` handler (D9) | CORE-F19, F12, F9 |
| `contentSync` five dead readers + duplicated count query; models dead methods (`approvals.countSubmissions`, `sessions.getByUser/clearAllSessions`, `authentication.getStrategy`, `blockCredentials.deleteSiteCredentials`, `commentProviders.canonicalPageUrl/getActiveProvider`, `rendering.sanitize`, `tree.listDescendantPages`, `AssetAtPath`, `ReviewerScope.actor`, redundant clause in `mayHoldPermissionSomewhere`); un-export in-file consts | MOD-F4, F8, F9 |
| `req.query.limit ?? N` dead fallbacks (AJV `useDefaults`) | API-F9 |
| `frontend/src/helpers/monacoTypes.js` + its `docs/variances.md` bullet; `WRating`/`WTree`/`WTreeNode` + registry entries | INFRA-F1, F2 |
| `AdminRendering.vue`, `MailTemplateEditorOverlay.vue` + route/nav/i18n (D6); no-op handlers (`sendWelcomeEmail`, `EditorWysiwyg.insertTable/snapshot`), commented-out pug blocks, `AdminStorage.configIfCheck`, `las` glyphs (D10), `deleteUser` wiring (D7) | VIEW-F8, F9, F10 |
| `css/_animation.scss` dead half; `_base.scss`/`_theme.scss` leftovers; `import.meta.env.SSR` branches; dead store keys; `emptyRedirect`, `meetsWcagAA` | INFRA-F7, F21, F13, F18, F24 |
| `e2e/fixtures/test-upload.png`, unused `BASE_URL` export, `blocks/package.json` `main`, stale comments in `blocks/vitest.config.js` / `compress.js`, stale CLAUDE.md blocks paragraph + test-coverage bullet | BLK-F7 |
| Duplicate tests: `api/pages.test.ts` export-pdf and apiKeySitePin describes, doubled `setUserGroups` describe, three `en.json` duplicate-key guards → one, README overlap; relocate `test/apiKeySitePinCoverage.test.ts` and `locales-en.test.ts` to co-located homes | TEST-F13 |

### WS1 — Backend shared helpers (≈ −1,900 LOC)

Sequenced in one lane because they overlap on `api/pages.ts`, `api/comments.ts`, `api/approvals.ts`:

1. **`helpers/pageAccess.ts`** — move `actorFrom`, `mayBypassPassword`, `unlockedFor`, `mayOnPage`,
   `pagePermissionsFor`, `loadReadablePage` (absorbing `loadWatchablePage`/`loadSuggestablePage`),
   `mayOnAsset`, `mayOnFolder`, `visibleTreeItems` out of route files; add
   `requireReadablePage(req, reply, siteId, pageId, { permission, forbiddenMessage, withContent, allowLocked })`
   and `requireActorId` (replacing `callerOf`/`watcherOf`); `controllers/files.ts`/`thumb.ts` call
   `mayOnAsset`. Helper tests move alongside. (API-F1, F6, F8)
2. **Site preamble + params schemas + delegation gate** — extend `siteEnabledPreHandler` with the
   unknown-site 404 (D1) and delete the 36 copies; `api/schemas/params.ts` (`SiteIdParams`,
   `SitePageParams`, …) replacing ~70 inline `params:` blocks; `groups.checkSiteAdminAccess(req,
   globalPermission, sitePermission, siteId)` replacing five identical gate functions. (API-F2, F3, F4)
3. **Small helper bundle** — `splitList`, unknown-group check owned by `models/groups`, shared
   API-key creation validation, `resolveSiteParam`, `helpers/httpCache.ts#notModifiedOrPrepare`
   (six controllers + `sendCacheable`), `helpers/timeout.ts#withTimeout` (seven race-against-timer
   blocks), `siteIdForHostname` + single `defaultLocale`, `isUniqueViolation`, `escapeLikePattern`,
   one bcrypt-rounds const, `mcp/tools/shared.ts` (`toResult`, `siteIdArg`), scheduler
   `notifyJobCompleted`. (API-F8, F10; CORE-F10, F11, F16, F17; MOD-F7, F10)
4. **`helpers/moduleRegistry.ts`** — `readModuleDefinitions`, `mergeModuleConfig`,
   `validateModuleConfig`, `moduleHasFile`, `loadModule`, `syncSiteModuleRows`, used by
   storage / search / authentication / commentProviders / analytics / extensions. Dynamic import
   strings stay literal in each model. (MOD-F1)
5. **`helpers/clusterCache.ts`** — `ClusterReloaded` base for the five `reloadCache`/
   `broadcastReload`/`subscribeToEvents` trios. (MOD-F3)
6. **Model-local dedupes** — `users.patchStrategyAuth` (14 sites) + `requireStrategyAuth` +
   `localUserRow` + `describeLinkedProviders` + shared `assertAllowedProviderEmail`; pages
   `announce()`/`invalidateSiteCaches` + `assertNoPageAt`/`assertLocaleActive`/
   `assertPathNotReservedLocale`/`assertClassificationMeetsFloor`; tree `requireFolderById`/
   `assertFolderNameFree`/`duplicateEntryError`; assets `assetSelection`/`toAsset`; groups imports
   `userSelection`/`UserCore`/`UserPage` from users; `helpers/pagination.ts#paginate` across all six
   sites; `tree.holdsVisiblePagesUnder` shared with navigation; seven column-for-column model
   interfaces become `typeof table.$inferSelect` / `Pick` / `Omit` one-liners with their `as X` casts
   deleted; `pageHistory` `entrySelection`/`toEntry`/keyset scaffold; `helpers/puppeteer.ts` gains
   `isPuppeteerAvailable`/`assertPuppeteerAvailable`/`closeQuietly` (with `withTimeout` from item 3);
   `helpers/fsPurge.ts#purgeFilesOlderThan` for `export`/`siteImport`; `mail.sendTemplate`. (MOD-F2,
   F5, F6, F8, F10, F14, F15, F16, F17; addendum F1–F5)
7. **Storage/search module bases** — `modules/storage/blobBase.ts` factory for s3/azure/gcs
   (dropping the 12 impossible-shape fallbacks), sftp onto `blobTarget.ts` (D3), one content-type
   map; `modules/search/shared.ts` (pure helpers) + `externalBase.ts` (abstract class) for the four
   external engines, phased so the `filterVisible`/`totalHits` step lands last. (CORE-F3, F4, F5, F18)
8. **Split `helpers/common.ts`** into `siteResolution.ts`, `localeRouting.ts`, `moduleProps.ts` +
   the remainder; **split `index.ts`** into `core/http/{security,session,openapi,authHooks,
   siteRouting,errors,routes}.ts` with the boot script left behind, exporting the permission
   preHandler, swagger transform and `apiErrorHandler` as testable functions. (CORE-F12, F13)
9. **Migration shapes** — `phases/route.ts` (one `routeOutcome`), `phases/dry-run.ts`, generic
   group/user importer, `mappers/shared.ts`, CLI dedupe into `source-args.ts`, `verify.ts` NYIE
   catch, `NavigationWriteModel` per-locale signature, move root importers under `importers/`,
   trim narration-of-deleted-code comments file by file while touching them. (CORE-F14)

### WS2 — Backend splits (≈ 0 LOC, after WS1)

- `api/pages/` → `read`, `write`, `import` (with its multipart registration), `classification`,
  `history`, `export`, aggregated by `index.ts`; `api/users/` → `admin`, `profile` (with a
  `requireSessionUser` preHandler replacing 20 copies); `api/system/` → `info`, `settings` (with the
  `registerFlagToggle` rewrite, PUT tests added first), `extensions`, `maintenance`, `transfer`;
  `api/auth/` → `site`, `provider`, `strategies`. The three scanner tests become recursive in the
  first split task. Tests split along the same describes. (API-F5, F7)
- `models/rendering.ts` → `helpers/htmlSanitizePolicy.ts` + `models/renderQueue.ts` + post-process
  core; `models/users.ts` → `users`, `userCredentials`, `login`; `models/approvals.ts` →
  `approvalRules`, `approvals`, `approvalNotifications` (+ `reviewerScopeFor`); `models/assets.ts`
  → `assetServing.ts`; `models/pages.ts` → `pageClassification.ts`. (MOD-F11–F14, F18)

### WS3 — Frontend (≈ −2,400 LOC + splits)

1. **Shared extractions** — `ModuleConfigForm` + `moduleConfig.js` adopted by Analytics/Auth/
   Comments; `composables/siteImage.js`; `composables/adminSettings.js` (`useAdminSettings`) across
   the 16 settings pages; four `*DeleteDialog.vue` replaced by `confirm({ destructive })`;
   `passwordStrengthBadge` + charsets; `helpers/systemIds.js`; `helpers/treeNodes.js`;
   `helpers/apiKeyState.js` + `composables/apiKeyCreateForm.js`; `composables/adminOverlayRoute.js`.
   (VIEW-F1–F7, F11, F12)
2. **Library & stores** — `useFieldFrame` + `WFieldFrame.vue` for `WInput`/`WSelect`;
   `shared/metrics.js` (`NAMED_SIZES`, `CELL_ALIGN`); `useAnchoredFloat`; `trackPointerDrag`;
   `useToggleModel`; `screen.js` keep `gte` only; `page.js` `pagePatch`/`markClean`/`ensureConfigs`/
   `BLANK_PAGE`; `user.js` one `formatDateTime`; `replaceHeadStyle`; `linesOutsideFences`;
   `interceptableUrl`. (INFRA-F3, F10–F12, F14–F17, F19, F20, F23)
3. **Splits** — `renderers/markdown.js` → three `modules/` plugins; `Index.vue` route watcher →
   `pages/index/pageRouting.js` + `helpers/blockScan.js`; `EditorMarkdown.vue` → `helpers/
   markdownInsert.js`, `composables/previewResize.js`, `composables/markdownCollab.js`;
   `FileManager.vue` → `composables/fileUpload.js`, `fileManagerActions.js`; `GroupEditOverlay.vue`
   → `GroupRulesEditor.vue`, `GroupUsersPanel.vue`; `AuthLoginPanel.vue` → `AuthTfaScreens.vue`,
   `AuthRegisterScreen.vue`; `AdminStorage.vue` → `helpers/storageDeliveryGraph.js`; `Graph.vue` →
   `graphDraw.js`, `graphSimulation.js`; `PageHeader.vue` → `composables/pageSaveFlow.js`;
   `PageHistoryOverlay.vue` → `composables/monacoDiff.js`; `EditorWysiwyg.vue` → `helpers/
   wysiwygMenuBar.js`. (INFRA-F25, VIEW-F13)

### WS4 — Blocks & e2e (≈ −800 LOC)

- `shared/styles.js` (`errorBox`, `captionStyles`), `shared/props.js` (`boolean`),
  `shared/body.js` (`readFencedSource`), `shared/render.js` (`renderError`), `shared/icons.js`
  (`MDI_PATHS`, `inlineIcon`), `shared/figure.js` (`explainSourceFailure`); one `fetchSite()` cache
  shared by `site.js`/`config.js`. (BLK-F1, F4, F5, F8)
- `shared/video-embed.js#VideoEmbedElement` base for youtube/vimeo/dailymotion/m365-video;
  `shared/diagram-image.js#DiagramImageElement` base for kroki/plantuml (drawio shares the styles).
  (BLK-F2, F3 / INFRA-F4, F5)
- `block-pdf` styles + toolbar into sibling files. (BLK-F9)
- e2e: `submitLogin`, `openMarkdownEditor`/`typeBody`/`savePage` composed by
  `createAndPublishPage`, marker-based `expectAuthenticatedShell`. (BLK-F6)

### WS5 — Test harness (≈ −8,000 LOC, no assertions dropped)

1. Backend: export `createSilentLogger`, add `createWikiStub`/`installTestWiki` to `test/mocks.ts`;
   `test/fastify.ts#buildTestApp` using the real `registerAllSchemas` / `apiErrorHandler` /
   permission preHandler exported from production (WS1.8); `test/routeRecorder.ts`;
   `test/builders.ts` (`makeGroupRule`, `makeActor`, `makeSite`, `makeStorageTarget`,
   `makeIndexablePage`, `stubSelect`); `test/migrationFixtures.ts`; `test/sourceFiles.ts` walker.
   Convert directory by directory. (TEST-F1, F2, F7, F9, F10, F15)
2. Frontend: `test/i18n.js#createTestI18n`, `test/router.js#createTestRouter`,
   `test/mount.js#mountWithApp` + `test/fixtures.js` seeds, `test/mocks.js#stubApi`,
   `test/sourceFiles.js`; one repo-wide `docsBase` scanner. (TEST-F3, F4, F5, F11, F13.8)
3. Blocks: `test/mount.js#mountBlock`, `test/darkMode.js#describeDarkMode`, `stubSiteFetch`;
   CLAUDE.md's "copy verbatim" sentence points at the helper. (TEST-F8)
4. Contract runners `test/searchModuleContract.ts` / `storageModuleContract.ts` — after WS1.7,
   byte-identical helpers first, runners second. (TEST-F6)
5. Oversized suites split along their describes, born on the new harness: `api/pages.test.ts`,
   `models/{users,approvals,navigation,pages}.test.ts`, `core/{scheduler,collab}.test.ts`,
   frontend `stores/page`, `pages/Graph`, `EditorMarkdown`, `Index`, `App`, `PageActionsCol`,
   `HeaderSearch`. Pure describes separate from DB-gated ones so the boundary is a filename
   property. (TEST-F14, F16)

## Verification

- Per task: typecheck (backend), lint (`--deny-warnings`) in the touched workspace, `oxfmt --check`
  on touched paths, and the co-located tests of every touched file (DB-backed ones against the
  local test database).
- Per workstream: the workspace's full lint/format/typecheck gates (not tests).
- Before hand-off: all three gates repo-wide, `frontend` `npm run build` and `blocks` `npm run
  build` succeed (the backend serves `assets/`), `npm run icons:check` passes, and a summary of LOC
  removed per workstream plus the D1–D10 flags goes in the PR description.

## Expected outcome

Roughly 20k lines removed net (≈ 6.5k dead code, ≈ 5k backend duplication, ≈ 2.4k frontend,
≈ 0.8k blocks, ≈ 8k test harness) with no user-visible change beyond D1–D10, and every file over
~1,500 lines either split by responsibility or explicitly judged coherent in its survey.
