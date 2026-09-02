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
    into `.select()` returns a postgres-format *string* rather than a `Date`.
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
    takes an importer *closure*, so `models/storage.ts`'s `../modules/storage/${key}/storage.ts`,
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
