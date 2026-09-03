# Test code survey

Scope: `backend/**/*.test.ts` (299 files, 111,304 LOC) + `backend/test/` (fixtures + 23 structural/doc suites), `frontend/src/**/*.test.js` (235 files, 47,881 LOC) + `frontend/test/`, `blocks/**/*.test.js` (33 files, 4,917 LOC). All paths below are relative to the worktree root. Every count was produced by grep/diff against the tree; every `file:line` was read.

## Summary

1. The test corpus is ~164k LOC, and roughly **8–10% of it is copy-pasted harness** — the same Fastify boot block, the same `WIKI = {…}` literal, the same `createI18n`/`createRouter`/`setActivePinia` triple, the same Lit mount helper. The shared fixtures that exist (`backend/test/mocks.ts`, `test/db.ts`, `frontend/test/setup.js`) are good but stop one level short: they provide *members* (cache/events/scheduler stubs) but not the *global*, and a global `w-*` registration but not a mount.
2. The single most-copied unit in the backend is a hand-built `WIKI` literal — **146 files**, 70 of which inline their own silent-logger object because `test/db.ts`'s `createSilentLogger()` is private (`backend/test/db.ts:372`). Second is the Fastify route-test preamble: 123 `fastify()` boots, 113 `@fastify/sensible` registrations, ≥57 verbatim copies of an 8-line `setErrorHandler` that only *approximates* `index.ts`'s real one, 254 `registerXSchema(app)` calls, 3 byte-identical copies of `index.ts`'s permission preHandler.
3. On the frontend the equivalent is `createI18n(...)` at **196 call sites in 127 files** (895 argument-LOC, ~94 byte-identical one-liners), `createRouter(...)` at 103 sites in 47 files, and 76 per-file `mountDialog`/`mountPage`/`mountOverlay` helpers that are the same four lines. Three files already invented `createTestI18n`, five already invented `makeRouter`/`createTestRouter` — the abstractions are proven, just not shared.
4. Blocks: 26 copies of the same 5-line mount helper and 11 copies of the dark-mode `describe` (9 near-verbatim) — CLAUDE.md literally instructs "copy verbatim". A `describeDarkMode()` helper would also *add* coverage to the 10 blocks that use `DarkMode` and assert nothing about it.
5. Genuine cross-file duplicate assertions are few but real: `api/pages.test.ts` carries two describes fully subsumed by `api/pagesExportPdf.test.ts` and `helpers/apiKeySite.test.ts`; `models/users.test.ts` has the same `describe('users.setUserGroups (DB-backed)')` twice; three files guard `en.json` for duplicate keys with three different implementations; 7 frontend files each hand-scan one component for `docsBase`.
6. **DB-gated vs pure**: 67 backend files mention `hasTestDatabase()`, 61 gate on it in code; those 67 hold 1,484 of 4,806 test cases (31%) and 45,660 of 111,304 LOC (41%). **35 of them mix DB-gated and pure describes in one file**, so the pure part is invisible from the filename (`models/storage.test.ts`: 52 top-level describes, 1 gated).
7. The 23 structural/doc suites in `backend/test/` (~3,000 LOC, 319 tests) **all pass today and all point at files that still exist** — they are not stale. A minority assert things of doubtful durability (a deleted file stays deleted, a WP number appears in a doc, a comment in `global.d.ts` says a certain thing); flagged, not proposed for deletion.
8. One dead-code find with test consequences: **`backend/importer/`** (5 source files, 1,603 LOC + 7 test files, 1,359 LOC) is imported by nothing outside its own directory — only two comments reference it. Four of the DB-gated suites belong to it.
9. Orphan tests: **none** in any workspace — every no-sibling test is a deliberate source-scanner or a `definition.yml` suite.
10. Net removable across the findings below, without dropping a single assertion: **~8,000–9,500 LOC**, the bulk from F1–F5.

## Existing shared utilities worth knowing (reuse, don't re-create)

| Helper | Where | Notes |
| --- | --- | --- |
| `createCacheStub()`, `createEventsStub()`, `createSchedulerStub()` | `backend/test/mocks.ts:24,59,75` | Used by only 11 non-DB files; cache/events hand-rolls are rare (see rejected list) |
| `setupTestDb()` / `teardownTestDb()` / `hasTestDatabase()` / `seedTreeEntry()` / `seedLocale()` / `createExtensionsSerialized()` | `backend/test/db.ts` | Installs a full `WIKI` via private `installTestWiki()` (`:325`) + private `createSilentLogger()` (`:372`) — **both should be exported** (F1) |
| `GUEST_SCENARIO_RULES/CASES` | `backend/test/permissionScenario.ts` | Precedent for shared rule fixtures |
| `test/collabWorker.ts`, `test/sftpServer.ts`, `test/temporal.ts` | `backend/test/` | Single-consumer fixtures (collab.test.ts, sftp/integration.test.ts); `ensureTemporal()` is used by 32 files and is required (Node 26 has no native `Temporal`) |
| Local precedents already written once, ready to lift | `backend/models/users-import.test.ts:19-53` + `groups-import.test.ts:21-54` (`installFakeWiki()` returning `{restore}`), `backend/api/bootstrap.test.ts:12-38` (`buildApp()`), `backend/migration/verify.test.ts:56-63` (`workingConnector()` spread over a stub), `backend/core/processGuards.test.ts:6-10` (`createLoggerStub()`) | |
| `createApiClientStub()` | `frontend/test/mocks.js:19` | Imported only by `setup.js`; tests override per-call |
| `setup.js` | `frontend/test/setup.js` | Global `w-*` registration, per-test `API_CLIENT`/`EVENT_BUS`/`localStorage`/canvas rebuild. Deliberately does **not** seed stores — keep it that way |
| `hasChromium()` | `frontend/test/realGridLayout.js` | The precedent that `test/*.js` helpers imported by relative path are an accepted shape |
| Local precedents | `frontend/src/pages/Graph.test.js:57`, `TagsBrowse.test.js:25`, `Search.test.js:210` (`createTestI18n`); `pages/AdminPages.test.js:62`, `App.test.js:566,835` (`makeRouter`); `Search.test.js:258`, `TagsBrowse.test.js:87` (`createTestRouter`); `pages/AdminApi.test.js:111-119`, `ProfileApi.test.js:61` (URL→payload lookup table) | |
| `blocks/test/setup.js` | `adoptedStyleSheets` shim + Temporal polyfill only; `blocks/vitest.config.js` `include: ['**/*.test.js']` so new helpers there must **not** end in `.test.js` | |

## Findings

### F1. `installTestWiki()` / `createWikiStub()` / exported `createSilentLogger()` in `backend/test/mocks.ts` — utility extraction | net LOC −900 to −1,100 | risk low-med | effort M

- Locations (146 files assign a `WIKI = {…}` literal; 176 distinct literals in the non-route slice alone; 70 files inline a logger object; 41 files hand-roll `previousWiki` save/restore):
  - Byte-identical 8-line literals: `backend/modules/storage/azure/storage.test.ts:24-31` ≡ `gcs/storage.test.ts:18-26` ≡ `s3/storage.test.ts:34-42`.
  - Structurally identical, differing only in the vendor `engines` payload: `backend/modules/search/azure-search/search.test.ts:42-59` vs `aws-cloudsearch/search.test.ts:48-72`; `algolia/search.test.ts:337-357` vs `elasticsearch/search.test.ts:339-364`. `azure-search:36-40` even says "the same reason `test/mocks.ts` exists … just inlined here rather than imported".
  - Logger census: 33× `{info,warn,error,debug: () => {}}`, 8× `{debug}`, 5× `{warn}`, 5× `{info: mock.fn(), warn: mock.fn()}`, e.g. `backend/api/approvals.test.ts:108`, `api/blocks.test.ts:330,503`, `api/comments.test.ts:458`, `api/icons.test.ts:71`, `api/navigation.test.ts:78`, `api/pages.test.ts:3878,4089`, `helpers/rateLimit.test.ts:39,165,545,683,830` (4 identical), `mcp/http.test.ts:63,386`, `tasks/simple/dispatch-storage.test.ts:30-33`, `importer/assetFolders.test.ts:8`. Only `backend/models/storage.test.ts:667` extracts one locally.
  - Save/restore re-implemented: `backend/mcp/site.test.ts:16-22` and all 7 `mcp/tools/*.test.ts`; `models/users.test.ts:3492,3507-3513` ≡ `models/sites.test.ts:1144,1159-1165` ≡ `models/pages.test.ts:2851,2908-2914`; `models/commentProviders.test.ts:308-318`. `db.ts:69-72,281-282` already does this internally.
- What's wrong: every file re-derives a different partial subset of `db.ts:334-368`; adding one `WIKI.logger.info()` to a route breaks every test whose stub omitted `info`, and the failure names the logger rather than the change. The 35 mixed files (see §DB-gated) install a hand-built global *and* `setupTestDb()`'s global in the same process, in registration order.
- Proposed target shape:
  ```ts
  // backend/test/mocks.ts
  export function createSilentLogger(): any                       // move from db.ts:372-375
  export function createWikiStub(overrides?: DeepPartial<WikiGlobal>): WikiGlobal
  export function installTestWiki(overrides?): { restore(): void } // capture → merge → install
  ```
  Defaults: silent logger, cache/events/scheduler stubs, `{}` for `config`/`sites`/`sitesMappings`/`models`, `data.systemIds`. **Default `models` to `{}`**, not a populated set — `backend/modules/storage/disk/storage.test.ts:312-314` relies on absent members throwing. `db.ts#installTestWiki` becomes a caller.
- Test coverage: this *is* the test code; each converted file is its own regression check. Convert one directory at a time (`modules/storage/` first: three byte-identical literals).

### F2. `buildTestApp()` in `backend/test/fastify.ts` (+ export `registerAllSchemas` and the real `apiErrorHandler`) — utility extraction | net LOC −1,200 to −1,450 | risk med | effort L

- Locations (66 route-level files: 123 `fastify()` boots, 113 `register(fastifySensible)`, 119 `await app.ready()`, 254 `registerXSchema(app)` + 110 `registerSchemas as registerX` import lines, 104 `delete (globalThis as any).WIKI` lines):
  - The canonical preamble, read side-by-side: `backend/api/apiKeys.test.ts:29-90`, `api/checklists.test.ts:117-154`, `api/glossary.test.ts:40-57`, `api/icons.test.ts:60-101`, `api/storage.test.ts:40-78`, `api/users.createWelcomeEmail.test.ts:30-77` vs `api/users.reassignContent.test.ts:30-64` (differ by **one comment line**), `api/pages-export.test.ts:70-127` vs `api/pages.backlinks.test.ts:72-124` (WIKI literal differs by one line; `actorForRequest` and `setErrorHandler` byte-identical).
  - `setErrorHandler` body: ≥57 verbatim copies in 33 files (106 mentions in 39). All approximate `backend/index.ts:1128-1152`, which actually branches on `/_api/` and delegates to `helpers/errorHandler.ts#sendNonApiError` — so every copy can drift independently. Variants: `api/tags.test.ts:54-64` and `api/users.test.ts:144-154` add `.type('application/json')`.
  - `index.ts:886-918` permission preHandler re-implemented: `api/groups.test.ts:285-322` ≡ `api/locales.test.ts:17-54` (diff empty) ≡ `api/navigation.test.ts:456-493`; inline variants at `api/sites.test.ts:233-257`, `api/classificationLevels.test.ts:42-`, `api/auditLog.test.ts:51-61`. **All six omit the `req.apiKey` branch** at `index.ts:891-895`.
  - ajv `hexcolor` format: 13 lines × 5 — `api/bootstrap.test.ts:13-25`, `api/index.test.ts:336-351`, `api/sites.test.ts:203-215`, `api/sites.locale.test.ts:54-66`, `test/apiKeySitePinCoverage.test.ts:45-60`.
  - Session seeding is four incompatible conventions: `x-test-session` JSON header (11 files), `x-test-permissions` CSV/JSON header (10), module-level `let testSession` (4, all DB-backed), `x-test-api-key`/`x-simulate-api-key` (4). `decorateRequest('session', null)` appears in only 8 places; the other ~50 hooks assign onto an undecorated request.
  - Ten local `function buildApp` definitions: `api/assets.test.ts:52`, `api/authentication.test.ts:1025`, `api/bootstrap.test.ts:12`, `api/hooks.test.ts:33`, `api/pages.test.ts:87`, `controllers/files.test.ts:40`, `helpers/common.test.ts:516,629`, `helpers/security.test.ts:302,385`.
- Proposed target shape:
  ```ts
  // backend/test/fastify.ts
  buildTestApp({ routes, wiki?, schemas?: 'all' | string[], session?: false|'header'|object|fn,
                 apiKey?, permissions?: boolean, apiKeySitePin?: boolean, ajv?: boolean, swagger?, prefix? })
  closeTestApp(app)   // close + restore prior WIKI
  makeRequestStub(overrides), makeReplyStub(), makeDoneStub()   // see F9
  ```
  Two production-side extractions make it cheap and *fix* drift: lift `backend/api/index.ts:9-41` (33 inline schema imports) into `export async function registerAllSchemas(app)`; move `index.ts:1128-1152`'s body to `helpers/errorHandler.ts#apiErrorHandler` and have both `index.ts` and the harness install the real one. Export `testSessionOnRequest`/`permissionPreHandler` so the harness runs `index.ts`'s real hook (with the apiKey branch the six replicas drop).
- Test coverage: 60 `app.inject` suites re-verify each migrated file. Land with zero call sites, migrate the ~24 no-auth files first, then the 6 permission-replica files (the batch that fixes something), then the rest.

### F3. `frontend/test/i18n.js#createTestI18n(messages)` — utility extraction | net LOC −650 | risk low | effort S

- Locations: 196 `createI18n(` sites in 127 files, 62 distinct spellings, all `legacy: false, locale: 'en'`. ~94 are the byte-identical one-liner `createI18n({ legacy: false, locale: 'en', messages: { en: {} } })` — `frontend/src/App.test.js:60,211,291,451,500,517,537,846` (8 in one file), `components/EditorCodeBlockMenu.test.js:27`, `components/AuthLoginPanel.test.js:39,491`, `components/UserSearchDialog.test.js:24`, `pages/AdminPageviews.test.js:18`, `components/RecoveryCodesDialog.test.js:18`, `components/WelcomeOverlay.test.js:41`. Multi-line expansions differing only in the message literal: `components/AssetRenameDialog.test.js:26-41`, `pages/AdminCluster.test.js:29-45`, `pages/AdminApi.test.js:16-29`, `pages/AdminAuditLog.test.js:15-25`, `pages/AdminMetrics.test.js:22-32`, `pages/AdminSystem.test.js:24-37`, `pages/ProfileInfo.test.js:21-33`. 895 LOC inside `createI18n(...)` argument lists.
- What differs: only `messages`; 4 files add `missingWarn:false`/`fallbackWarn:false` (`pages/AdminGeneral.test.js:39,212`, `pages/AdminLogin.test.js:32`, `components/PageTags.test.js:25`). No test loads real `en.json` into i18n. Three files already define `createTestI18n` locally (`pages/Graph.test.js:57`, `pages/TagsBrowse.test.js:25`, `pages/Search.test.js:210`).
- Target: `export function createTestI18n(messages = {})` nesting under `en`, accepting flat-dotted or nested (both are used in `components/NavSidebar.test.js:43` vs `:561`), warn flags off by default.
- Test coverage: every converted suite.

### F4. `frontend/test/router.js#createTestRouter(routes, initialPath)` — utility extraction | net LOC −400 | risk low-med | effort S

- Locations: 103 `createRouter(` sites in 47 files; 35× `[{ path: '/', component: { template: '<div />' } }]`, 15× `'/:pathMatch(.*)*'`, 6× `'/:section'` (`components/GroupEditOverlay.test.js:73,219,274,342,550,619`), 4× `'/_admin/:siteid/general'`; followed by 109 `router.push` + 90 `await router.isReady()` codas. Cites: `App.test.js:53,287,336,447,496`, `App.beforeunload.test.js:55`, `components/LocaleSelectorMenu.test.js:32`, `components/WelcomeOverlay.test.js:34-39`, `layouts/AdminLayout.test.js:71-73,169`, `pages/AdminGeneral.test.js:32-37,345,473`, `pages/AdminTheme.test.js:35-38`.
- Outlier: `components/FileManager.test.js:73,324,438,494,657` use `createWebHistory()` — every other suite uses memory history; verify those 5 tests when converting (medium-risk part).
- Target: bare strings become stub routes; objects pass through (`pages/Index.test.js:181`, `pages/Search.test.js:259` need real components); helper does `push(initialPath)` + `isReady()`.

### F5. `frontend/test/mount.js#mountWithApp()` + `frontend/test/fixtures.js` store seeds — utility extraction | net LOC −900 to −1,100 | risk med | effort L

- Locations: 36 `function mountDialog`, 27 `mountPage`, 7 `mountEditor`, 6 `mountOverlay`, ~25 `mountWith*`; 189 `setActivePinia(createPinia())` in 117 files; 20 sites use exactly `global: { plugins: [i18n] }`, 17 exactly `[router, i18n]`; 56 `attachTo: document.body` in 24 files; 174 manual `unmount()`. Near-verbatim helpers: `components/SiteCreateDialog.test.js:27-42` ≡ `SiteDeleteDialog.test.js:38-` ≡ `SiteActivateDialog.test.js:36-`; `pages/AdminApi.test.js:14-35`, `AdminAuditLog.test.js:12-32`, `AdminCluster.test.js:26-52`, `AdminMetrics.test.js:19-39`, `AdminSystem.test.js:21-47`, `ProfileInfo.test.js:15-38`; `components/EditorMarkdownConfigOverlay.test.js:33-39` ≡ `EditorMarkdownUserSettingsOverlay.test.js:22-30`; `pages/AdminPageviews.test.js:15-25` is 11 lines of pure boilerplate.
- Store seeding is single-field, not object literals: 92× `siteStore.id = 'site-1'`, 15× `editorStore.mode = 'edit'`, 15× `adminStore.currentSiteId = 'site-1'`, 11× `pageStore.router = stubRouter()`, 11× `pageStore.id = 'page-1'`, 8× `userStore.permissions = ['manage:sites']`, 7× `userStore.profileLoaded = true`, 7× `flagsStore.loaded = true`. `stubRouter` is defined 4× with 3 different defaults (`boot/api.test.js:21`, `stores/page.test.js:744,905,938`).
- Target: `mountWithApp(Component, { props, messages, routes, initialPath, stores: { site, user, page, admin, editor, flags }, stubs, components, attachTo })` returning `{ wrapper, ...stores }`; default `stubs: { teleport: true }` (14 sites, 13 files); `seedSite/seedUser/seedPage/seedAdmin(overrides)` + one `stubRouter`. **Keep seeding opt-in at the call** — `pages/ProfileInfo.test.js:18-19` asserts on the unseeded store. Do after F3/F4; roll out `pages/Admin*` then `components/*Dialog`.
- Secondary: `BlueprintIcon` is stubbed in 6 files and registered as a real component in 2 (`components/NavEditOverlay.test.js:61`, `pages/AdminSystem.test.js:42`) — pick one policy (global registration in `setup.js` is consistent with how `w-*` is handled); medium risk for those 6 files' HTML assertions.

### F6. Shared contract suites for search and storage modules — utility extraction / rewrite of expression | net LOC −1,300 to −1,500 | risk med-high | effort L

- Search (5 engines, 4,582 LOC): verified byte-identical helpers `fakePage()` (`backend/modules/search/algolia/search.test.ts:21-40` ≡ `elasticsearch/search.test.ts:23-42`), `fakePageSource()` (`azure-search:833-847` ≡ `aws-cloudsearch:1058-1072`), `fakeDb()` (`algolia:599-616` ≡ `elasticsearch:726-743`). The same 13-test contract (created/updated/deleted/renamed, failure-never-throws, query window/offset/checkAccess/classification/no-actor, rebuild purge+batch, empty rebuild) appears test-name-for-test-name in algolia (`:385-701`) and elasticsearch (`:399-772`), and under different describe names in azure (`:424-980`) and aws (`:684-1291`). `db/search.test.ts` lacks `renamed()`/`totalHits` coverage the sweep would surface.
- Storage: 13 `makeTarget()` copies (`azure:52-93`, `gcs:57-98` differ in 7 of 42 lines; `s3:51-91`, `sftp/storage:38-71`, `git/sync:124-163`, …, `models/storage.test.ts:65`); the 10-test asset-lifecycle contract repeats in azure (`:162-323`) and gcs (`:173-323`).
- Target: `backend/test/searchModuleContract.ts#runSearchModuleContract(name, { makeModule, config, siteConfig })` and `storageModuleContract.ts#runStorageModuleContract(name, { makeTarget, stubSdk })`; engine files keep only vendor-specific query/document builders. Name each generated test `"<engine>: <claim>"`. Ship the three byte-identical helpers first (zero risk), runners second. `makeIndexablePage` must be the azure superset (28 fields) — this changes what aws's `toIndexDocument` sees, hence the risk grade.

### F7. Fixture builders in `backend/test/builders.ts` — utility extraction | net LOC −700 | risk low (med for page builder) | effort M

- `makeRule()`: 4 copies × 13 lines — `backend/helpers/pageRules.test.ts:14-26` ≡ `scripts/audit-site-scoped-rules.test.ts:11-23` (byte-identical); `helpers/pageRules.nestedDeny.test.ts:25-37` (id differs); `helpers/siteRules.test.ts:7-19` (roles differ). `page()` builder: `pageRules.test.ts:28-32` ≡ `pageRules.nestedDeny.test.ts:39-42`. 188 raw rule literals across 23 files.
- Actors `{ id, permissions, groupIds }`: 246 literals (`models/groups.test.ts` 61, `approvals.test.ts` 39, `navigation.test.ts` 19); MCP key-context 6-field literal ×7 (`mcp/tools/{getPage,listNavigation:8-14,searchPages:34-40,…}.test.ts`).
- Site literals `config: { locales: { primary } }`: 42 × 22 files (`models/siteImport.test.ts` ×11, `modules/storage/git/sync.test.ts` ×4, `models/mail.test.ts` ×3).
- Drizzle select-chain fakes: `models/users.test.ts:3494-3505` ≡ `models/sites.test.ts:1146-1157`, `models/pages.test.ts:2855-2867` (+leftJoin); the surrounding 45-line describes `users.test.ts:3491-3535` and `sites.test.ts:1143-1187` are clones (`getAvatarHash` ↔ `getAssetHash`).
- Target: `makeGroupRule`, `makeRulePageRef`, `makeActor`, `makeSite`, `makeStorageTarget(module, overrides)`, `makeIndexablePage`, `stubSelect(row, { joins })` (~125 LOC total).

### F8. `blocks/test/mount.js` + `blocks/test/darkMode.js` — utility extraction | net LOC −350, coverage +10 blocks | risk low | effort S

- Mount helper copied 26×: `blocks/block-gallery/component.test.js:9-15` ≡ `block-spoiler:8-14` ≡ `block-mathjax:11-17`; `block-asciinema:15-23` ≡ `block-qr-code:22-30` ≡ `block-youtube:28-36`; `block-dailymotion:9-20` ≡ `block-vimeo:8-19`; `block-infobox:11-19` ≡ `block-katex:19-27`; the async-settle coda copied 6× with cross-referencing comments (`block-index:55-57`, `block-include:93-95`, `block-live-data:35-37`, `block-map:20-22`, `block-checklist:26-30`, `block-diagram:37-38`). `document.body.replaceChildren()` in all 26 suites.
- Dark-mode describe 11×: template `block-gallery:57-75`; byte-identical modulo mount call at `block-media-player:95-113`, `block-dailymotion:124-142`, `block-vimeo:125-143`; same body at `block-checklist:292-310`, `block-countdown:155-167`, `block-index:187-201`, `block-qr-code:156-169`, `block-tabs:199-212`; inverted at `block-live-data:222-233`; **`block-diagram:111-149` is genuinely different (asserts a `_draw()` repaint) — leave it**. 10 blocks use `DarkMode` (`blocks/shared/theme.js:68`) with no assertion: drawio, infobox, katex, kroki, map, mathjax, openapi, pdf, plantuml, spoiler.
- `stubFetch` defined 4× (`block-checklist:63`, `block-index:25`, `block-live-data:9`, `block-include:50`).
- Target: `mountBlock(tag, { text, html, pre, props, attrs, settle })`, `resetBlockDom()`, `describeDarkMode(mount, { inverted })`, `stubSiteFetch()`. File names must not end in `.test.js`. **Update CLAUDE.md's "template worth copying verbatim" sentence** to point at the helper.

### F9. Route recorder, fake req/reply, hexcolor ajv — utility extraction | net LOC −110 | risk low | effort S

- `createRecordingApp()` ×4: `backend/api/routeTags.test.ts:22-49`, `api/responseErrors.test.ts:22-45` (diff = 3 comment lines), `api/index.test.ts:182-205` (adds `addSchema` no-op — the other three would throw on any route that calls `app.addSchema()` at registration), `api/approvals.test.ts:294-308`. Plus the shared `WIKI ??= { config: {} }` dance (`routeTags:51-55`, `responseErrors:47-49`, `index.test.ts:217-221`, `test/apiKeySitePinCoverage.test.ts:40-43`), the `readdirSync(apiDir)` scan ×3, `referencesApiError()` byte-identical at `responseErrors:58-62` and `approvals:311-315`, and the `'every route file under api/ was actually found'` sanity test ×2 (+1 near-equivalent).
- `makeReply()` ×4 byte-identical and `makeReq()` ×4 differing only in defaults, all in `backend/helpers/rateLimit.test.ts:128-144,521-536,648-664,808-822`; `fakeReply()` byte-identical at `api/index.test.ts:38-48` and `helpers/common.test.ts:572-582`.
- Target: `backend/test/routeRecorder.ts` (`createRecordingApp`, `listApiRouteFiles`, `recordRoutesFrom`, `referencesApiError`, `stubWikiForRegistration`) and `makeRequestStub/makeReplyStub/makeDoneStub` in `test/fastify.ts` (F2). `helpers/common.test.ts` asserts `calls.forbidden` as `string[]` — keep that accessor shape.

### F10. `backend/test/migrationFixtures.ts` — utility extraction | net LOC −380 | risk low (med for DDL) | effort M

- `async function* iter<T>` ×6 identical: `backend/migration/importers/users-groups.test.ts:27`, `phases/content.integration.test.ts:17`, `phases/settings.integration.test.ts:22`, `phases/users.integration.test.ts:25`, `phases/assets.integration.test.ts:14`, `phases/locale-propagation.integration.test.ts:19`.
- `NotYetImplementedError` connector stub, same 18 lines × 9 in 8 files: `migration/verify.test.ts:29-48,552,611`, `phases/phases.test.ts:24`, the 5 `phases/*.integration.test.ts`. `verify.test.ts:56-63`'s `workingConnector()` spread is the right abstraction, unexported.
- 22-field 2.5.x page row × 13 in 8 files: `migration/content-staging.test.ts:110-186,455,514,553`, `phases/content.integration.test.ts:50,77`, `phases/assets.integration.test.ts:49`, `phases/locale-propagation.integration.test.ts:59`, `phases/phases.test.ts:120`, `page-history-import.test.ts:58`, `path-normalization.test.ts:187`, `page-import.test.ts:18-47` (`buildStagedPage`). `connectors/postgres.test.ts` re-declares `CREATE TABLE pages/users/groups` in four fixtures (`:204-236,334-420,574-623,719-`) — but some are *deliberately* narrower to prove `checkShape()` rejects them (`:186-244`), so the shared DDL must be a per-table opt-in map.
- Target: `iterate()`, `stubSourceConnector(overrides)`, `makeSourcePageRow()`, `makeStagedPage()`, `LEGACY_SCHEMA_DDL` map.

### F11. `frontend/test/mocks.js#stubApi(routes)` — utility extraction | net LOC −150 | risk low | effort S

- 24 files hand-roll `API_CLIENT.get.mockImplementation((url) => { if (url === …) })`: `pages/AdminAuth.test.js:122-133` (×3 in-file), `layouts/AdminLayout.test.js:61-69,298-303`, `pages/AdminLocale.test.js:62-70`, `pages/AdminGeneral.test.js:25-30,178-190`, `pages/AdminTheme.test.js:28-33`, `components/NavEditOverlay.test.js:52-57`; prefix/suffix variants at `pages/AdminPagesDeleted.test.js:36-45,98-107`, `AdminLocale:66`, `AdminLayout:65`; and the lookup-table form already reinvented 5× (`pages/AdminApi.test.js:40,73,111-119`, `pages/ProfileApi.test.js:61,151`).
- Target: `stubApi({ 'sites': [...], 'users/whoami': USER }, { method, fallback })` — string keys exact, `RegExp` keys for prefix matches, function values for per-call payloads (`AdminPagesDeleted:101-104` cursor pagination); optionally return the recorded URL list (`App.test.js:461`, `AdminPagesDeleted:99` hand-roll one).

### F12. `backend/importer/` is dead code, with 7 test files (4 DB-gated) covering it — dead code | net LOC −2,962 | risk low | effort S

- `backend/importer/{assets,comments,assetBatch,assetFolders,runSummary}.ts` (1,603 LOC) + `{assets,comments,assetBatch,assetFolders,assetFolders.integration,runSummary,runSummary.integration}.test.ts` (1,359 LOC).
- Grep run: `grep -rn "importer/" backend --include='*.ts' | grep -v '^backend/importer/' | grep -v migration/importers` → only two **comments** (`backend/core/db.ts:165`, `backend/models/assets.ts:184`); `grep -rln "from '.*importer/"` across `tasks api models core controllers mcp helpers index.ts worker.ts scripts migration package.json` → nothing. `package.json`'s `migrate`/`verify-migration` scripts point at `tasks/migrate.ts`/`tasks/verify-migration.ts`, which use `migration/importers/` (`asset-import.ts`, `comment-import.ts`, …) — the live successor. Last touches: `377915c6`, `d3850e1f`, `193e06a6` (the gating commit).
- This belongs to the backend area's dead-code list too; it is listed here because it changes the DB-gated count (4 of the 61 gated files) and because deleting the tests is *not* a coverage loss — nothing they test is reachable.
- Before deleting, confirm no dynamic `import(\`../importer/…\`)` exists (checked: none) and that `migration/importers/asset-import.ts` isn't meant to be replaced by it (the comments in `importer/*.ts` reference each other only).

### F13. Real duplicate assertions / suites to merge (no coverage lost) — dead code (duplicate tests) | net LOC −600 | risk low-med | effort M

1. `backend/api/pages.test.ts:3853-3962` (export/pdf anonymous + logged-in, 2 tests) ⊂ `api/pagesExportPdf.test.ts:125-136,194-205` (8 tests, same route, same `pdfExport.exportPdf` stub). Delete the `pages.test.ts` describe, fold its #2258/#2262 docblock into `pagesExportPdf.test.ts:14-26`. −110.
2. `api/pages.test.ts:154-308` (apiKeySitePinHook GET/CREATE) ≡ `helpers/apiKeySite.test.ts:249-429` (same hook, same `pagesRoutes` app, same `setErrorHandler` and 3-line comment `pages.test.ts:190-199` vs `apiKeySite.test.ts:279-289`, PATCH/DELETE/upload). Move the six tests into the hook's own file. Note the two `apiKeyHeader()` differ (`pages.test.ts:234-236` omits `userId`; `pages.test.ts:297-307` depends on that). −140.
3. `backend/models/users.test.ts:2930` and `:3119` — `describe('users.setUserGroups (DB-backed)')` twice; merge into one describe with one `setupTestDb()`.
4. `en.json` duplicate-key guard implemented three ways: `backend/locales/en.test.ts:36-47` (line-parse), `backend/locales-en.test.ts:74-91` (regex), `backend/locales/en-admin-measurement-labels.test.ts:38-41` (one key). Dead-key lists overlap (`admin.dev.graphiql.title`, `admin.dev.voyager.title` in both `locales/en.test.ts:72-77` and `locales-en.test.ts:24-29`). Merge all three into `backend/locales/en.test.ts` (the co-located one); `locales-en.test.ts` at the `backend/` root also violates the co-location rule CLAUDE.md states. −80.
5. `backend/dev-setup-script.test.ts:91-103` ("README Generic Setup references dev/setup.sh", incl. the `ux/` check) overlaps `backend/test/readme-generic-setup-doc.test.ts:34` ("does not name the non-existent ux/ workspace"). Move the describe into the README test. −13.
6. `api/routeTags.test.ts:63-70` ≡ `api/responseErrors.test.ts:64-69` sanity test — one copy once F9 lands.
7. `api/users.createWelcomeEmail.test.ts` + `api/users.reassignContent.test.ts` → two describes in `api/users.test.ts` (superset WIKI stub at `:57-126` needs `users.generateToken` + `mail.sendWelcomeEmail`); `api/apiKeys.swagger.test.ts` → a describe in `api/apiKeys.test.ts` (swagger registration is harmless for the inject tests). −165. Medium risk: `createWelcomeEmail`'s `beforeEach` (`:84-90`) resets module-level arrays that must be scoped into the describe.
8. Frontend: 7 files each assert `expect(source).not.toContain('docsBase')` on one component (`components/TableEditorOverlay.test.js:16-18`, `pages/AdminFlags.test.js:15-17`, `pages/AdminScheduler.test.js:21-23`, `pages/AdminApprovals.test.js:16-18`, `pages/AdminTerminal.test.js:16-18`, `pages/AdminClassification.test.js:416`, `pages/AdminSites.test.js:90-92`). Replace with one repo-wide scanner in the existing `src/i18nSourceGate.test.js` style — strictly more coverage. Keep the 5 rendered-DOM variants (`components/BlockPickerOverlay.test.js:66`, `pages/AdminCluster.test.js:130-141`, `pages/AdminMetrics.test.js:88`, `pages/AdminGlossary.test.js:364`, `pages/AdminApi.test.js:109`). −21/+35.
9. Frontend byte-identical `it()` blocks on *different* components (`components/ApiKeyCreateDialog.test.js:122,318,329` ≡ `ProfileApiKeyCreateDialog.test.js:110,302,313`; `components/EditorAsciidoc.test.js:175,235,258,267` ≡ `EditorCode.test.js:113,173,237,246`) are distinct coverage — express as `describe.each` over the two components, don't delete.
10. `backend/test/apiKeySitePinCoverage.test.ts` tests `helpers/apiKeySite.ts` (its own header `:16-17` says so) and sits in `backend/test/` by accident — move to `backend/helpers/apiKeySite.coverage.test.ts` (co-location rule).

### F14. Split the oversized suites — long-file splitting | net LOC ≈ 0 (+~400 imports, −~800 harness once F1/F2/F3 land) | risk low-med | effort L

Each file below is already N independent describes with their own `before()`; splitting is relocation. Do it **after** the harness findings so each new file is born on `buildTestApp`/`mountWithApp`. DB-backed files also get a runtime win: `models/users`+`approvals`+`navigation` alone call `setupTestDb()` **55 times** (128 in the non-route slice), each a `CREATE SCHEMA` + full migration + seed.

| File | LOC | Proposed split (describe line ranges in current file) |
| --- | --- | --- |
| `backend/api/pages.test.ts` | 4,289 | `pages.read` (:30-153, :1082-1431, :2042-2164) · `pages.write` (:318-849) · `pages.import` (:1432-2041) · `pages.deleted` (:2501-3104, :3970-4065) · `pages.move` (:3283-3760) · `pages.history` (:3105-3282) · `pages.bulk` (:4066-4289) · `pages.guards` (:2165-2500, :3761-3863) · `pages.schema` (:850-1081); :154-308 and :3853-3962 relocate per F13. Ends as 15 `api/pages.*` files averaging ~330 lines, one naming convention (today `pages-export` vs `pagesExportPdf` vs `pages.backlinks`) |
| `backend/models/users.test.ts` | 3,587 | `users.session` (:75-195, pure) · `users.registration` (:196-659) · `users.providers` (:660-848, :1231-1386, :1479-1702) · `users.passwordReset` (:849-1230, :1387-1430) · `users.tfa` (:1431-1478, :1703-2373) · `users.login` (:2454-2664, pure) · `users.crud` (:2374-2453, :2860-3321, merging the duplicate at :2930/:3119) · `users.profile` (:2665-2859, :3322-3587). `makeUser` (:47-57) → F7 |
| `backend/models/approvals.test.ts` | 3,319 | `lifecycle` (:28-330, :955-1135, :2161-2223, :2728-3116) · `permissions` (:331-551, :1747-1857, :1997-2160, :2382-2727) · `threshold` (:552-954) · `notifications` (:1136-1746, :2294-2381, :3117-3319) · `guest` (:1858-1996) · `pageViewerState` (:2224-2293 — the only pure block; extracting it makes something runnable without `DATABASE_URL`). `makePage()` is redefined at :68-74, :462-468, :2765-2771 |
| `backend/models/navigation.test.ts` | 3,173 | `validation` (:43-144, pure) · `overrides` (:145-421) · `copy` (:422-592) · `locale` (:593-767) · `mode` (:768-987, :1309-1536) · `generate` (:988-1308, :2904-3173) · `permissions` (:1537-1738) · `core` (:1739-2903 — the 1,014-line catch-all needs a second pass by nested describe) |
| `backend/models/pages.test.ts` | 2,969 | one 2,445-line describe (:32-2476) → `create`/`update`/`move`/`delete` by nested describe · `watchNotifications` (:2477-2849) · `getPageSelection` (:2850-2969, pure) |
| `backend/core/scheduler.test.ts` | 1,682 | `jobs` (pure: :41-257, :436-619, :856-947) · `execution` (:258-435, :620-855) · `reaping` (DB: :948-1521, :1587-1682) · `schema` (DB: :1522-1586). `before()` at :952-957 mutates `scheduler.tasks`/`maxWorkers` — must move with its describe |
| `backend/core/collab.test.ts` | 1,433 | `participants` (:63-144) · `capture` (:145-344, :578-864; `FakeSocket` :26-43 → `test/collabWorker.ts`) · `relay` (:345-577, :865-1129) · `crossInstance` (DB: :1130-1433) |
| `frontend/src/stores/page.test.js` | 1,188 | `page.save` (:24-512) · `page.load` (:513-667) · `page.lifecycle` (:668-1094) · `page.derived` (:1095-1188). Removes the 3 colliding `stubRouter`s |
| `frontend/src/pages/Graph.test.js` | 1,154 | 3 describes / 51 `it`s — worst-structured. Fixtures :1-198 → `pages/graphFixtures.js` (sibling `graphFilters.test.js` sets the naming); then `rendering` (:200-360) · `sizing` (:361-402, :466-594) · `tooltip` (:403-465) · `i18n` (:595-831) · `layout` (:832-985) · `fallback` (:986-1154) |
| `frontend/src/components/EditorMarkdown.test.js` | 994 | preamble :1-198 → `editorMarkdownHarness.js` (also for existing `EditorMarkdown.collab/deadcode.test.js`); `content` (:199-322, :784-967) · `preview` (:323-417, :649-730) · `resize` (:506-648) · `assets` (:418-505) · `lifecycle` (:731-783, :968-994) |
| `frontend/src/pages/Index.test.js` | 922 | `view` (:118-247, :298-348) · `blocks` (:349-584) · `routing` (:248-297, :740-922) · `missingPage` (:585-739) |
| `frontend/src/App.test.js` | 918 | `App.theme` (:91-298) · `App.locale` (:299-480) · `App.prefetch` (:481-554) · `App.navGuard` (:555-833); :834-918 → existing `App.logout.test.js`. Retires 8 of the identical `createI18n` one-liners |
| `frontend/src/components/PageActionsCol.test.js` | 903 | preamble :1-223 → `pageActionsHarness.js`; `export` (:278-507) · `assets` (:508-638) · `menu` (:639-903) · `buttons` (:224-277) |
| `frontend/src/components/HeaderSearch.test.js` | 830 | `entry` (:60-246) · `preview` (:247-527, :613-756) · `suggest` (:528-612, :757-830) |

### F15. Structural/doc suites under `backend/test/` and frontend source-scanners — are they guarding something real? | net LOC −120 (walker dedup only) | risk low | effort S

- Ran them: `node --test test/docs-*.test.ts test/*-doc.test.ts …` → **319 tests, 58 suites, 0 failures, 0 skipped**. Every referenced file exists (`docs/{variances,operations,release-checklist,tls-termination,versioning}.md`, `docs/migration/*.md`, `RELEASING.md`, `README.md`, `config.sample.yml`, `cliff.toml`, `.github/workflows/{build,release,e2e,quality}.yml`, `.github/dependabot.yml`, `.devcontainer/docker-compose.yml`, `dev/build/Dockerfile`). The docs consolidation in `e19aaa72` did not orphan any of them.
- The strong ones cross-check a doc against a **code constant** and would catch real drift: `docs-claude-md-fixme-bullet.test.ts:98-127` (CLAUDE.md's three permission lists vs `GLOBAL/PAGE/SITE_PERMISSIONS`), `docs-todo-fixme-drift.test.ts:115-160` (variances audit vs live TODO scan), `migration-*-doc.test.ts` (mapping docs vs vendored 2.x schema + real module dirs), `operations-doc.test.ts:37-64` (dataPath subdirs vs model source), `release-workflow.test.ts`, `postgres-version-consistency`, `lockfile-integrity`, `dockerfilePuppeteerInstall`.
- The weak ones (not proposed for deletion per the brief; listed so the owner can decide):
  - "deleted file stays deleted": `docs-tls-story.test.ts:34-61` (`AdminSsl.vue` absent, `routes.js` has no `AdminSsl`, `AdminLayout.vue` has no `/_admin/ssl`).
  - WP-number provenance: `release-checklist-doc.test.ts:71-73,88-90,119-121` assert the literal strings `#423`/`#424`/`#425` appear in the checklist.
  - A test on a **source comment**: `docs-todo-fixme-audit.test.ts` (whole file, 44 lines) asserts `types/global.d.ts`'s comment above `sites:` contains `TODO` and not "once db/schema.ts is converted".
  - Literal-value restatements: `locales/en-admin-measurement-labels.test.ts:23-35` (three `assert.equal(parsed['admin.X.title'], '<literal>')`).
  - Backend restatement tests noted by the module survey: `core/collab.test.ts:509-511` (`RELAY_CHUNK_SIZE === 5000`), `helpers/permissions.test.ts:10-43` and `helpers/siteRules.test.ts:22-32` (`deepEqual(CONST, [...the same strings])`), `models/sites.test.ts:39-48` (`DEFAULT_THEME_COLORS` snapshot whose docblock claims agreement with `tailwind.css` but reads no CSS), `migration/phases/phases.test.ts:191-197`, 58 `assert.equal(parsed.key, '<yml literal>')` lines across the 8 `definition.test.ts` files.
- What *should* change: the file-walker is copied — `backend/test/docs-todo-fixme-drift.test.ts:46-59` ≡ `docs-claude-md-fixme-bullet.test.ts:37-50` (identical except one skip suffix); on the frontend, 7 walkers (`src/autofocusUsage.test.js:39-49` ≡ `src/buttonAccessibility.test.js:22-32`; `src/imgAlt.test.js:28-40` ≡ `src/adminIconHeaderSize.test.js:28-40`; `src/components/dialogAccessibleName.test.js:33-44`; `src/i18nSourceGate.test.js:52-63`; `src/css/_base.test.js:29-40`; `src/physicalPositioning.test.js:86-92`; `src/i18nUnexpectedErrorLiteral.test.js:28-39`). One `listSourceFiles(root, { ext, skip })` in `backend/test/sourceFiles.ts` and `frontend/test/sourceFiles.js`. The 12 sibling-less frontend files and `blocks/definitions.test.js` are all intentional scanners — keep.

### F16. DB-gated vs pure — the numbers, and the mixed-file problem | (informational; enables F1/F14) | risk — | effort —

- 67 files mention `hasTestDatabase()`; **61 gate on it in code** (`test/changelog.test.ts` and `test/devcontainerDatabaseUrl.test.ts` only mention it in comments; `tasks/simple/dispatch-storage.test.ts:300-324` and `migration/connectors/postgres.test.ts:157,…` gate per-test on their own boolean rather than `skip:`).
- By directory: `models/` 32, `api/` 10, `tasks/simple/` 5, `migration/phases/` 5, `importer/` 4 (dead — F12), `core/` 4, `test/` 3, `migration/` 2, `modules/search/db` 1, `migration/connectors` 1.
- Those 67 files hold **1,484 / 4,806 test cases (31%)** and **45,660 / 111,304 LOC (41%)**; the rest of the suite (~3,300 cases) runs with no `DATABASE_URL`.
- **35 files mix gated and ungated top-level describes** (list in `scratchpad/mixed.txt`): extremes are `models/storage.test.ts` (52 describes, 1 gated — ~1,050 of 1,196 LOC is pure), `models/jobs.test.ts` (11 pure `JOB_SCHEDULE_SEED` tests before 3 DB describes), `core/scheduler.test.ts` (12/3), `core/collab.test.ts` (12/1), `api/authentication.test.ts` (11/1), `migration/verify.test.ts` (11/1). Splitting these (F14) makes the pure/DB boundary a filename property and removes the "two `WIKI` globals installed in one process" ordering hazard F1 describes.
- 25 files are uniformly gated (all `models/{blocks,tree,sessions,…}`, `migration/phases/*.integration`, `tasks/simple/purge-*`).

## Files ranked by size with a one-line verdict each

| File | LOC | Verdict |
| --- | --- | --- |
| `backend/api/pages.test.ts` | 4,289 | **split** into 9 (F14) after F2; two describes relocate (F13) |
| `backend/models/users.test.ts` | 3,587 | **split** into 8; duplicate `setUserGroups` describe merges |
| `backend/models/approvals.test.ts` | 3,319 | **split** into 6; 17 `setupTestDb()` calls → 6 |
| `backend/models/navigation.test.ts` | 3,173 | **split** into 8; the :1739-2903 catch-all needs a second pass |
| `backend/models/pages.test.ts` | 2,969 | **split** into 6 by nested describe |
| `backend/core/scheduler.test.ts` | 1,682 | **split** into 4 (pure jobs/execution, DB reaping/schema) |
| `backend/api/authentication.test.ts` | 1,565 | leave; convert its 10 `WIKI` literals + 2 `buildApp` to F1/F2 |
| `backend/models/groups.test.ts` | 1,436 | leave; 61 actor literals → `makeActor` (F7) |
| `backend/core/collab.test.ts` | 1,433 | **split** into 4; `FakeSocket` → `test/collabWorker.ts` |
| `backend/modules/search/aws-cloudsearch/search.test.ts` | 1,296 | **rewrite expression** onto the shared contract runner (F6); keep only `buildStructuredQuery`/`buildIndexFields` tests local |
| `backend/models/storage.test.ts` | 1,196 | leave, but lift the single DB describe (:801-946) out so 88% runs ungated |
| `backend/models/sites.test.ts` | 1,187 | leave; :1143-1187 clone of `users.test.ts:3491-3535` → `stubSelect` |
| `backend/models/search.test.ts` | 1,168 | leave |
| `backend/api/sites.test.ts` | 1,158 | leave; hexcolor ajv + permission replica → F2 |
| `backend/migration/connectors/postgres.test.ts` | 1,092 | leave; DDL fixtures → per-table map (F10) |
| `backend/migration/importers/users-groups.test.ts` | 1,068 | leave; `iter` → F10 |
| `backend/models/tree.test.ts` | 1,062 | leave |
| `backend/models/glossary.test.ts` | 1,010 | leave |
| `backend/models/siteImport.test.ts` | 1,005 | leave; 11 site literals → `makeSite` |
| `backend/api/comments.test.ts` | 989 | leave (two apps in one file is deliberate; `comments.admin` stays separate — DB-gated) |
| `backend/modules/search/azure-search/search.test.ts` | 985 | **rewrite expression** onto contract runner (F6) |
| `backend/models/mail.test.ts` | 980 | leave |
| `backend/modules/storage/disk/storage.test.ts` | 962 | leave; two `WIKI` literals in one file → F1 (respect its absent-member-throws intent) |
| `backend/api/graph.test.ts` | 961 | leave; hand-rolled cache (:784-802) → `createCacheStub()` |
| `backend/helpers/rateLimit.test.ts` | 885 | leave; 4× `makeReq/makeReply` + 5 loggers → F9/F1 |
| `backend/modules/search/{elasticsearch,algolia,db}/search.test.ts` | 846/733/722 | **rewrite expression** onto contract runner (F6); byte-identical `fakePage`/`fakeDb` go first |
| `backend/importer/*.test.ts` (7 files) | 1,359 | **delete with the dead module** (F12) |
| `backend/test/release-workflow.test.ts` | 417 | leave (real cross-check of two workflow files) |
| `backend/test/db.ts` | 375 | leave; export `installTestWiki`/`createSilentLogger` (F1) |
| `backend/test/migration-*-doc.test.ts` (5) | 933 | leave (they diff docs against vendored schema/module dirs) |
| `backend/test/docs-todo-fixme-audit.test.ts` | 44 | flag: tests a source comment (F15) |
| `frontend/src/stores/page.test.js` | 1,188 | **split** into 4 |
| `frontend/src/pages/Graph.test.js` | 1,154 | **split** into 6 + `graphFixtures.js` |
| `frontend/src/components/EditorMarkdown.test.js` | 994 | **split** into 5 + harness module |
| `frontend/src/pages/Index.test.js` | 922 | **split** into 4 |
| `frontend/src/App.test.js` | 918 | **split** into 4 (+ merge logout into `App.logout.test.js`) |
| `frontend/src/components/PageActionsCol.test.js` | 903 | **split** into 4 + harness module |
| `frontend/src/components/HeaderSearch.test.js` | 830 | **split** into 3 |
| `frontend/src/components/FileManager.test.js` | 731 | leave; the 5 `createWebHistory()` routers need a look during F4 |
| `frontend/src/components/GroupEditOverlay.test.js` | 685 | leave; 6× identical router → F4 |
| `blocks/block-drawio/component.test.js` | 422 | leave; mount → F8; no dark-mode assertion yet (F8 adds it) |
| `blocks/block-include/component.test.js` | 337 | leave; `stubFetch` → F8 |
| `blocks/block-checklist/component.test.js` | 311 | leave; mount + dark-mode + `stubFetch` → F8 |
| `blocks/shared/theme.test.js` | 228 | leave (the controller's own suite; `describeDarkMode` complements it) |
| `blocks/definitions.test.js` | 107 | leave (real cross-block structural gate, self-extending) |

## Things I checked and rejected (so nobody re-checks them)

- **Orphan tests (test files for code that no longer exists): none.** Every relative import in all three workspaces resolves (442 backend pairs checked; 48/48 `api/*.test.ts` import an existing route file; 33/33 schema targets; frontend/blocks sibling check). The 19 backend and 12 frontend files with no same-named sibling are facet suites (`pages.actorFrom`, `pageRules.nestedDeny`, `s3/storage.emulated`), `definition.yml` suites, `*.integration.test.ts`, or deliberate source-scanners (`i18nSourceGate`, `buttonAccessibility`, `wComponentAttributeDrift`, …). `blocks/definitions.test.js` is real (brace-matches each block's `static definition` out of source; self-extends per block dir).
- **Structural/doc suites are not stale** — 319/319 pass, every target file exists after `e19aaa72`. Weak ones are flagged in F15, not proposed for deletion.
- **Hand-rolled cache/events stubs**: nearly absent (1 cache at `api/graph.test.ts:784-802`, 1 real `Emittery` at `core/db.test.ts:150`, 5 `scheduler: { addJob }` at `models/hooks.test.ts:61,461,469`, `models/storage.test.ts:271,509`, `api/system.test.ts:369`). Not worth a finding on their own; F1's defaults absorb them.
- **`ensureTemporal()` in 32 backend test files**: required, not duplication — Node 26 has no native `Temporal` (CLAUDE.md). `test/temporal.ts` is deliberately separate from `core/temporal.ts`.
- **`test/collabWorker.ts` (400) and `test/sftpServer.ts` (296)**: single-consumer fixtures, but they are real infrastructure (a worker-thread `WIKI` boot; a real SFTP server), correctly placed.
- **Frontend `iconify-icon` / `w-icon` stubs**: none exist — `vitest.config.js`'s `isCustomElement` and `setup.js`'s global `WIcon` registration handle it; tests assert on real `data-icon`. Nothing to consolidate.
- **Frontend site/user/page object-literal fixtures**: only 4 files carry a `{ id, hostname, isEnabled }` literal and 5 a `locales: { primary, active }` — the duplication is single-field seeds (F5), not object shapes.
- **Merging `api/comments.test.ts`↔`comments.admin.test.ts` and `api/sites.test.ts`↔`sites.locale.test.ts`**: rejected — the second of each pair is DB-gated and its header documents the split (`comments.admin.test.ts:20-33`, `sites.locale.test.ts:26-30`). Share the harness (F2), not the file.
- **`api/pages.actorFrom.test.ts`, `pages.mayBypassPassword.test.ts`, `controllers/seo.test.ts`**: pure unit tests with no Fastify — right shape, leave.
- **`helpers/apiKeySite.test.ts` ↔ `test/apiKeySitePinCoverage.test.ts`**: different properties (hook logic vs. structural scan of the real route table); relocate the latter (F13.10), don't merge.
- **`frontend/test/setup.js` default store seeding**: rejected — several suites assert on unseeded stores; seeding stays opt-in at the mount call.
- **`hasTestDatabase()` gating pattern itself**: consistent and correct across all 61 files; the only variance is the two files that gate per-test on a local boolean, which is fine for their shape.
- **Restatement tests** (F15 list, plus `definition.test.ts` scalar asserts): noted for the owner; per the brief, none proposed for deletion. Several are deliberate drift guards.
- **Missing coverage noticed in passing, out of scope**: `controllers/{collab,icons,render,terminal}.ts` have no co-located test; `modules/search/db` lacks `renamed()`/`totalHits` contract tests (F6 would surface it); 10 blocks with `DarkMode` and no assertion (F8 closes it).
