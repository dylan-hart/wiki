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

- **A10 — five new shared backend helpers, worth naming in CLAUDE.md's "Existing shared utilities"
  reasoning (and in the "Backend patterns" section):**
  - **`helpers/clusterCache.ts#ClusterReloaded`** is now the single home of the cross-instance
    reload protocol. A model that keeps a process-local cache of a whole table `extends
    ClusterReloaded`, declares `protected readonly reloadEvent = '<name>'` and implements
    `reloadCache()`; it must NOT write its own `broadcastReload()`/`subscribeToEvents()`. The two
    rules the base class encodes: a mutator calls `broadcastReload()`, never `reloadCache()`
    directly; and `reloadCache()` never emits, or the event echoes around the cluster forever. The
    five models on it today are `groups`, `sites`, `approvals`, `classificationLevels`, `locales`.
    (`glossary.ts` and `navigation.ts` are deliberately NOT on it — theirs are per-site
    `{ siteId }` invalidates, not whole-cache reloads.)
  - **`helpers/pagination.ts#paginate`** is the one offset-pagination idiom. Its `total` thunk takes
    drizzle's own `select({ total: count() })` query — `count()` from `drizzle-orm` is now the only
    count spelling in the model layer, and one of the six sites counts across an `innerJoin`, which
    `db.$count`'s table-or-subquery shape cannot express.
  - **`helpers/common.ts#assertLocaleActive` / `#assertPathNotReservedLocale`** are the two
    page-placement refusals (`pageInvalidLocale`, `pageReservedLocaleSegment`). `tree.ts`'s
    reserved-locale checks are a deliberately different error (`treeReservedLocaleSegment`, root-only)
    and are not these.
  - **`models/hooks.ts#announce`** (a module function, not a `Hooks` method) is how a page or asset
    write tells the outside world: webhook emit then storage dispatch, both awaited, in that order.
    Every content write path uses it; do not re-inline the pair. It is a module function precisely so
    a caller's test can stub `WIKI.models.hooks` as a bare `{ emit }` without losing it.
  - **`models/tree.ts#holdsVisiblePagesUnder`** is the shared "does this folder hold a page a reader
    may open" `EXISTS`, exported alongside `pageIsVisible`/`compareFoldersFirst`/`MAX_DEPTH` for
    `navigation.ts` — the cross-model reuse convention CLAUDE.md already describes for that pair.
  - **`models/users.ts` now exports `userSelection`** alongside `UserCore`/`UserPage`; `groups.ts`
    imports all three rather than restating them. If a column is added to the user list projection,
    it is added once, here.

## Task A16 — the shared backend test harness (TEST-F1/F2/F7/F9/F10/F15)

CLAUDE.md's **"Testing (backend)"** section is where all of this belongs; several of its existing
sentences are now incomplete rather than wrong.

- **`backend/test/` now holds six shared harness modules, not two.** Alongside `db.ts`,
  `permissionScenario.ts`, `collabWorker.ts`, `sftpServer.ts` and `temporal.ts`:
  - **`mocks.ts`** — the existing `createCacheStub`/`createEventsStub`/`createSchedulerStub`/
    `createSiteAdminAccessStub`, plus `createSilentLogger()`, `createWikiStub(overrides)` and
    `installTestWiki(overrides) → { restore() }`. **A test never writes a `WIKI = {…}` literal
    again**: it calls `installTestWiki({ …only what its code path reads… })` and restores in
    `after()`/`afterEach()`. `db.ts`'s own `WIKI` is now a caller of the same builder.
  - **`fastify.ts`** — `buildTestApp({ routes, wiki, schemas, session, permissions, apiKeySitePin,
    ajv, swagger, prefix })` and `closeTestApp(app)`, plus `makeRequestStub`/`makeReplyStub`/
    `makeDoneStub` for a hook driven with no server around it.
  - **`routeRecorder.ts`** — `createRecordingApp`, `listApiRouteFiles`, `recordRoutesFrom`,
    `referencesApiError`, `stubWikiForRegistration` for the structural scans over `api/`.
  - **`builders.ts`** — `makeGroupRule`, `makeRulePageRef`, `makeActor`, `makeSite`,
    `makeStorageTarget`, `makeIndexablePage`, `stubSelect`.
  - **`migrationFixtures.ts`** — `iterate`, `stubSourceConnector`, `makeSourcePageRow`,
    `makeStagedPage`, `LEGACY_SCHEMA_DDL`.
  - **`sourceFiles.ts`** — `listSourceFiles(root, { ext, skip, skipDirs })`, the one recursive
    source-tree walker for a structural scanner.
- **A route test boots through `buildTestApp`, and it installs the REAL production pieces.** The
  handler is `helpers/errorHandler.ts#apiErrorHandler`, the permission gate is
  `core/http/authHooks.ts#permissionPreHandler` (API-key branch included — the six hand-written
  replicas had all dropped it), and `schemas: 'all'` is `api/index.ts#registerAllSchemas`. This
  supersedes CLAUDE.md's A7 notes above that tell a suite to call `registerParamsSchemas(app)` and
  `app.addHook('preHandler', siteEnabledPreHandler)` in its own `buildApp`: `schemas: 'all'` covers
  the first, and a suite mounting one route plugin passes the hook itself only if it is testing the
  site-enabled behaviour.
- **Session seeding is the harness's own concern, not production's.** There is no
  `testSessionOnRequest` in `backend/`; a running server gets its session from a signed cookie.
  `session: 'header'` is the ONE convention that replaces the four the suites had grown —
  `x-test-session` (a whole session as JSON), `x-test-permissions` (a JSON array or a comma-separated
  list, promoted to `{ authenticated: true, permissions, groups: [] }`) and `x-test-api-key` (a whole
  `req.apiKey` as JSON). `session` also accepts a fixed object or a `(req) => session` function.
- **`createWikiStub` defaults `models` to `{}` on purpose.** An absent member throwing is coverage:
  `modules/storage/disk/storage.test.ts` relies on it to prove the module never reaches for a model
  it should not. A suite names exactly the methods its code path calls. `data.systemIds` defaults to
  an empty object (so a read answers `undefined` instead of throwing on `undefined.x`), and overrides
  are deep-merged — arrays, class instances and `mock.fn()`s replace wholesale rather than merging.
  The merge copies property DESCRIPTORS, so a stub may declare a GETTER
  (`get sites() { … }`) to steer what a route sees from a module-level variable per test — which
  `api/pages.test.ts` does for `features.collaborativeEditing`, and which a value-copying merge would
  silently freeze into one snapshot.
- **A hook a suite needs registered before its own routes is a one-line plugin wrapper, not an
  `app.addHook` after `buildTestApp` returns.** `onRoute` fires only for routes registered into the
  same encapsulation or below it, and a `preHandler` added after `ready()` is too late; wrapping
  (`async (instance) => { instance.addHook(…); await instance.register(routes) }`) is how
  `api/index`, `api/scheduler`, `api/analytics`, `api/navigation`, the nine `siteEnabledPreHandler`
  suites and `api/authentication`'s form-body/cookie apps all do it.
- **`session` also takes a FUNCTION,** which is how a suite keeps a per-test identity (`() => session`
  off a module variable), builds a fresh mutable session per request (`() => ({})`, which the
  password-reset routes write to), or does a per-request side effect and stays anonymous (return
  `undefined` — `api/sites`, `api/approvals`, `api/blocks` and `api/navigation` capture an
  `x-test-site-permissions` header that way, since `checkSiteAccess()` takes no `req`).
- **`test/*.test.ts` co-located with a harness module is the right home for its own coverage.** The
  section's "`test/` holds shared fixture code that is not itself a `*.test.ts`" sentence needs a
  clause: a harness module in `test/` gets its own co-located suite there, the same as any other
  source file (`test/fastify.ts` → `test/fastify.test.ts`, and five more).
- **`listApiRouteFiles` is recursive and treats a directory as one route resource.** A route file may
  be a directory holding an `index.ts` (which is what the large-route-file splits produce); the
  scanners see one entry per resource either way. `schemas/`, `*.test.ts` and the top-level `index.ts`
  are skipped. A scanner must use it rather than its own `readdirSync` filter, or a split route file
  silently drops out of the scan.
- **Deliberately NOT converted, and why.** `modules/search/*/search.test.ts`'s `fakePage`/`basePage`
  and `modules/search/shared.test.ts`'s `fakePage` keep their own local builders: their field VALUES
  differ per engine and tests assert on the exact indexed document, so pointing them all at
  `makeIndexablePage` would change what is asserted, not just where the fixture lives. Unifying them
  is TEST-F6's shared contract runner, not this task.

## Task A14 (helpers/common.ts split; core/http/server.ts; two search hand-offs)

- **`helpers/common.ts` is no longer the home of site resolution, locale routing or module props.**
  CLAUDE.md names `helpers/common.ts` in its `backend/` Layout bullet for `helpers/` and, more
  concretely, throughout the Permissions and Backend-patterns sections. Three sibling modules now
  own those clusters and CLAUDE.md should name them where it names `common.ts`:
  - `helpers/siteResolution.ts` — `resolveRequestSite`, `RequestSiteResolution`,
    `normalizeHostname`, `siteIdForHostname`, `siteForHostname`, `resolveSiteParam`,
    `guardSiteEnabled`, `siteEnabledPreHandler`, `SITE_DISABLED_MESSAGE`, `SITE_MISSING_MESSAGE`.
  - `helpers/localeRouting.ts` — `LocaleRoutingConfig`, `defaultLocale`, `assertLocaleActive`,
    `assertPathNotReservedLocale`, `matchLocaleCode`, `stripLocalePrefix`,
    `localePrefixRedirectTarget`, `localePrefixStripTarget`, `shouldPrefixLocale`,
    `localizedPagePath`.
  - `helpers/moduleProps.ts` — `ModuleProp`/`ModulePropDefinition`/`ModulePropDeclaration`,
    `parseModuleProps`, `SENSITIVE_CONFIG_MASK`, `mask`/`unmaskSensitiveConfig`.
  `common.ts` keeps the tree-path codec, `normalizePagePath`, `stripPageExtension`,
  `requestOrigin`, `isSameOriginWebSocketHandshake`, `isHashedAssetFilename`, the hash/uuid
  helpers, `durationToSeconds`, `replyWithFile`, `isUniqueViolation`, `escapeLikePattern`,
  `BCRYPT_ROUNDS`, `CustomError` and `rethrowAsBadRequest`. There is no re-export shim: an import
  of a moved symbol from `common.ts` is a type error, which is deliberate.
- **`core/http/server.ts` is the last piece of the `index.ts` split.** CLAUDE.md's `core/` bullet
  should list it alongside the other `core/http/*` modules: `createHttpApp()` builds the Fastify
  instance (options block, `gracefulServer` + its shutdown handlers, `sensible`/`compress`/
  `websocket`) and assigns `WIKI.app`/`WIKI.server`; `registerStaticAssets(app)` mounts the favicon,
  `/_assets/` and `/_blocks/`. `index.ts` is now purely the boot script — the `WIKI` literal,
  `preBoot`/`initHTTPServer`/`postBoot`, `app.listen()` and `WIKI.server.setReady()`.
- **`registerStaticAssets(app)` must stay between `registerSecurity(app)` and
  `registerSession(app)`.** Fastify registers plugins in call order, so that slot is behaviour. The
  comment above `initHTTPServer()` already says this about `register*` calls generally; it now also
  covers a static mount.
- **`helpers/timeout.ts#withTimeout` has eight callers, not seven.** Its own doc comment says
  "the seven places that hand-rolled this"; `models/search.ts#initActiveEngines` was the eighth and
  is now converted. (Left as-is by this task since the sentence is historical, but worth a pass if
  CLAUDE.md or that comment is ever revised.)
- **A `LIKE` filter is escaped with `helpers/common.ts#escapeLikePattern`, everywhere.**
  `modules/search/db/search.ts` carried a byte-identical private `escapeLikePrefix`; it is gone. A
  new prefix filter writes `` `${escapeLikePattern(value)}%` `` at the call site.
- **Doc-comment prose still points at `helpers/common.ts` for moved symbols.** Roughly twenty
  `helpers/common.ts#<symbol>` references in comments across `api/`, `controllers/`, `models/`,
  `mcp/` and `index.ts` now name the wrong file. They were deliberately left alone by this task
  (its concurrency rule limited edits in existing files to import specifier lines); a follow-up
  sweep should repoint them.

## Task A18 — the five long-model splits

- **`WIKI.models` gained seven members** (`renderQueue`, `userCredentials`, `login`, `approvalRules`,
  `approvalNotifications`, `assetServing`, `pageClassification`) and the `backend/` layout table's
  `models/` bullet, which describes `models/index.ts` as the aggregator, stays accurate — but the
  CLAUDE.md prose that names a specific model for a specific job does not:
  - **Server-side rendering is two models, not one.** `models/rendering.ts` is the post-process
    pipeline a save runs through (`postProcess`); `models/renderQueue.ts` is the headless-browser
    queue (`isAvailable`, `ensureCanRender`, `queuePage`, `drainQueue`). The sanitizer policy those
    share — the tag/attribute/style allowlists, `blockAllowances`, `sanitizeOptions`,
    `unwrapOrphanedChildBlocks` and the `RenderPermissions` type — is
    `helpers/htmlSanitizePolicy.ts`. Anywhere CLAUDE.md says "rendering" for the queue half (it does
    not today, but `docs/` and several source doc comments did) should say `renderQueue`.
  - **`WIKI.models.users` no longer holds login.** `login`/`register`/`loginTFA`/`forgotPassword`/
    `resetPassword`/`loginWithProvider`/`afterLoginChecks`/`getLogoutRedirect` are
    `WIKI.models.login`; passwords, 2FA, recovery codes and the `userKeys` token pair
    (`generateToken`/`validateToken`/`destroyToken`/`purgeExpiredKeys`) are
    `WIKI.models.userCredentials`; `users` keeps the account itself (CRUD, profile, avatar, groups,
    `updateSession`).
  - **`api/approvals.ts` no longer rebuilds a reviewer scope.** `approvals.reviewerScopeFor(req,
    siteId, page?)` is the one place that shape is built. Rules, their cache and everything answered
    from them — `matchesPage`, `reviewerGroupIdsForPage` — are `WIKI.models.approvalRules`; the mail
    is `WIKI.models.approvalNotifications`.
- **`verifyTfaCode` returns `false` for an account deleted mid-verification.** Not new behaviour
  introduced here — it falls out of task A10's `patchStrategyAuth` extraction, which re-reads the
  row inside the per-user advisory lock and declines the write when there is no row — but it was
  never written down, and it is the difference between "the code was wrong" and "the account went".
  Pinned by `models/userCredentials.tfa.test.ts`'s "declines a code for a user that vanished between
  the read and the write". If CLAUDE.md ever describes the 2FA path, this is the sentence: a correct
  code for a vanished account is refused, not accepted.
- **`helpers/pagination.ts#paginate`'s `total` column alias is load-bearing.** Now stated in the
  helper's own doc comment: `paginate` reads `totals[0]?.total`, so a count query that aliases the
  column anything else silently paginates as `total: 0`.
- **Test files: a model's suite is now `<model>.<subject>.test.ts`, and DB-backed vs. pure is a
  filename property.** `models/users.test.ts` is pure; `models/users.crud.test.ts` and
  `models/users.profile.test.ts` are DB-backed, and each carries exactly one file-level
  `setupTestDb()` shared by its describes rather than one per describe. The "Testing (backend)"
  section's co-location rule is unchanged (a test still lives next to what it covers) — what is new
  is that one source file's tests may be several sibling files, split by subject, and that a
  DB-backed file opens one schema for the whole file. Worth a sentence next to the `test/db.ts`
  paragraph.
- **Doc-comment prose repointed, with two deliberate gaps.** `controllers/render.ts` (2 references
  to `models/rendering.ts` navigating the headless browser, now `models/renderQueue.ts`) was left
  alone to stay out of task A16's declared workspace; so was `migration/`'s. Both need a follow-up
  sweep.
