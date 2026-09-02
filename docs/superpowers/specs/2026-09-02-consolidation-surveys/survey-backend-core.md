# Backend core survey (`core/`, `helpers/`, `modules/`, `tasks/`, `mcp/`, `migration/`, `index.ts`, `worker.ts`)

All paths relative to `backend/` in the worktree. Line numbers are from the current `scarlett` head
(`e19aaa72`). Every finding below was verified by reading the cited lines; grep commands are quoted
where a dead-code claim rests on them.

## Summary

- **The single biggest win is a whole orphaned directory: `backend/importer/` (5 files, 1,465 LOC +
  1,497 test LOC) has zero importers anywhere outside itself.** It is the 2026-08-18 first iteration of
  the 2.5.x asset/comment importer, superseded by `migration/importers/asset-import.ts` /
  `comment-import.ts` in the 2026-09-01 reset (`4eb5ccc8`). Delete outright (F1).
- The same reset left ~700 LOC of dead batch-mode entry points, an unused `IdMap` class, an unreachable
  multi-source conflict policy and a byte-identical duplicated `locationKey` inside `migration/` (F2),
  plus ~1,000 lines of comments narrating code that no longer exists (F14).
- `modules/storage/`'s s3/azure/gcs are one module written three times (`keyFor`, `withXErrors`, the
  activation cache, `exportAll`, four handler prologues byte-identical modulo a noun) — a ~275 LOC
  factory extraction (F3). `sftp` carries a *divergent* private copy of `helpers/blobTarget.ts`
  (1000-based units, `>` instead of `>=`) — a real semantic split, not just duplication (F4).
- `modules/search/` azure-search and aws-cloudsearch share ~200 byte-identical lines (`diff`-verified)
  and all four external engines repeat the same `checkAccess` filter / `SCAN_CAP` / result tail /
  never-throws wrapper. ~530 LOC net across five engines, in phases (F5), plus three CLAUDE.md-banned
  "old data may still contain X" fallbacks (F6).
- Small but certain dead code: `helpers/redirect.ts` is entirely superseded by
  `helpers/redirectTarget.ts` (F7); `createDeferred` re-implements `Promise.withResolvers` (F8);
  `index.ts` registers two `unhandledRejection` handlers of which the second (`processGuards.ts`) can
  never run (F9); `siteRules.ts#rulesAllowSite` has no caller.
- Seven hand-rolled `Promise.race`-against-a-timer blocks want one `withTimeout` helper (F10).
- `helpers/common.ts` says `defaultLocale()` is "the single source for three copies" — six more copies
  exist, and the hostname→site lookup it also centralises is re-derived at five sites, one of them
  (`api/diagrams.ts:53`) missing the `normalizeHostname` the helper exists to enforce (F11).
- `index.ts` (1,208 lines) and `helpers/common.ts` (807, 44% comment) are the two long-file splits
  worth doing; `core/scheduler.ts`, `core/db.ts`, `core/collab.ts` are long but coherent — leave.
- Realistic net: **~5,000 LOC removed** (≈2,960 importer/, ≈700 migration dead, ≈275 storage, ≈530
  search, ≈200 helpers/core/mcp) before any comment trimming.

## Existing shared utilities worth knowing (reuse, don't re-create)

| Helper | Where | Already re-implemented at |
| --- | --- | --- |
| `defaultLocale(siteId)` | `helpers/common.ts:381` | see F11 |
| `normalizeHostname()` + `resolveRequestSite()` | `helpers/common.ts:313`, `:241` | `index.ts:944,1102`, `api/diagrams.ts:53`, `models/sites.ts:131` |
| `guardSiteEnabled()` / `siteEnabledPreHandler` | `helpers/common.ts:317`, `:352` | `mcp/site.ts:34-44` (adapted to throw — legitimate) |
| `stripLocalePrefix` / `matchLocaleCode` / `localizedPagePath` / `shouldPrefixLocale` | `helpers/common.ts:392-526` | none — good |
| `normalizePagePath`, `generatePathHash`, `isValidUuid`, `durationToSeconds` | `helpers/common.ts` | none — good |
| `parseModuleProps` / `maskSensitiveConfig` / `unmaskSensitiveConfig` | `helpers/common.ts:675-753` | used by all 5 module-kind models — good |
| `isFollowableRedirectTarget` / `absoluteRedirectsAllowed` | `helpers/redirectTarget.ts:45,84` | `helpers/redirect.ts` is the dead predecessor (F7) |
| `isSameOriginHeader` | `helpers/security.ts:76` | `isSameOriginWebSocketHandshake` (`common.ts:186-201`) repeats its first 15 lines before adding the site-hostnames loop |
| `parseLargeThreshold` / `objectKeyFor` / `belongsInTarget` | `helpers/blobTarget.ts` | `modules/storage/sftp/assets.ts:96-160` (F4) |
| `CONTENT_TYPE_EXTENSIONS` / `extensionForContentType` | `helpers/pageSerialization.ts:18-24` | `models/storage.ts:20-24`, `modules/storage/disk/storage.ts:26-34`, `modules/storage/git/content.ts:28` |
| `withAdvisoryLock` / `acquireAdvisoryLock` | `helpers/advisoryLock.ts` | none — good |
| `createNotifier` / `connectListener` / `createListenerPool` | `helpers/pubsub.ts` | used identically by `core/db.ts:443`, `core/scheduler.ts:196`, `core/collab.ts:307` — good |
| `runWithJobExecutionContext` | `helpers/jobExecutionContext.ts` | none |
| `withRenderTimeout` (private) | `models/rendering.ts:53` | the shape F10 should generalise |
| `chunk`, `pick`, `isPlainObject`, `escapeRegExp` | `es-toolkit/*` | `migration/mappers/{storage,authentication,site-settings}.ts` hand-roll `pick` + `isPlainObject` (F2/F14) |
| `Promise.withResolvers()` | Node ≥22 (repo requires 26) | `helpers/common.ts:28-64 createDeferred` (F8) |
| `AbortSignal.timeout()` | Node | already used in `check-version.ts:11` and `scheduler.ts:370` |

## Findings

### F1. Delete `backend/importer/` — the orphaned first-generation 2.5.x importer  — dead code | net LOC −2,962 (−1,465 src, −1,497 test) | risk low | effort S

- Locations: `importer/assets.ts` (317), `importer/assetBatch.ts` (165), `importer/assetFolders.ts`
  (185), `importer/comments.ts` (308), `importer/runSummary.ts` (490) + five `*.test.ts` +
  `assetFolders.integration.test.ts`, `runSummary.integration.test.ts`.
- What's wrong: nothing outside the directory imports it. Grep run:
  ```
  grep -rn "importer/" --include='*.ts' --exclude-dir=node_modules . | grep -v "^importer/" | grep -v '\.test\.ts'
  core/db.ts:165:   * call chain and `importer/assets.ts`'s batch runner for the worked example.   (comment)
  models/assets.ts:184: * Exported so the migration importer (`backend/importer/assets.ts`) can ...  (comment)
  ```
  Both hits are prose. `package.json` scripts reference only `tasks/migrate.ts` /
  `tasks/verify-migration.ts`, which import `migration/*`, never `importer/*`. `git log` shows the
  directory was created 2026-08-18 (`b737e1a6` "asset binary + metadata writer for the importer (Task
  747)", `bfdd06cf` "unified run summary for assets/comments importer") and last touched 2026-08-23;
  `migration/importers/asset-import.ts` and `comment-import.ts` were added by the 2026-09-01 reset
  (`4eb5ccc8`) and cover the same ground (asset bytes+metadata, comment staging) through the
  `migration/phases/assets.ts` pipeline. `importer/comments.ts:1-20` still says "3.0 has no `comments`
  table yet" — `models/comments.ts` exists and `migration/importers/comment-import.ts:10-20` writes to
  it.
- Proposed target shape: `rm -r backend/importer`. Then in `models/assets.ts:184` drop the "exported for
  the importer" note on `sanitizeFileName`/`kindOf` (both still have real callers:
  `modules/storage/disk/storage.ts`, `modules/storage/git/sync.ts`), and reword `core/db.ts:161-166`'s
  `WikiDbOrTx` example to point at `models/tree.ts`'s `addAsset` alone.
- Test coverage: none needed — nothing exercises it except its own tests, which go with it. Run
  `npm run typecheck` afterwards to confirm no `import type` dangles.

### F2. `migration/`: dead batch-mode wrappers, unused `IdMap`, unreachable mapper machinery left by the reset  — dead code | net LOC −700 src / −600 test | risk low (1f: med) | effort M

Verified by the migration sub-survey; every item has zero non-test importers under
`grep -rn "<symbol>" migration --include="*.ts" | grep -v "\.test\.ts:"`.

- **1a** `path-normalization.ts:182-279` `assignTreePaths` + `PathAssignmentResult/Failure/FailureReason`
  (`:69-91`) + private `locationKey` (`:172-174`): only callers are `path-normalization.test.ts`. The
  streaming rewrite in `page-import.ts:447-620` replaced it. −125.
- **1b** `content-staging.ts:162,383-412` `ContentStagingIndex.locations` — built for every page,
  read only by the dead `assignTreePaths` and one test assert. −8 (and a per-corpus memory cost).
- **1c** `content-staging.ts:401-410,448` `siblingsByOldId` / `StagedPage.localeSiblingOldIds`, plus
  `StagedPage.hash` (`:107`), `sourceAuthorId`/`sourceCreatorId` (`:128-129`, doc at `:126-127` admits
  "not consumed by any write path"). −25.
- **1d** Batch wrappers around per-record engines, all test-only: `page-import.ts:621-636 importPages`,
  `importers/asset-import.ts:219-232 importAssets`, `importers/comment-import.ts:148-168 importComments`,
  `importers/users-groups.ts:953-985 importUsersAndGroups`, `page-history-import.ts:456-463`'s `pages`
  loop (`phases/content.ts:302` always passes `pages: []`). With their result types
  (`PageImportResult`, `AssetImportResult`, `CommentImportResult`, `UsersGroupsImportResult/Input`) and
  `stubConvertGroup`/`stubConvertUser` (`users-groups.ts:230-239`). −150 src, −250 test.
- **1e** `id-map.ts:22-24,33-39,45-47` `IdMap.has/resolve/entries` — production calls only `.set()`
  (`page-import.ts:575`) and `.get()` (`page-history-import.ts:457`, `navigation-import.ts:314`,
  `comment-import.ts:111`); `context.ts:79` already uses a plain `Map<number,string>` for
  `userIdMap` beside `IdMap` for `pageIdMap` (`:85`). Delete the class, keep `UserIdMap` +
  `resolveActorId`. −50.
- **1f** `mappers/authentication.ts:311-333,433-446` `AuthenticationMapperState`, `ConflictPolicy`
  `'first-source-wins'`, `disambiguateDisplayName`, `remapAutoEnrollGroups` (`:205-226,379`) — the only
  production call is `phases/settings.ts:138 mapAuthenticationRows(authRows, { resolver })`, no
  state/policy/groupIdMap ever; `settings.ts:187-198` handles a `'conflict-skipped'` outcome it
  documents as "not selected here". Also `AuthenticationMappingResult.createdRows`,
  `StorageMappingResult.updates` (`storage.ts:314,447-453`), `Known3_0StorageModule` (`storage.ts:160`),
  `strategyMapping` (`users-groups.ts:425,473,496`). −85 src, ~−120 test. **Decision needed**: this is
  a deliberate multi-source-consolidation capability; delete only if multi-source import is off the
  roadmap.
- **1g** `phases/define-phase.ts:122,167 staticUnmappable` ("no phase currently supplies one"),
  `report.ts:28 'no-destination-table'` ("No phase currently emits this reason"),
  `page-import.ts:457-458 PageImporter.failed/.warnings` (only `.succeeded` is read,
  `phases/content.ts:287`). −20.
- **Duplicate + false comment**: `page-import.ts:425-426 streamedLocationKey` is byte-identical to
  `path-normalization.ts:172-173 locationKey`; the comment at `page-import.ts:421-424` claims one is
  "` `-joined rather than space-joined" — both are a single ASCII space. Goes with 1a.
- Test coverage: `path-normalization.test.ts:61-242`, `content-staging.test.ts:281-285,493`,
  `mappers/authentication.test.ts` (conflict-policy cases), `id-map.test.ts` all test *only* the dead
  code and are deleted with it; the live paths are covered by `phases/*.integration.test.ts` and
  `page-import.test.ts` (807).

### F3. `modules/storage/{s3,azure,gcs}` → one `blobBase.ts` factory  — utility extraction | net LOC −275 | risk med | effort M

- Locations (identical modulo the SDK noun, all verified side-by-side):
  - `keyFor`: `s3/storage.ts:176-178` ≡ `azure/storage.ts:96-98` ≡ `gcs/storage.ts:108-110` —
    byte-identical bodies (`objectKeyFor({ siteId: target.siteId, folderPath, fileName })`).
  - `withS3Errors`/`withAzureErrors`/`withGcsErrors`: `s3:191-197` ≡ `azure:101-107` ≡ `gcs:113-119`
    — identical except the identifier.
  - activation cache + `getClient`: `s3:155-173`, `azure:74-93`, `gcs:86-105` — same
    `JSON.stringify(config)` cache key, same hit path, same failed-activation eviction (the comment
    "A failed activation is not remembered as done" is verbatim in all three); differs only in what is
    built (`S3Client`/`ContainerClient`/`Bucket`).
  - `exportAll`: `s3:274-299`, `azure:175-195`, `gcs:169-189` — same `streamAll` → `belongsInTarget`
    → `keyFor` → `withXErrors(put)` → counter → log line; differs in the SDK put call and the trailing
    noun.
  - `assetUploaded` prologue (`s3:200-208`/`azure:124-132`/`gcs:122-130`, comment included),
    `assetDeleted` key line, `assetRenamed` key pair (`s3:247-248`/`azure:155-156`/`gcs:153-154`),
    `getDirectUrl` prologue, and `DIRECT_ACCESS_TTL_SECONDS` declared three times (`s3:33`, `azure:27`,
    `gcs:24`).
- Proposed target shape — a factory, not an abstract class, since these are object modules:
  ```ts
  // modules/storage/blobBase.ts
  export interface BlobDriver<C> {
    label: string                                         // 'S3' | 'Azure Blob Storage' | 'GCS'
    build(config): C | Promise<C>                         // buildClient + ensureBucket/Container
    put(c: C, key, body: Buffer, mimeType, config): Promise<void>
    remove(c: C, key): Promise<void>
    copy(c: C, from, to, config): Promise<void>
    sign(c: C, key, ttlSeconds): Promise<string>
  }
  export function blobStorageModule<C>(driver: BlobDriver<C>): StorageModule
  ```
  hoisting `keyFor`, `withErrors`, the `activated` map, the five handlers and the TTL constant. Each
  module keeps its SDK imports, `buildClient`, `ensureBucket`, and the five driver callbacks.
- Also noted: 12 impossible-shape fallbacks in these three (`data.fileName ?? content.fileName`,
  `data.folderPath ?? ''`, `data.previousFileName ?? data.fileName` at `s3:208,225,247-248`,
  `azure:132,145,155-156`, `gcs:130,146,153-154`) — every dispatch payload from
  `models/assets.ts:379-387,478-486,1147-1155,1186-1193,1232-1239` always carries all three fields, and
  `git/content.ts:299` handles the same event with no fallback. CLAUDE.md's "no fallback for a case
  that cannot occur" applies; drop them while hoisting.
- Test coverage: `s3/storage.test.ts` (515), `azure/storage.test.ts` (338), `gcs/storage.test.ts` (345)
  import `keyFor`/`buildClient`/`ensureBucket`/etc. by name — 12 `keyFor` references must be repointed.
  `s3/storage.emulated.test.ts` (247, real `s3rver`) and `s3/storage.pathstyle.test.ts` (64) are the
  behavioural nets that would catch a real regression.

### F4. `modules/storage/sftp/assets.ts` re-implements `helpers/blobTarget.ts` with different semantics  — utility extraction | net LOC −55 | risk med (behaviour converges on the rest of the codebase) | effort S

- Locations: `sftp/assets.ts:96-160` (`SIZE_UNIT_MULTIPLIERS`, `parseSizeToBytes`,
  `ASSET_KIND_CONTENT_TYPES`, `contentTypeBucketForAsset`, `ASSET_CONTENT_TYPES`) vs
  `helpers/blobTarget.ts:18-24,77-81,106` (`parseLargeThreshold`, `KIND_TO_CATEGORY`,
  `belongsInTarget`).
- What differs: sftp uses 1000-based units (`assets.ts:101-107`) where `blobTarget.ts:18-24` uses 1024;
  sftp tests `fileSize > threshold` (`assets.ts:153`) where `blobTarget.ts:106` tests `>=`. So a
  5,000,000-byte file on a `5MB` target is "large" for sftp and not for `models/storage.ts:860-865`,
  s3, azure or gcs. `blobTarget.ts:31-36` calls itself "The single parser every caller of
  `largeThreshold` shares (OpenProject #927)"; sftp never joined. The justifying comment at
  `sftp/assets.ts:130-134` ("No such mapping exists anywhere else in the codebase to reuse … `disk`
  holds only a `definition.yml`") is stale on both counts.
- Proposed target shape: delete `assets.ts:96-160`; replace `assets.ts:200,211-214` with
  `if (!belongsInTarget(asset, target.contentTypes)) continue`.
- Test coverage: `sftp/assets.test.ts:85-130` pins the divergent semantics and must be rewritten or
  dropped (`helpers/blobTarget.test.ts` already covers the canonical behaviour);
  `sftp/integration.test.ts` (315, real `ssh2` server) covers `exportAll` end to end.

### F5. `modules/search/`: azure/aws byte-identical blocks + four-engine boilerplate → `search/shared.ts` + `externalBase.ts`  — utility extraction | net LOC −530 (phased: −90 / −100 / −130 / −130 / −15) | risk low→med-high by phase | effort L

- `diff`-verified identical ranges: `azure-search/search.ts:141-161` ≡ `aws-cloudsearch/search.ts:734-754`
  (`defaultPageSource`), `azure:115-128` ≡ `aws:709-722` (`RebuildPageSource`), `azure:502-504` ≡
  `aws:880-882` (`configFor`), `azure:280-286` ≡ `aws:616-622` ≡ `db/search.ts:97-103` (`escapeHtml`,
  three copies — `azure:279` and `aws:615` say "copied rather than imported: each engine module stays
  self-contained", a doctrine to overturn). Near-identical: client caching `azure:469-489` vs
  `aws:847-867` (3 lines differ, all type names); rebuild locale loop `azure:852-871` vs `aws:1296-1315`
  (one line); `compareRows`, `normalizeHighlight`, `fetchAllIds`, `publishStateFilters`/`Clauses`.
- Algolia/elasticsearch: `algolia/search.ts:505-535` vs `elasticsearch/search.ts:526-556` rebuild
  block differs by one line; `batchDocuments` (`algolia:212-244`) vs `batchOperations`
  (`elasticsearch:236-263`) same algorithm with the same constants declared twice; `pageToDocument`
  differs by two lines.
- All four external engines repeat: the `checkAccess` visible-filter (`algolia:412-434`,
  `elasticsearch:444-458`, `azure:709-723`, `aws:1155-1169`), `SCAN_CAP = 500` declared four times
  (`algolia:35`, `es:39`, `azure:57`, `aws:591`), the `{ results, totalHits, totalHitsApproximate,
  suggestion: null }` tail (`algolia:458-472`, `es:479-493`, `azure:738-751`, `aws:1184-1196`), the
  never-throws `indexPage` wrapper (`algolia:348-355`, `es:370-382`, `azure:533-542`, `aws:955-963`),
  and four 3-line `created/updated/deleted/renamed` forwarders each.
- Why aws (1,340) and azure (888) are 2×: a two-query `hideProtectedContent` split-and-merge
  (`azure:775-812`, `aws:1221-1252`) the other two skip by omitting `content` at index time; a
  ghost-document purge (`fetchAllIds` + diff + delete) that algolia/ES get from a one-line `deleteBy`;
  ~150 lines of injected client-interface/factory/`RebuildPageSource` test seams each; and aws's 117
  lines (`aws:230-346`) of hand-written translation between its own `CloudSearchFieldSpec` shape and the
  SDK's per-type option objects — declare the field list in the SDK's own shape and ~60 of those go.
- Proposed target shape: `modules/search/shared.ts` (pure functions: `escapeHtml`, `normalizeMarkers`,
  `SCAN_CAP`, `filterVisible`, `toSearchPagesResult`, `batchBySize`, `buildSearchDocument`,
  `publishStateConditions`, `pageStream` replacing `RebuildPageSource`+the keyset loops) and
  `modules/search/externalBase.ts` (`abstract class ExternalSearchModule<TClient> implements
  SearchModule` with `clientFor`/`configFor`/the four forwarders/`safeWrite`/`safeRemove`). `db`
  stays on the bare `SearchModule` interface (`models/search.ts:241-264`) and imports only the pure
  helpers.
- Also: `getEngineConfig` vs direct `WIKI.sites[...].config.search.engines[...]` — two config-read
  paths (`algolia:306`/`es:332` vs `azure:502-504`/`aws:880-882`), the latter re-applying
  `definition.yml` defaults by hand at every use site (`azure:518`, `aws:898,762`). Unify on
  `getEngineConfig` after confirming `index.ts:279→283` ordering (it does call `refreshFromDisk()`
  before `initActiveEngines()`).
- Test coverage: 3,860 module test LOC — `db/search.test.ts` (722, DB-gated), `algolia` (733),
  `elasticsearch` (846 + 272 smoke), `azure-search` (985), `aws-cloudsearch` (1,296) — every function
  proposed for hoisting has direct unit coverage. The `filterVisible`/`totalHits` step is the
  OpenProject #2151/#2156 count-oracle fix: do it last, with `db/search.test.ts:266,629` untouched.

### F6. Search engines carry three CLAUDE.md-banned "old data" fallbacks  — dead code | net LOC −60 src / −65 test | risk low | effort S

- `aws-cloudsearch/search.ts:1046-1069 hasUnbackfilledDocuments()` + gate at `:1317-1320` + doc at
  `:1276-1287`: detects documents "indexed before this module started stamping documents with their
  site (OpenProject #2108)" and skips the purge until a clean pass. Textbook "old data may still
  contain X". Its two test blocks (`aws-cloudsearch/search.test.ts:1228`…) go with it.
- `algolia:154-157` and `elasticsearch:140-143`:
  `page.updatedAt instanceof Date ? page.updatedAt.toISOString() : (page.updatedAt as unknown as string)`
  — `SearchIndexablePage` is `typeof pagesTable.$inferSelect` (`models/search.ts:229`) and `updatedAt`
  is a `timestamp` column (`db/schema.ts:90`), always a `Date`; `azure:270` and `aws:392` call
  `.toTemporalInstant()` unguarded and compile. Unify on the Temporal form.
- `db/search.ts:167,411,421,514,523` `rows.rows ?? rows` — five sites probing whether `db.execute()`
  returned an envelope. Check drizzle's return type once, then delete the dead branch.
- (Legitimate, keep: `classification ?? null` at `algolia:422-426` etc. guards a *third-party index*
  that was never rebuilt — not this fork's own data. Just drop the four identical 4-line comments.)

### F7. `helpers/redirect.ts` is dead — superseded by `helpers/redirectTarget.ts`  — dead code | net LOC −118 | risk low | effort S

- Locations: `helpers/redirect.ts` (46 lines, one export `isFollowableRedirect`) +
  `helpers/redirect.test.ts` (72).
- Grep:
  ```
  grep -rn "helpers/redirect.ts\|isFollowableRedirect\b" --include='*.ts' --exclude-dir=node_modules . | grep -v '\.test\.ts'
  helpers/redirect.ts:34:export function isFollowableRedirect(...)
  ```
  Every former caller the header comment names (`api/groups.ts:2,314`, `api/authentication.ts:5,158,1107`,
  `api/sites.ts:5,683`, `models/navigation.ts:9,198`) now imports `isFollowableRedirectTarget` /
  `absoluteRedirectsAllowed` from `redirectTarget.ts`. `redirectTarget.ts:77` even references its
  predecessor's option naming in the past tense.
- Proposed: delete both files.
- Test coverage: `helpers/redirectTarget.test.ts` (89) covers the live function.

### F8. `createDeferred` re-implements `Promise.withResolvers()`  — dead code | net LOC −56 | risk low | effort S

- Locations: `helpers/common.ts:9-13` (`Deferred<T>`), `:27-64` (`createDeferred`, incl. a
  `/* eslint-disable promise/param-names */` for a linter this repo doesn't use). Callers:
  `core/scheduler.ts:8,277` (`const jobDefer = createDeferred()` → `.promise/.resolve/.reject` pushed
  into `CompletionPromise`, whose fields are typed off `Deferred` at `:82-84`) and `core/db.ts:14,207`
  (`onReady: createDeferred()`).
- What's wrong: the 37-line body exists to let `resolve`/`reject` be called before `promise` is
  read — which a native promise's resolver functions already do. Node 26 has
  `Promise.withResolvers<T>()` returning the identical `{ promise, resolve, reject }` shape.
- Proposed: replace both call sites with `Promise.withResolvers<void>()`, type `CompletionPromise`'s
  fields as `PromiseWithResolvers<void>['resolve']` etc., delete the helper and interface.
- Test coverage: `common.test.ts` has no `createDeferred` test; `core/scheduler.test.ts` (1,682)
  covers `addJob({ promise: true })` resolution and `expireCompletionPromises`; `core/db.test.ts` covers
  `onReady` indirectly.

### F9. `index.ts` registers two `unhandledRejection` handlers; the shared one can never run  — dead code | net LOC −20 (or −9) | risk low | effort S

- Locations: `index.ts:180-188` — an inline `process.on('unhandledRejection', …)` that logs (via
  `WIKI.logger` if set, else `console.error`) and calls `process.exit(1)`; `index.ts:200` —
  `registerUnhandledRejectionHandler(WIKI.logger, { debug })` from `core/processGuards.ts:47-66`, which
  only logs.
- What's wrong: Node runs listeners in registration order, and the inline one exits the process
  synchronously, so the `processGuards` listener (and its `debug` stack dump) never executes. Two
  handlers, two doc comments (`index.ts:173-179` and `processGuards.ts:36-46`) each describing itself as
  the fix for the same gap.
- Proposed: keep exactly one. Either delete `index.ts:173-188` and give `registerUnhandledRejectionHandler`
  an `exit` option like its sibling `runBootPhaseOrExit` already has (`processGuards.ts:29`), or delete
  `registerUnhandledRejectionHandler` + `processGuards.test.ts`'s cases for it and keep the inline
  handler. The first is cleaner (tested, injectable).
- Test coverage: `core/processGuards.test.ts` (138) covers the helper with a stand-in emitter.

### F10. Seven hand-rolled "race against a timer" blocks → `helpers/timeout.ts#withTimeout`  — utility extraction | net LOC −55 | risk low | effort S

- Locations: `core/scheduler.ts:362-385` (`executeOnWorker`), `:534-561` (`executeInProcess`),
  `:905-921` (`drainInFlightJobs`); `models/rendering.ts:53-68` (`withRenderTimeout`, already the
  generic shape); `models/diagramRender.ts:392-408` (private `withTimeout(work, ms, errorName,
  message)` — literally the helper, as a class method); `models/search.ts:609-621`
  (`initActiveEngines`); `models/pdfExport.ts:~245-265`.
- Identical in all seven: `let timer; const expiry = new Promise<never>((_, reject) => { timer =
  setTimeout(() => reject(new …(msg)), ms) }); try { await Promise.race([work, expiry]) } finally {
  clearTimeout(timer) }`. Differs: the error constructor (`Error` vs `CustomError(name, msg, 504)`),
  and `drainInFlightJobs` resolves instead of rejecting and `unref()`s the timer.
- Proposed target shape:
  ```ts
  export function withTimeout<T>(work: Promise<T>, ms: number, onExpire: () => Error, opts?: { unref?: boolean }): Promise<T>
  ```
  `diagramRender.ts`'s method becomes a one-line call; `withRenderTimeout` becomes
  `withTimeout(work, RENDER_TIMEOUT, () => new CustomError('renderTimeout', …, 504))`.
- Test coverage: `core/scheduler.test.ts` covers both scheduler timeouts and the drain bound;
  `models/rendering.test.ts`, `models/diagramRender.test.ts`, `models/search.test.ts` cover theirs.

### F11. "Single source" helpers in `common.ts` that are not the single source  — utility extraction | net LOC −15 (+1 latent bug fixed) | risk low | effort S

- `defaultLocale(siteId)` (`helpers/common.ts:381`, doc: "The single source for what used to be three
  separately-maintained copies") — the same `WIKI.sites[id]?.config?.locales?.primary ?? 'en'` is
  re-derived at `mcp/site.ts:22-24` (`defaultLocale(site)`, used by `mcp/tools/listNavigation.ts:45`,
  `createPage.ts:83`, `listSites.ts:30,52`), `models/assets.ts:594`, `api/assets.ts:160`,
  `modules/storage/git/sync.ts:326`, `migration/context.ts:133`, and (dead, F1) `importer/assets.ts:230,250`.
  `git/sync.ts:140`, `sftp/pages.ts:104`, `helpers/appShell.ts:59` operate on an already-fetched
  `locales` object — fine, but `sftp/pages.ts` also imports `defaultLocale` from common, so it does
  both.
- Hostname→site: `resolveRequestSite` (`common.ts:257`) and `models/sites.ts#getSiteByHostname`
  (`:131-132`) both compute `sitesMappings[normalizeHostname(h)] || sitesMappings['*']`; so do
  `index.ts:944` (SEO hook) and `index.ts:1102` (app-shell fallback) inline; `api/diagrams.ts:53` does
  `WIKI.sitesMappings[req.hostname] || WIKI.sitesMappings['*']` **without** `normalizeHostname` — the
  exact case-sensitivity defect `normalizeHostname`'s doc (`common.ts:294-315`, OpenProject #2127) says
  "every lookup routes through this rather than each call site lowercasing for itself" to prevent.
  `api/authentication.ts:1086` has a third variant with `?? ''`.
- Proposed: add `siteIdForHostname(hostname): string | undefined` next to `normalizeHostname` and make
  the five sites call it; make `mcp/site.ts`'s three callers use `common.ts#defaultLocale(site.id)` and
  delete `mcp/site.ts:21-24`. Flag the `api/diagrams.ts:53` change as a (correct) behaviour change in
  the commit message.
- Test coverage: `helpers/common.test.ts` (882) covers `resolveRequestSite`/`normalizeHostname`;
  `mcp/site.test.ts` (129).

### F12. Split `index.ts` (1,208 lines) into `core/http/*`  — long-file split | net LOC ≈ −40 (dead comments + three duplicated fragments) | risk low | effort M

`initHTTPServer()` alone is lines 309-1177. It registers ~12 plugins and ~9 hooks with no seam between
"boot sequence" and "HTTP wiring". Proposed split by responsibility, each a `FastifyPluginAsync` or
a plain `register(app)` function, keeping `index.ts` as the ~250-line boot script
(`WIKI` literal, `preBoot`, `postBoot`, the three-phase sequence at `:1196-1208`):

| New file | From `index.ts` | Notes |
| --- | --- | --- |
| `core/http/security.ts` | `:470-527` (CSP parse + inline-script hashes, helmet, cors) | `helpers/security.ts` already holds the pure parts |
| `core/http/session.ts` | `:569-667` (auth secret assert, cookie, session, cookie diagnostic hook) | the `store` adapter at `:631-653` is three identical `try { clb(null, await …) } catch (err) { clb(err, null) }` wrappers — collapse to one `callbackify(fn)` or move onto `models/sessions.ts` as `sessionStoreAdapter()` |
| `core/http/openapi.ts` | `:673-769` (swagger + swagger-ui) | the `transform` at `:686-720` is a pure `(schema, route) => schema` — put it in the existing `helpers/openapi.ts` beside `OPENAPI_SECURITY` |
| `core/http/authHooks.ts` | `:771-929` (bearer, same-origin, two rate limits, permissions preHandler, site pin) | the permission `preHandler` at `:886-918` is the one hook worth a unit test of its own |
| `core/http/siteRouting.ts` | `:70-131` (`RESERVED_ROOT_FILES`, `SERVER_ROUTE_SEGMENTS`, `isPageUrl`, exempt set) + `:931-1031` (SEO hook, site-resolution hook) + `:1058-1122` (app-shell not-found handler) | the trailing-slash trim at `:939` and `:997` is the same expression twice; the hostname lookup at `:944` and `:1102` is F11 |
| `core/http/errors.ts` | `:1128-1152` | `helpers/errorHandler.ts` already owns the non-API branch (`sendNonApiError`); move the API branch beside it as `sendApiError` so `setErrorHandler` is two lines |
| `core/http/routes.ts` | `:1037-1056` | the 12 `app.register(import(...))` lines |
| delete | `:314-316`, `:474`, `:483` (`// WIKI.auth = auth.init()` etc.), `:1183-1190` (commented-out `WIKI.kernel.shutdown()` SIGINT handler), `core/db.ts:23` (`// import migrationSource`) | dead commented-out code from 2.x |

- Test coverage: nothing unit-tests `index.ts` today (it boots the process). `e2e/` and
  `api/index.test.ts` (which exercises `siteEnabledPreHandler` with synthetic req/reply) are the nets.
  Extracting the permission hook and swagger transform as pure functions makes both testable for the
  first time.

### F13. Split `helpers/common.ts` (807 lines, 358 comment) by topic  — long-file split | net LOC 0 | risk low | effort S

Four unrelated clusters share one file whose name says nothing:
- **Site resolution & guards** `:213-362` (`RequestSiteResolution`, `resolveRequestSite`,
  `SITE_DISABLED_MESSAGE`, `normalizeHostname`, `guardSiteEnabled`, `siteEnabledPreHandler`) →
  `helpers/siteResolution.ts` (add F11's `siteIdForHostname`). Note the doc comment at `:271-293`
  belongs to `guardSiteEnabled` but sits *above* `normalizeHostname`'s own comment — the two blocks
  were interleaved by a later insertion.
- **Locale routing** `:364-526` (`LocaleRoutingConfig`, `defaultLocale`, `matchLocaleCode`,
  `stripLocalePrefix`, `localePrefixRedirectTarget`, `localePrefixStripTarget`, `shouldPrefixLocale`,
  `localizedPagePath`) → `helpers/localeRouting.ts`. `helpers/appShell.ts` already imports only these.
- **Module props & sensitive masking** `:612-753` (`getTypeDefaultValue`, `ModuleProp*`,
  `parseModuleProps`, `SENSITIVE_CONFIG_MASK`, `mask/unmaskSensitiveConfig`) → `helpers/moduleProps.ts`;
  used by exactly the five module-kind models + `api/schemas/search.ts`. `getTypeDefaultValue` is
  exported with no external caller (`grep -rlw getTypeDefaultValue` → only `common.ts`) — un-export.
- **Everything else** stays: tree-path codec, `normalizePagePath`, `stripPageExtension`,
  `requestOrigin`, `isSameOriginWebSocketHandshake` (could call `security.ts#isSameOriginHeader` for its
  first branch, −8), `isHashedAssetFilename`, hashes/uuid, `durationToSeconds`, `replyWithFile`,
  `CustomError`, `rethrowAsBadRequest`.
- `shouldPrefixLocale` is exported but only used inside the file (+ test) — fine, it's the frontend
  mirror; leave.
- Test coverage: `common.test.ts` (882) splits along the same lines; imports in ~40 files need
  repointing (mechanical, typecheck-verified).

### F14. `migration/`: repeated shapes across phases/mappers/CLIs + comment archaeology  — utility extraction | net LOC −300 src, −900…−1,200 comment lines | risk low/med | effort M

Detailed in the migration sub-survey; the concrete duplicates:
- **Three `routeOutcome` functions**: `phases/users.ts:37-75`, `phases/content.ts:38-69`,
  `phases/assets.ts:43-53` — same three-way branch, same `recorder.create(id, async () => {})` no-op
  sentinel, and the reason for the sentinel (`trackWriteCapability`, `define-phase.ts:46-66`) is
  re-explained at `users.ts:57-64`, `content.ts:56-60`, `assets.ts:36-38`, `define-phase.ts:37-45`.
  One `phases/route.ts` + kill `trackWriteCapability` (the `not_implemented` reclassification at
  `define-phase.ts:152-158` is unreachable — `:142-151` concedes it). −85.
- **Four dry-run closures**: `phases/content.ts:186-196` (`createPage`), `phases/assets.ts:98-106`
  (`upload`), `:109-114` (`getFolder`), `:133-138` (`comments.create`) — same
  `if (ctx.dryRun) return placeholder; return WIKI.models.x.y(...)`. Two helpers in
  `phases/dry-run.ts`. −40.
- **Group/user importers are one generic**: `importers/users-groups.ts:734-770` vs `:799-838` differ
  only in `writer.insertGroup` vs `insertUser`, one message, and `providerFallbacks`. −55.
- **Mapper triplicates**: `pick` (`authentication.ts:237-245`, `storage.ts:172-180`,
  `site-settings.ts:84-92`), `isPlainObject` byte-identical ×3 (`:247-249`, `:182-184`, `:78-80`),
  `transformConfig` byte-identical ×2 (`:294-298`, `:260-264`), the `{v:…}` knex unwrapper ×2
  (`authentication.ts:148-158`, `site-settings.ts:71-76`). → `mappers/shared.ts`. Do **not** swap
  straight to es-toolkit: its `isPlainObject` rejects class instances and the two `pick`s differ on
  `undefined` handling (`site-settings.ts:87` deliberately uses bare `in`). −55.
- **CLI duplication**: `cli.ts:47-61` and `orchestrator.ts:30-39` validate `--only` twice with the
  same error string (the second is unreachable — `tasks/migrate.ts:88` always passes
  `MIGRATION_PHASES`); `cli.ts:27-45`/`verify-cli.ts:35-60` repeat the commander shell,
  `cli.ts:51-55`/`verify-cli.ts:66-70` the comma-split parser. `source-args.ts` is the existing home.
  −45. `orchestrator.ts` then merges into `tasks/migrate.ts`; `render.ts` + `unmappable.ts` merge into
  `report.ts`; `importers/user-converters.ts` into `users-groups.ts`.
- **`verify.ts:192-206`** inlines the same `NotYetImplementedError` catch as its own
  `countOrNotImplemented` (`:155-166`). −12.
- **`phases/content.ts:230-272`** adapts `NavigationWriteModel` (`navigation-import.ts:71-76`, designed
  for a siteId-only nav) onto today's per-locale `ensureSiteNav(siteId, locale)` — fix the interface,
  delete the adapter. −25. This is the one 3.x-own-shape adapter in the tree; everything else the grep
  for `backward|legacy|old shape|used to be` turned up is legitimate 2.x-source handling.
- **Layout**: `page-import.ts`, `page-history-import.ts`, `navigation-import.ts` are importers sitting
  at the root while the reset added its three new importers under `importers/` — move them (0 LOC,
  ~14 import edits, after F2 so no corpses move). `content-staging.ts` stays at root (it reads,
  never writes).
- **Comments**: 36% of non-test lines (3,380/9,294) are comments; `phases/content.ts` is 51%,
  `phases/settings.ts` 48%, `mappers/authentication.ts` 44%. Three kinds: task-number changelogs
  (`importers/users-groups.ts:15-105` is a 90-line "Task 729 adds / Task 730 adds / Task 731 adds"
  block; `page-import.ts:1-128` is 128 lines before the first export), narration of deleted code
  (`page-import.ts:447` "the extracted body of what used to be `importPages()`";
  `users-groups.ts:36-45` still says the converters are stubbed — `phases/users.ts:102-109` wires real
  ones; `connector.ts:91-100` says generators are "not implemented" — `connectors/postgres.ts`
  implements all nine), and genuinely load-bearing *why* comments (`page-history-import.ts:56-66`
  bind-parameter ceiling, `context.ts:98-128`, `bootstrap.ts:160-176`) — keep those. Trim
  file-by-file while touching each, not as one sweep.
- Test coverage: 10,702 test LOC; `phases/*.integration.test.ts` and `importers/users-groups.test.ts`
  (1,068) are the nets for the structural changes.

### F15. Storage `setup`/`setupDestroy` flow has zero implementors  — dead code | net LOC −155 | risk low (needs a keep/drop decision) | effort S

- `grep -rn "setup" modules/storage/*/definition.yml` → nothing; no module exports `setup`/`setupDestroy`.
  So `models/storage.ts:579-586` never fires and both `api/storage.ts:394,468` routes always throw
  `"has no setup process."` (`models/storage.ts:1108,1121`). Dead surface: `StorageDefinition.setup`
  (`:139-143`), `StorageTarget.setup` (`:208-212`), `StorageModule.setup/setupDestroy` (`:271-273`),
  `buildSetupValues` (`:610-619`), `runSetup` (`:1105-1111`), `destroySetup` (`:1118-1124`), two API
  routes + schema. A deliberate extension point nobody built — CLAUDE.md's "a fallback for a case that
  cannot occur is dead code" applies equally to a hook for a module that cannot occur.
- Also: `git/storage.ts:13,27` exposes `ensureRepo` as a handler that `api/storage.ts:272` can never
  dispatch (not in `git/definition.yml:133-149`'s actions nor `STORAGE_HANDLERS`); every real caller
  imports it from `./repo.ts`. −2.
- `StorageModule` (`models/storage.ts:259-310`) ends with `[handler: string]: any`, so a typo'd
  handler name type-checks; `sftp/storage.ts:82-84` uses `as StorageModule` where the other six
  annotate. Worth tightening while F3 is open, but it's a type change, not LOC.

### F16. MCP tools: `toResult` ×6 and a second `defaultLocale`  — utility extraction | net LOC −25 | risk low | effort S

- `function toResult(payload: unknown): CallToolResult { return { content: [{ type: 'text', text:
  JSON.stringify(payload) }] } }` is declared identically in `mcp/tools/createPage.ts:54`,
  `getPage.ts:37`, `listSites.ts:6`, `searchPages.ts:36`, `listNavigation.ts:26`, `updatePage.ts:47`.
  The `siteId` zod field with the description "Omit on a single-site instance; see `list_sites`
  otherwise." is repeated in five tool schemas. One `mcp/tools/shared.ts` with `toResult` and
  `siteIdArg`/`localeArg`.
- `mcp/site.ts:21-24 defaultLocale(site)` is F11's duplicate.
- Test coverage: each tool has a co-located test (122–236 LOC each).

### F17. `core/scheduler.ts` local dedupe  — utility extraction | net LOC −15 | risk low | effort S

- `notifier.send('scheduler', JSON.stringify({ source: WIKI.INSTANCE_ID, event: 'jobCompleted', state, id, errorMessage }))`
  is written out three times: `:585-593`, `:616-625`, `:695-704`. A module-level
  `notifyJobCompleted(id, state, errorMessage?)` beside `notifier` (`:76`).
- Otherwise the file is one responsibility (job queue) with clearly sectioned methods — **leave**.

### F18. Storage: four content-type→extension maps  — utility extraction | net LOC −18 | risk med | effort S

- `models/storage.ts:20-24` (no dot, `txt` fallback at `:30-32`), `helpers/pageSerialization.ts:18-24`
  (with dot, adds `text`/`redirect: '.txt'`), `modules/storage/disk/storage.ts:26-34` (no dot,
  `redirect: 'json'`), `modules/storage/git/content.ts:28` (`['md','adoc','html','txt']` = values of
  #1 + `txt`). The markdown/asciidoc/html triple is identical in all four; `redirect` genuinely differs
  (disk writes JSON, sftp writes `.txt`), so unification needs a decision, and
  `disk/storage.test.ts:162,417` pin `.json`.

### F19. Small dead exports  — dead code | net LOC −12 | risk low | effort S

- `helpers/siteRules.ts:101-104 rulesAllowSite` — `grep -rn rulesAllowSite --include='*.ts'` → only
  its definition and `siteRules.test.ts`; `models/groups.ts#checkSiteAccess` calls `resolveSiteRule`
  directly.
- `helpers/common.ts:618 getTypeDefaultValue` — exported, used only inside `parseModuleProps`.
- Search: seven `export`s with zero importers that are used only in-file (`OversizedDocument`,
  `BatchDocumentsResult` in algolia; `CloudSearchSearchResponse`, `SdfDeleteDocument`,
  `CloudSearchFieldType` in aws; `DEFAULT_DICTIONARIES`, `FALLBACK_DICTIONARY` in db) and
  `models/search.ts:687 getActiveEngine()` (only `models/search.test.ts:459-524` calls it; its own doc
  says "e.g. a future admin action").

## Files ranked by size with a one-line verdict each

Non-test files only, this area.

| File | LOC | Verdict |
| --- | ---: | --- |
| `modules/search/aws-cloudsearch/search.ts` | 1340 | **extract-shared + trim** (F5, F6): ~260 hoistable/droppable |
| `index.ts` | 1208 | **split** (F12) into `core/http/*`; boot script stays |
| `core/collab.ts` | 982 | **leave** — one protocol (rooms, relay, chunk reassembly) with clear `// ---` sections; nothing duplicated elsewhere |
| `migration/importers/users-groups.ts` | 985 | **split + shrink** (F2, F14): −250 incl. the 90-line changelog docblock |
| `core/scheduler.ts` | 922 | **leave** + local dedupe (F17) + `withTimeout` (F10) |
| `modules/search/azure-search/search.ts` | 888 | **extract-shared** (F5): ~130 hoistable |
| `helpers/common.ts` | 807 | **split** by topic (F13) |
| `migration/verify.ts` | 741 | **split** — counting / phase-reconciliation / spot-check / formatting are four concerns; dedupe NYIE catch |
| `modules/storage/disk/storage.ts` | 637 | **leave** — import/backup logic is unique; only the extension map moves (F18) |
| `core/db.ts` | 635 | **leave**; optional: the LISTEN/NOTIFY event-bus half (`:392-537`, `subscribeToNotifications`/`notifyViaDB` + the `subscribeToEvents()` fan-out) is an event-bus concern that could be `core/events.ts`, leaving db.ts = pool + migrations; no LOC saved, so not ranked |
| `migration/page-import.ts` | 636 | **move to `importers/` + shrink** (F2, F14) |
| `modules/search/db/search.ts` | 606 | **leave** (F6 fallbacks aside) — SQL-native, shares only `escapeHtml` |
| `modules/search/algolia/search.ts` | 597 | **extract-shared** (F5): ~60 |
| `modules/search/elasticsearch/search.ts` | 596 | **extract-shared** (F5): ~60 |
| `migration/content-staging.ts` | 524 | **leave at root**, delete unused fields (F2 1b/1c) |
| `migration/connectors/export-bundle.ts` | 515 | **leave** |
| `helpers/rateLimit.ts` | 488 | **leave** — nine limiters, all with callers |
| `migration/mappers/authentication.ts` | 488 | **leave**; decide on the conflict-policy block (F2 1f) |
| `importer/runSummary.ts` | 490 | **delete** (F1) |
| `migration/page-history-import.ts` | 479 | **move to `importers/`**; dead `pages` loop |
| `migration/mappers/storage.ts` | 456 | **leave**; 4 helpers → `mappers/shared.ts` |
| `modules/storage/git/sync.ts` | 441 | **leave** (genuinely unique) |
| `modules/comments/default/comments.ts` | 407 | not surveyed (outside remit) |
| `migration/navigation-import.ts` | 402 | **move to `importers/`** + fix `NavigationWriteModel` signature |
| `migration/connectors/postgres.ts` | 377 | **leave** — dense, low-comment, all nine generators real |
| `helpers/security.ts` | 359 | **leave** |
| `modules/storage/git/content.ts` | 342 | **leave**; `writeAndCommit` vs `actions.ts#writeIfChanged` share a 6-line write-and-stage preamble (−10) |
| `modules/storage/s3/storage.ts` | 330 | **extract-shared** (F3) |
| `helpers/network.ts` | 325 | **leave** |
| `helpers/images.ts` | 322 | **leave** |
| `migration/phases/settings.ts` | 321 | **leave**; 48% comments |
| `migration/phases/content.ts` | 352 | **leave**; delete nav adapter (F14) |
| `modules/authentication/ldap/authentication.ts` | 318 | not surveyed (outside remit) |
| `helpers/pageRules.ts` | 317 | **leave** — `siteRules.ts` correctly imports `MODE_PRIORITY` from it |
| `importer/assets.ts` | 317 | **delete** (F1) |
| `migration/bootstrap.ts` | 312 | **leave** |
| `importer/comments.ts` | 308 | **delete** (F1) |
| `helpers/blockDefinition.ts` | 284 | **leave** |
| `migration/path-normalization.ts` | 279 | **split**: delete `assignTreePaths` (F2 1a); ~150 survives. Not a duplicate of `common.ts#normalizePagePath` (that one collapses whitespace→hyphen and lowercases; this one rejects whitespace and folds `_`→`-` per segment) |
| `core/config.ts` | 253 | **leave** |
| `mcp/http.ts` / `mcp/stdio.ts` / `mcp/auth.ts` | 241 / 221 / 200 | **leave** |
| `helpers/advisoryLock.ts` / `helpers/pubsub.ts` | 231 / 227 | **leave** — the shared primitives the rest should keep using |
| `modules/storage/{sftp,azure,gcs}/*` | 722 / 232 / 224 | sftp: **extract-shared** (F4) + its two keyset loops (`pages.ts:165-190`, `assets.ts:202-236`) share one skeleton (−25); azure/gcs: **extract-shared** (F3) |
| `importer/assetFolders.ts` / `assetBatch.ts` | 185 / 165 | **delete** (F1) |
| `helpers/puppeteer.ts` / `totp.ts` / `pageSerialization.ts` | 179 / 174 / 153 | **leave** |
| `tasks/simple/*` (33 files) | 12–146 | **leave** — two log styles (silent-count vs `[ COMPLETED ]`/`[ FAILED ]` try/catch in 10 files) could share a `runLogged(label, fn)` (−50) but each task is 13 lines and the win is cosmetic |
| `mcp/tools/*` (7 files) | 67–150 | **extract-shared** (F16) |
| `core/logger.ts` / `maintenance.ts` / `processGuards.ts` / `temporal.ts` | 105 / 83 / 66 / 24 | **leave** (F9 aside) |
| `worker.ts` | 67 | **leave** |
| `helpers/redirect.ts` | 46 | **delete** (F7) |
| `helpers/config.ts` | 24 | **leave** — `isValidDurationString` has no caller but `parseConfigValue` does; fold both into `core/config.ts` if touched |

## Things I checked and rejected (so nobody re-checks them)

- **`helpers/*` dead-export scan**: for every `export (function|const|class|type|interface)` in
  `helpers/`, `core/`, `mcp/`, `mcp/tools/`, `tasks/simple/`, `tasks/workers/` I counted non-test files
  (excluding `node_modules` and the defining file) mentioning the name. Only two *functions* had zero:
  `redirect.ts#isFollowableRedirect` (F7) and `siteRules.ts#rulesAllowSite` (F19). Everything else with
  zero external non-test hits is either a type, a constant, or a function exported *for* its co-located
  test and used internally (`appShell.ts#templateAppShell`, `blobTarget.ts#categoryOf`,
  `security.ts#isSameOriginHeader/corsOrigin`, `puppeteer.ts#launchUnderSemaphore`,
  `recoveryCodes.ts#generateRecoveryCode`, `errorHandler.ts#buildNonApiErrorResponse`,
  `db.ts#queryLogger/resolvePoolSizeOptions`, `mcp/site.ts#resolveSite/resolveDefaultSiteId`, every
  `mcp/tools/*#handleX`, `update-locales.ts#isFlatStringMap`) — the CLAUDE.md-sanctioned pattern, not
  dead code. No node_modules-inflated false negatives remain (an earlier pass counted `@azure`'s own
  `isValidUuid` and `@kwsites/promise-deferred` as callers).
- **`helpers/common.ts` vs es-toolkit**: nothing in it duplicates es-toolkit. `startCase`, `isNil`,
  `isPlainObject` are imported from es-toolkit at `:1-2`. `generateHash`/`generatePathHash`/
  `isValidUuid`/`durationToSeconds` have no es-toolkit equivalent; the only native-API duplicate is
  `createDeferred` (F8).
- **Slugify / normalize-path duplicates across helpers**: grepped `toLowerCase()` combined with
  `replace|slug|trim` across `helpers models migration modules core api controllers mcp` — the only
  path-normalising implementations are `common.ts#normalizePagePath`, `common.ts#encodeTreePath`,
  `migration/path-normalization.ts#normalizeMigratedPath` (different semantics, see table above) and
  `helpers/pageRules.ts:178 normalizePath` (private, strips a leading `/` only for rule matching).
  Not a duplication.
- **Locale parsing**: `stripLocalePrefix`/`matchLocaleCode` in `common.ts` are the only
  implementations; `models/locales.ts`, `git/sync.ts`, `pageRules.ts`, `appShell.ts` all import them.
- **`connectListener` call shape** (`db.ts:443-466`, `scheduler.ts:196-237`, `collab.ts:307-326`):
  the `getClient`/`setClient` closure pair is the same at all three, but it's 4 lines each and the
  handle is what varies — not worth an abstraction over `helpers/pubsub.ts`.
- **Four "minimal `WIKI`" bootstraps** (`index.ts:150-165`, `worker.ts:15-48`, `mcp/bootstrap.ts:88-97`,
  `migration/bootstrap.ts`): they share the `{ IS_DEBUG, ROOTPATH, INSTANCE_ID, SERVERPATH, configSvc }`
  literal + `configSvc.init()` + `logger.init()` (~10 lines) but each loads a deliberately different
  model subset with a doc comment explaining why. A `createMinimalWiki()` would save ~25 lines and blur
  three carefully-argued boundaries — rejected.
- **`core/db.ts#checkForLegacyInstall` / `LEGACY_TABLES`** (`:77`, `:570-583`): refuses to boot
  against a 2.x database. This is a guard, not a compat fallback — keep.
- **`core/collab.ts`**: the relay chunk/reassembly (`:828-970`) looked separable but it's ~140 lines
  bound to the room map and `notifier`; nothing else in the codebase chunks NOTIFY payloads, so there is
  no second caller to share with. Leave.
- **`tasks/simple/dispatch-storage.ts` / `import-content.ts` `deps` injection pattern**: each declares
  its own `deps` default object — consistent, not duplicated logic.
- **Storage locale conventions**: `disk` always prefixes the locale folder (`disk/storage.ts:172-173`,
  per `docs/decisions/locale-architecture.md` §5.3); `git` (`content.ts:44-51`) and `sftp`
  (`pages.ts:109-126`) leave the primary bare. Three implementations by design — do not unify.
- **Storage content serialization**: only `sftp` calls `injectFrontMatter` (`pages.ts:179`);
  `git/content.ts:255-258` documents that it never writes front matter; `disk` writes raw content.
  Hoisting would change on-disk output — rejected.
- **`hasImplementation()` / dynamic `import()` in `models/storage.ts` and `models/search.ts`**: same
  shape twice, but CLAUDE.md lists both as extension-sensitive paths to keep visible; a shared
  `loadModule(kind, key)` would hide exactly what the doc says must stay explicit.
- **`helpers/security.ts#corsOrigin` REGEX branch's `try/catch`**: not a legacy fallback — it degrades
  an operator-typed invalid regex to same-origin.
- **`mcp/renderRefusal.ts` / `mcp/stdioReverify.ts`**: small, single-purpose, both with callers.
- **Migration 2.x-source handling** (`navigation-import.ts:166` pre-2.3 flat nav, `mappers/authentication.ts:363`
  pre-2.5.1 empty `strategyKey`, `content-staging.ts:234` MySQL/SQLite 0/1 booleans, `mappers/authentication.ts:100`
  knex `{v:…}` wrapping): legitimate source-schema handling, in scope per CLAUDE.md's migration
  exemption — not flagged.
