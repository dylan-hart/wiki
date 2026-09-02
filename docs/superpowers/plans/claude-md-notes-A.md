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
