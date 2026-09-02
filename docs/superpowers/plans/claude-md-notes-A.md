# CLAUDE.md notes — Lane A (backend)

- **Task A2 (migration dead code, spec D5).** CLAUDE.md's `migration/` bullet (the `backend/` layout
  table) stays accurate as written — every file and directory it names still exists and still plays
  the role it describes. One optional addition worth considering: D5 deleted the multi-source
  conflict-policy machinery from `migration/mappers/`, so the importer now consolidates exactly **one**
  2.5.x source into one fresh 3.0 instance. If CLAUDE.md ever grows a sentence about what the importer
  can and cannot do, "one source per run, no multi-source consolidation" belongs in it.

- **Task A3 (storage/search/core dead code, spec D4/D8/D9).** Four things CLAUDE.md should now say,
  none of which it currently does:
  - **The storage module contract has no `setup`/`setupDestroy` extension point** (D4). A storage
    module's `definition.yml` declares props and actions only; there is no multi-step setup wizard
    hook, no `POST`/`DELETE /_api/sites/:siteId/storage/targets/:targetId/setup` routes, and no
    `setup` key on the `StorageTarget` API response. If the `modules/` bullet in the `backend/`
    layout table ever describes what a storage module may export, it should list `validateConfig`,
    the content-dispatch handlers and the `definition.yml` action handlers — nothing else.
  - **`WIKI.db.execute()` returns pg's `QueryResult` envelope, not a bare row array** (D8). Read
    `result.rows`; a `result.rows ?? result` probe is dead code. Verified against
    `drizzle-orm@1.0.0-rc.4`'s `node-postgres` driver
    (`NodePgQueryResultHKT.type = QueryResult<...>`, `pg-core/async/db.d.ts:283`). This belongs in
    the "Backend patterns" section beside the existing note that a raw `sql` expression substituted
    into `.select()` returns a postgres-format _string_ rather than a `Date`.
  - **Exactly one `unhandledRejection` handler exists, in `core/processGuards.ts`** (D9). `index.ts`
    registers it once, immediately after `logger.init()`, passing `exit: (code) => process.exit(code)`
    so an unhandled rejection still terminates the process. Do not add a second `process.on(
'unhandledRejection', …)` anywhere — Node runs listeners in registration order and an exiting
    one silences everything after it, which is exactly the bug this removed.
  - **A `Date`-typed column headed for a search index goes through
    `.toTemporalInstant().toString({ smallestUnit: 'millisecond' })`**, not `.toISOString()` and
    never behind an `instanceof Date` guard. All four external search engines (algolia,
    elasticsearch, azure-search, aws-cloudsearch) now agree on this, matching the existing "Dates use
    the `Temporal` API" bullet.

- **Follow-up outside Lane A's workspace, for the controller.** `frontend/src/pages/AdminStorage.vue`
  still carries the storage-setup wizard UI (`state.target.setup`, its two `w-card` blocks at
  `:95-140`, `nextSetupStepName`, and the two `API_CLIENT` calls to the now-deleted
  `.../storage/targets/:targetId/setup` routes at `:1118` and `:1154`). It was already unreachable —
  no module has ever declared a `setup` process, so the server never returned that key — and is now
  definitively dead. Removing it is Lane B's workspace, not A3's.

- **Task A4 (models dead code and un-exports).** Two things worth CLAUDE.md saying, plus one note:
  - **`models/tree.ts#getById` is now `private`.** It is the model's only tree lookup that takes no
    `siteId`, so calling it from outside would reopen the cross-site leak `getFolderById`'s required
    `siteId` closes (OpenProject #2127/#2131). A caller outside the model that needs a tree row by
    id goes through a `siteId`-scoped method; a test reads the row off `treeTable` directly. If the
    "Permissions" section ever gains a note about site scoping at the model layer, this is the
    worked example.
  - **A model method whose only caller is its own test is dead code, not model surface.** A4 deleted
    thirteen of them (`contentSync.getState`/`getStatesForContent`/`getStatesForTarget`/
    `getOutOfDatePages`/`getOutOfDateAssets`, `approvals.countSubmissions`, `sessions.getByUser`/
    `clearAllSessions`, `authentication.getStrategy`, `blockCredentials.deleteSiteCredentials`,
    `commentProviders.canonicalPageUrl`/`getActiveProvider`, `rendering.sanitize`,
    `tree.listDescendantPages`) and re-expressed each test's read-back as a local fixture helper over
    the table (or, for a private method, through the existing `as any` cast). The "Testing
    (backend)" section's guidance could say so outright: a read-back oracle belongs in the test
    file, not on the model.
  - **`docs/variances.md`'s OpenProject #823 item 6 entry** no longer names
    `getState`/`getStatesForTarget` (both deleted); it now says the row's own `lastError` still
    stands in `contentSyncState`. No CLAUDE.md change follows from it — noted so the next reader of
    that entry knows the wording moved deliberately.

- **Task A5 (duplicate-test cleanup and relocations, TEST-F13).** No CLAUDE.md content change
  follows — this task was purely test-file reorganisation (merged duplicate describes, relocated
  two misplaced suites, deleted one root-level co-location violation) with zero behaviour or
  production-code touched. `backend/locales-en.test.ts`'s deletion is itself an instance of the
  "Testing (backend)" section's existing co-location rule doing its job (a root-level test for a
  co-located source file, folded into `backend/locales/en.test.ts`), not evidence that rule needs
  restating or amending.

- **Task A6 (`helpers/pageAccess.ts`, API-F1/F6/F8).** Three things CLAUDE.md must now say:
  - **The page/asset/folder access helpers live in `backend/helpers/pageAccess.ts`, not in route
    files.** `actorFrom`, `mayBypassPassword`, `unlockedFor`, `mayOnPage`, `pagePermissionsFor`,
    `loadReadablePage`, `requireReadablePage`, `requireActorId`, `mayOnAsset`, `mayOnFolder`,
    `visibleTreeItems` and `splitList` all moved out of `api/pages.ts` / `api/assets.ts` /
    `api/tree.ts`. Two lines in the **Permissions** section point at the old home and are now wrong:
    `:413` ("`PAGE_PERMISSIONS`, declared in `helpers/permissions.ts` and imported by
    `api/pages.ts`" → imported by `helpers/pageAccess.ts`) and `:418` ("or `mayOnPage(req,
permission, page)` in `api/pages.ts`" → in `helpers/pageAccess.ts`, and its real signature is
    `mayOnPage(req, permission, siteId, page)`). `:437`'s "`No route-level permissions:` comment, as
    `api/pages.ts`, `api/assets.ts`, …" is still correct — that names route files, not helpers.
  - **A page-scoped route's 404/403 preamble is `requireReadablePage`, not hand-written.** The
    check order is fixed and load-bearing: missing-or-unreadable → 404 `'This page does not
exist.'`, then the route's own second permission → 403 with its own message, then still-locked →
    403 `'This page is password protected.'`. A route needing a different order calls it without
    `permission` and checks afterwards (`api/checklists.ts`'s check-off route is the worked
    example); a route that deliberately tolerates a locked page passes `allowLocked: true`
    (`api/pages.ts`'s backlinks listing). The `null`-once-a-reply-is-sent convention (`if (!page) {
return reply }`) is shared with `requireActorId`.
  - **A route file must never import another route file.** That was the only reason
    `api/comments.ts`, `api/checklists.ts`, `api/watching.ts`, `api/approvals.ts`, `api/tags.ts`,
    `api/notifications.ts`, `api/tree.ts` and `controllers/collab.ts` reached into `api/pages.ts` /
    `api/assets.ts`; shared logic goes in `helpers/`. This also keeps `api/*.ts` uniformly
    "everything here is a Fastify route plugin", which `api/routeTags.test.ts`,
    `api/responseErrors.test.ts` and `api/index.test.ts` structurally depend on.

- **Task A9 (`helpers/moduleRegistry.ts`, MOD-F1).** Two things CLAUDE.md should now say:
  - **The pluggable-module boilerplate lives in `backend/helpers/moduleRegistry.ts`, once.** The six
    module-backed models (`storage`, `search`, `authentication`, `commentProviders`, `analytics`,
    `extensions`) no longer each carry their own definition scan, config merge, config validation,
    implementation probe, module loader and per-site row sync — they bind to
    `readModuleDefinitions` / `mergeModuleConfig` / `validateModuleConfig` / `moduleHasFile` /
    `loadModule` / `syncSiteModuleRows`. Their public method names and return shapes are unchanged
    (`buildConfig`, `validateConfig`, `hasImplementation`, `ensureModule`, `syncSite`, …), so nothing
    outside them changes. The `modules/` bullet in the `backend/` layout table could name the helper
    as the shared machinery behind "pluggable extensions, discovered from disk".
  - **The extension-sensitive dynamic `import()` strings are unaffected, by design.** `loadModule`
    takes an importer _closure_, so `models/storage.ts`'s `../modules/storage/${key}/storage.ts`,
    `models/search.ts`'s `../modules/search/${key}/search.ts` and `models/authentication.ts`'s
    `../modules/authentication/${stg.module}/authentication.ts` all still sit literally at their own
    call sites — CLAUDE.md's "Five dynamic paths are extension-sensitive" list stays correct
    verbatim, and a future model must keep its specifier at the call site rather than passing a
    string into the helper. The three probed implementation filenames (`storage.ts`, `search.ts`,
    `comments.ts`) likewise stay literal at each model's `hasImplementation`.

- **Task A7, step 1 (shared unknown-site 404, spec D1).** CLAUDE.md's "Backend patterns" and
  "Permissions" sections should now say:
  - **An unknown `:siteId` answers `404 'This site does not exist.'` from one place** —
    `helpers/common.ts#siteEnabledPreHandler`, the `preHandler` `api/index.ts` registers on its
    guarded `contentApp` scope — not from each route handler. The 36 hand-written site-existence
    preambles (23 `await WIKI.models.sites.getSiteById(...)` + `'Site does not exist.'`, 13 bare
    `WIKI.sites[...]` + `'This site does not exist.'`) are gone, and every other `:siteId` route
    that never checked at all is covered for the first time. **A route under `api/index.ts` may
    assume its `:siteId` site exists**, and a new route file inherits that with no call of its own.
  - **The two deliberate exemptions** are `api/sites.ts` (registered outside `contentApp`, since
    `PUT /sites/:siteId` is how a disabled site is re-enabled — it keeps its own
    `'Site does not exist.'` 404s) and `api/bootstrap.ts` (resolves its site by hostname, not a
    `:siteId` param).
  - **Hook order is load-bearing**: `index.ts`'s global permission `preHandler` is on the root app
    and therefore runs first, so an unauthorized caller still gets 401/403 rather than learning
    which site ids exist.
  - **A per-file test suite that mounts one route plugin alone must register the hook in its
    `buildApp`** (`app.addHook('preHandler', siteEnabledPreHandler)`) and stub `WIKI.sites` — not
    `WIKI.models.sites.getSiteById` — for its unknown-site cases to mean anything. Eight suites do
    this now (`approvals`, `authentication`, `blockCredentials`, `blocks`, `comments`,
    `comments.admin`, `glossary`, `liveData`, `search`). This belongs in "Testing (backend)".

- **Task A7, step 2 (shared `params` schemas, finding API-F4).** CLAUDE.md's "Backend patterns" and
  "Testing (backend)" sections should now say:
  - **`params:` reaches for a `$ref` like every other schema slot.** `api/schemas/params.ts`
    registers `SiteIdParams`, `SitePageParams`, `SiteFolderParams`, `SiteTagParams` and
    `SitePageCommentParams` (via `registerParamsSchemas`, wired in `api/index.ts` alongside the 33
    `registerSchemas` calls); a site-scoped route writes `params: { $ref: 'SiteIdParams#' }` rather
    than a fresh object literal. 85 literals and eleven per-file `const siteIdParam`/`pageIdParam`/
    `folderIdParam`/`pageParams`/`siteIdTagParam` declarations are gone.
  - **A route whose params carry anything else keeps its literal** — a `kind`, an `alias`, an
    `action`, a `pageIdOrHash` with its own description, or any of the one-off `:xId` pairs
    (`ruleId`, `credentialId`, `navId`, `termId`, `versionId`, `assetId`, `commentId`, …). The
    shared ids cover the shapes that recur, not every combination.
  - **A test suite that mounts one route plugin alone must call `registerParamsSchemas(app)`** in
    its `buildApp`, next to the `registerSchemas` calls it already makes — otherwise `app.ready()`
    throws `FST_ERR_SCH_*` on the unresolvable `$ref`. 25 suites do this now.

- **Task A7, step 3 (`checkSiteAdminAccess`, finding API-F3).** CLAUDE.md's "Permissions" section
  should now say:
  - **The "global permission OR `site:*` delegation" question has one implementation**:
    `WIKI.models.groups.checkSiteAdminAccess(req, globalPermission, sitePermission, siteId)`, next
    to `checkSiteAccess` in `models/groups.ts`. The five byte-identical route-file wrappers
    (`mayAdministerApprovals`, `mayManageBlocks`, `mayManageCredentials`, `canManageNavigation`,
    `maySaveSiteImage`), each with its own copy of the same rationale paragraph, are gone; a route
    calls it directly. The rationale — the global half is checked first and site-blind, so
    delegation is additive rather than a migration, and the site half is `checkSiteAccess()`
    unchanged (site pin, API-key scope boundary, `manage:system` bypass all still apply) — is
    written once, on the method.
  - **Route call sites reach it through `helpers/siteRules.ts#maySiteAdmin`**, a four-argument
    shorthand with no logic of its own that resolves `WIKI.models.groups` at CALL time. It exists
    only so a one-line permission gate stays one line: spelled out in full the check is 107 columns
    inside an `if (!…)` and oxfmt breaks it across five. It is the one `WIKI` touch in an otherwise
    WIKI-free file — the rule-resolution algorithm above it stays a pure function.
  - **A test suite stubbing `WIKI.models.groups` for a site-scoped admin route must stub
    `checkSiteAdminAccess` too**, built with `backend/test/mocks.ts`'s
    `createSiteAdminAccessStub(actorForRequest, checkSiteAccess)`, which composes that suite's own
    two stubs exactly as the real method composes the real pair. Five suites do this now. This is
    the same "build the smallest object satisfying what the code path calls" convention the
    `cache`/`events` stubs already follow, extended to a `WIKI.models` member.

- **Task A12 (storage blob factory, sftp thresholds, one extension map — CORE-F3/F4/F18, spec D3).**
  Three things CLAUDE.md should now say:
  - **`s3`, `azure` and `gcs` are drivers over `modules/storage/blobBase.ts`, not standalone
    modules.** Each still owns its SDK imports, its client construction and its bucket/container
    verification, but exports `blobStorageModule({ label, build, put, remove, copy, sign })` as its
    default: the activation cache (one client per target, keyed on `JSON.stringify(config)`, a failed
    activation deliberately not remembered), the object key (`keyFor` → `helpers/blobTarget.ts`'s
    `objectKeyFor`), the `Failed to <action>: <message>` error wrapping, the shared
    `DIRECT_ACCESS_TTL_SECONDS`, and all five handlers
    (`assetUploaded`/`assetDeleted`/`assetRenamed`/`exportAll`/`getDirectUrl`) live in `blobBase.ts`
    only. A fourth blob target is a driver, not a fourth copy of that half; `keyFor` is imported from
    `blobBase.ts` (including by the three modules' own tests), never re-declared.
  - **There is one large-file threshold semantics in the backend, `helpers/blobTarget.ts`'s** (D3):
    1024-based units, and `fileSize >= threshold` files an asset as `large`. `sftp` used to parse
    1000-based units and test `>` — that divergence is gone, and `modules/storage/sftp/assets.ts` now
    gates each row on `belongsInTarget(asset, target.contentTypes)` like every other target. A target
    module must not re-implement threshold parsing or the kind→category map.
  - **One page content-type→extension table: `helpers/pageSerialization.ts`'s
    `CONTENT_TYPE_EXTENSIONS`** (bare extensions, `DEFAULT_CONTENT_TYPE_EXTENSION = 'txt'`, read
    through `fileExtensionForContentType` or the dotted `extensionForContentType`).
    `models/storage.ts`'s `getFileExtension` delegates to it and builds its reverse map from it
    (skipping the `txt` default, so a bare `.txt` still reads as an asset); `modules/storage/git`'s
    probe list is its distinct values; `modules/storage/disk` spreads it and overrides
    `redirect: 'json'` — the one documented divergence, because a redirect's content is already JSON
    there.

## Task A13 — `modules/search/` (CORE-F5)

- **The five search engine modules share `modules/search/shared.ts` and
  `modules/search/externalBase.ts`.** The doctrine each engine's own header used to state — "copied
  rather than imported: each engine module stays self-contained" — is overturned: self-containment
  holds between an engine and its _vendor SDK_, not between an engine and the vocabulary they all
  already import from `models/search.ts`. A new engine extends `ExternalSearchModule` and imports
  from `shared.ts`; it does not re-declare any of `escapeHtml`, `HL_START`/`HL_STOP`,
  `normalizeMarkers`, `SCAN_CAP`, `MAX_INDEXING_BYTES`/`MAX_INDEXING_COUNT`, `REBUILD_BATCH_SIZE`,
  `batchBySize`, `SearchDocument`/`buildSearchDocument`, `RebuildPageSource`/`defaultPageSource`,
  `pageStream`/`localePageStream`, `filterVisible` or `toSearchPagesResult`.
- **`ExternalSearchModule` (`modules/search/externalBase.ts`) owns the four page-lifecycle forwarders
  and the never-throws wrapper.** A subclass implements `indexPage`/`removePage` (both `protected`)
  plus `init`/`query`/`rebuild`, and wraps each index write in `this.neverThrows(work, describe)` —
  the message is the engine's own, since operators grep four different strings. A subclass with a
  constructor must call `super()` first. **`db` deliberately does NOT extend it** and stays on the
  bare `SearchModule` interface: its `deleted` is a genuine no-op and its `renamed` only acts on a
  locale change, so the shared forwarders would be wrong for it. It imports from `shared.ts` only.
- **Client construction/caching is deliberately not in the base class** — every engine's is a
  different shape (Algolia pushes index settings first, Elasticsearch creates the index if absent,
  Azure and AWS each keep two clients behind injected factories). Don't hoist it without a reason
  bigger than symmetry.
- **`totalHits`/`totalHitsApproximate` are computed in exactly one place:
  `shared.ts#toSearchPagesResult`.** Both are derived from the permission-filtered rows alone, never
  from a count the engine reported before filtering — that is the OpenProject #2151/#2156 count
  oracle, and re-deriving either at an engine reopens it. `db` builds its own tail (it has a
  `suggestion` and its no-actor path is already `LIMIT`/`OFFSET`-windowed in SQL) but uses the shared
  `filterVisible`.
- **Every engine reads its per-site config through `search.getEngineConfig(siteId, key)`**, and no
  engine re-applies a `definition.yml` default by hand (`indexName || 'wiki'` and friends are gone).
  This makes `index.ts` calling `WIKI.models.search.refreshFromDisk()` _before_
  `initActiveEngines()` load-bearing rather than incidental — `models/search.test.ts` now has a
  structural check that a reorder cannot pass silently. A test that constructs an engine directly has
  to set `WIKI.SERVERPATH` and `await search.refreshFromDisk()` first, and that hook must be
  registered _after_ the `WIKI` assignment: a root-level `before()` in `node:test` runs before the
  top-level statements that follow it.
- **`aws-cloudsearch` declares its index fields in the AWS SDK's own `IndexField` shape**
  (`IndexFieldName`/`IndexFieldType`/`LiteralOptions`/`TextOptions`/`LiteralArrayOptions`), not a
  module-local vocabulary translated at the boundary. Don't reintroduce a translation layer.

- **Task A8 (small shared-helper bundle).** Seven single-source facts CLAUDE.md's "Backend patterns"
  section should now carry, none of which it currently does:
  - **A hostname resolves to a site id through `helpers/common.ts#siteIdForHostname(hostname, {
    strict })`**, never by indexing `WIKI.sitesMappings` at a call site. It folds the case
    (`normalizeHostname`, OpenProject #2127) and applies the `*` catch-all fallback; `strict` skips
    that fallback. `models/sites.ts#getSiteByHostname`, `index.ts`'s two hooks,
    `api/authentication.ts` and `api/diagrams.ts` all go through it. Its siblings:
    `siteForHostname(hostname)` for "the site behind this request's own `Host`, or null", and
    `resolveSiteParam(param, hostname, { strict })` for the `current`/uuid/hostname three-way a path
    parameter can spell (`api/sites.ts`, `controllers/site.ts`).
  - **A cacheable response's ETag/`Cache-Control`/304 dance is
    `helpers/httpCache.ts#notModifiedOrPrepare(req, reply, { etag, cacheControl, nosniff })`**, which
    returns `true` once it has sent the 304. It also sends `X-Content-Type-Options: nosniff` unless
    told not to — the default suits any route serving stored or uploaded bytes.
  - **Racing work against a ceiling is `helpers/timeout.ts#withTimeout(work, ms, onExpire, { unref
    })`.** `onExpire` is a callback so each caller keeps its own error type, and the error is only
    built if the timer wins. Nothing is cancelled: the work runs on, the caller stops waiting.
  - **Puppeteer availability, refusal and close go through `helpers/puppeteer.ts`** —
    `isPuppeteerAvailable()`, `assertPuppeteerAvailable(errorName, message)` (503) and
    `closeQuietly(closable, label)`, beside the existing `launchPuppeteerBrowser`.
  - **`helpers/common.ts` owns `isUniqueViolation(err)` (postgres `23505`, however the driver wrapped
    it), `escapeLikePattern(value)` and `BCRYPT_ROUNDS`** (the one cost factor everything is hashed
    at). Do not re-declare any of the three, and do not write `bcrypt.hash(x, 12)`.
  - **`purgeFilesOlderThan(dir, ttlSeconds)` in `helpers/fsPurge.ts`** is the TTL sweep of a
    `<dataPath>` directory (a missing directory counts as zero).
  - **"Are these real group ids" is `WIKI.models.groups.hasUnknownGroupIds(ids)`**, the only owner.

  Two smaller ones: `mcp/tools/shared.ts` holds `toResult` plus the shared `siteIdArg`/`localeArg`
  zod fields (a tool file declaring its own `toResult` is a regression), and `mcp/` reads a site's
  default locale through `helpers/common.ts#defaultLocale(siteId)` like everything else.

- **Deferred out of A8, for whoever owns the files.** Two call sites of A8's helpers live in task
  A13's workspace and were deliberately left alone: `models/search.ts#initActiveEngines`'s timeout
  race (should become a `withTimeout` call) and `modules/search/db/search.ts`'s `escapeLikePrefix`
  (byte-identical to `helpers/common.ts#escapeLikePattern`).

- **A19 — `backend/migration/` layout and shared helpers.** CLAUDE.md's `migration/` bullet is now
  stale in three ways:
  - **Every importer lives under `migration/importers/`.** `page-import.ts`,
    `page-history-import.ts` and `navigation-import.ts` moved there from the `migration/` root;
    `content-staging.ts` and `path-normalization.ts` stay at the root because they only read/compute.
  - **`migration/report.ts` is the one report module**: the `PhaseReport`/`UnmappableEntry` shapes,
    `classifyUserAuthProvider`/`KNOWN_3_0_AUTH_MODULES` (was `unmappable.ts`) and
    `formatReportTable`/`reportsToJson` (was `render.ts`). Its co-located suite is `report.test.ts`.
    `importers/user-converters.ts` folded into `importers/users-groups.ts`, which now owns every
    `GroupConverter`/`UserConverter` in the engine.
  - **"recording provenance" is gone** — `migration/provenance.ts` was deleted by task A2; each phase
    decides its own `wouldSkipExisting` instead. The sentence should say "recording a dry-run report
    along the way".
- **A19 — three shared migration helpers new code must use, not re-derive.**
  - **`migration/phases/route.ts#routeOutcome(recorder, identifier, outcome, log?)`** is the only
    place a phase turns an already-attempted per-record import into a `WriteRecorder` call. A phase
    maps its own importer's outcome type onto `RecordOutcome` (`created` + optional pre-formatted
    `notes` / `skipped` / `conflicted` + `detail`) in a local `toRecordOutcome()` and calls it.
    **The write always happens before routing, never as `recorder.create()`'s `write` callback** — an
    importer that reports failure by returning it would otherwise be counted as a create, and one
    that throws would take down the whole phase's report.
  - **`migration/phases/dry-run.ts`** holds `writeUnlessDryRun(dryRun, placeholder, write)` and
    `placeholderRow()`. Every injected write model in `phases/{content,assets}.ts` uses them; do not
    hand-roll another `if (ctx.dryRun) return { id: crypto.randomUUID() }`.
  - **`migration/mappers/shared.ts`** holds `isPlainObject`, `transformConfig(transforms, module,
    raw)`, `unwrapKnexValue` and **two** picks: `pickDefined` (drops an explicit `undefined` — what a
    module-config mapper wants, since an `undefined` would override `buildConfig`'s declared default)
    and `pickPresent` (bare `in` — what `site-settings.ts` wants, so an operator's explicit
    `false`/`0`/`''` survives the deep merge). **Do not swap any of these for `es-toolkit`'s**: its
    `isPlainObject` rejects class instances, which a `pg` row object is.
- **A19 — `define-phase.ts` no longer reclassifies a successful read as `not_implemented`.**
  `trackWriteCapability` and the "no entity supplied a `write` callback, so call the whole phase
  not-implemented" pass are deleted: every phase has a real write path, so the only thing that
  produces `status: 'not_implemented'` now is an entity generator throwing `NotYetImplementedError`
  (which today means an `ExportBundleSourceConnector` source's
  `users`/`groups`/`settings`/`comments`/`assets`). A no-op `recorder.create(id, async () => {})`
  sentinel therefore has no reason to exist — write `recorder.create(id)`.
- **A19 — `NavigationWriteModel` mirrors the real model.** `importers/navigation-import.ts` now
  declares `ensureSiteNav(siteId, locale): Promise<string>` and `setNavItems(siteId, navId, items)`,
  the exact `WIKI.models.navigation` signatures; the adapter that used to reconcile the old
  siteId-only shape inside `phases/content.ts` is gone.
- **A19 — deliberately NOT done, and why.** The plan's file list also called for merging
  `migration/orchestrator.ts` into `tasks/migrate.ts`. Skipped: `tasks/migrate.ts` calls `main()` at
  module load, so importing it to reach `runMigration` would boot the CLI, and the merge would have
  cost `orchestrator.test.ts`'s 101 lines of real coverage for no structural gain.
- **A19 — one stale path left in another lane's file.** `backend/models/pages.ts` (task A13's
  workspace) still names `backend/migration/page-import.ts` in a doc comment; it is now
  `backend/migration/importers/page-import.ts`. `docs/variances.md`'s TFA-drop entry likewise still
  names the deleted `backend/migration/importers/user-converters.ts#createLocalUserConverter` (that
  function now lives in `importers/users-groups.ts`) — left alone per the no-variances-edits rule.
- **A15 — `index.ts` is now only the boot script; the HTTP wiring lives in `backend/core/http/`.**
  CLAUDE.md's `backend/` layout section should list `core/http/` alongside `core/`'s other
  singletons: `security.ts` (helmet/CSP/CORS), `session.ts` (cookie + @fastify/session + the
  cookie-security diagnostic hook), `openapi.ts` (swagger + swagger-ui), `authHooks.ts` (API-key
  bearer, same-origin gate, the two rate limiters, the route-permission `preHandler`, the API-key
  site pin), `siteRouting.ts` (`RESERVED_ROOT_FILES` / `SERVER_ROUTE_SEGMENTS` / `isPageUrl`, the SEO
  redirects, per-request site resolution, the app-shell not-found fallback), `errors.ts`
  (`setErrorHandler`) and `routes.ts` (every mounted prefix). `index.ts` keeps the `WIKI` literal,
  `preBoot`/`postBoot`, the Fastify instance options, gracefulServer, the static asset mounts and the
  three-phase sequence. Several places in CLAUDE.md still say "registered in `index.ts`" about hooks
  and prefixes that now live in `core/http/*` — the Permissions section's "enforced by a single
  `preHandler` hook in `index.ts`" is the load-bearing one (it is `core/http/authHooks.ts#permissionPreHandler`).
- **A15 — three pieces of `index.ts` are now importable pure functions.**
  `core/http/authHooks.ts#permissionPreHandler` (callback-style `(req, reply, done)`, same shape as
  `helpers/common.ts#siteEnabledPreHandler` and `helpers/apiKeySite.ts#apiKeySitePinHook`),
  `helpers/openapi.ts#swaggerTransform` and `helpers/errorHandler.ts#apiErrorHandler`. Plus
  `api/index.ts#registerAllSchemas(app)` and `models/sessions.ts#sessionStoreAdapter()`. A test that
  needs the real route-permission gate, the real `/_api` error body or the full shared-schema set
  imports these rather than re-writing them (TEST-F2).
- **A15 — stale `index.ts` pointers left in another lane's files.** `backend/controllers/metrics.ts`
  and `backend/controllers/seo.ts` name `index.ts`'s `RESERVED_ROOT_FILES` / `SERVER_ROUTE_SEGMENTS`
  in doc comments; those constants are now exported from `backend/core/http/siteRouting.ts`.
