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
