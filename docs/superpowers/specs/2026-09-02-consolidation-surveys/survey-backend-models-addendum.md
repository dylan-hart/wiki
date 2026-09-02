# Notes: schema.ts types + mid-size models (fork D)

Scope: `backend/db/schema.ts`, `db/relations.ts`, and the mid-size models not covered by other forks.
All line numbers verified against the worktree at HEAD `e19aaa72`.

## Existing helpers found (reuse, don't duplicate)

- `helpers/puppeteer.ts` — `launchPuppeteerBrowser(errorName)`, `launchUnderSemaphore`, `getPuppeteerLaunchArgs`. Already shared by `rendering.ts`, `pdfExport.ts`, `diagramRender.ts` for the *launch*; the availability check, quiet close and timeout race around it are NOT shared (see F3).
- `helpers/common.ts#requestOrigin(protocol, hostname)` — used by `controllers/seo.ts:188,204`.
- `helpers/graphCache.ts#invalidateGraphCache(siteId)` — called from `pageHistory.record()` and `pages.ts`.
- `models/jobs.ts:17,273,399`, `models/search.ts:229`, `models/icons.ts:844`, `models/tree.ts:164`, `models/pages.ts:1540` already use `typeof table.$inferSelect` — the pattern F1 asks the rest to follow. `sites.ts:299`, `storage.ts:778`, `authentication.ts:435` use `Partial<typeof t.$inferInsert>` for patch values.

## Findings

### F1. Seven model interfaces restate a schema table column-for-column — category 4/1 | net LOC −115 | risk low | effort S

Each of these is a hand-written interface that is field-for-field the table's inferred row type, and every producer site then has to `as X` the plain `select()` result back into it (the cast exists only because the interface is declared separately). Replace with `typeof table.$inferSelect` (or `Pick`/`Omit` of it) and drop the casts.

| Interface | Lines | Table | Match | Cast sites that go away |
|---|---|---|---|---|
| `comments.ts` `Comment` | 24–37 (14) | `comments` (schema 841–866) | exact, all 12 columns, nullability matches (`pageId`/`siteId` `.notNull()`, `authorId`/`replyTo`/`render`/`guest*` nullable) | `comments.ts:238,267,279` (`rows[0] as Comment`) |
| `apiKeys.ts` `ApiKey` + `keySelection` | 85–108 (24) + 165–178 (14) | `apiKeys` (schema 39–108) | exact, all 12 columns; `keySelection` lists every column so `.select(keySelection)` ≡ `.select()` | `apiKeys.ts:284,306,387` (`as ApiKey[]`/`as ApiKey`) |
| `hooks.ts` `Hook` + `hookSelection` | 70–85 (16) + 141–155 (15) | `hooks` (schema 506–526) | exact, all 13 columns; `state` is already `hookStateEnum` so the `'pending' \| 'success' \| 'error'` union is inferred for free | `hooks.ts:225,237` |
| `classificationLevels.ts` `ClassificationLevel` | 11–17 (7) | `classificationLevels` (schema 408–415) | exact, all 5 columns | `classificationLevels.ts:41,175,198` |
| `contentSync.ts` `ContentSyncStateRow` | 17–28 (12) | `contentSyncState` (schema 261–280) | exact, all 10 columns (`targetRef: unknown` ≡ untyped `jsonb()`) | `contentSync.ts:105,123,133` — though see F7: the three methods casting are themselves dead |
| `blockCredentials.ts` `BlockCredential` | 10–17 (8) | `blockCredentials` (schema 380–399) | `Omit<…, 'secret'>` — `publicSelection` (19–26) already does exactly that projection and stays | none (return types only) |
| `glossary.ts` `GlossaryTerm` | 16–24 (9) | `glossaryTerms` (schema 437–458) | `Omit<…, 'siteId'>` (the interface omits `siteId`; `listTerms`/`getTerm` return plain `select()` rows so the extra key is silently present anyway) | none |
| `approvals.ts` `PageEditSubmission` | 88–94 (7) | `pageEditSubmissions` (schema 1066) | `Pick<…, 'id' \| 'content' \| 'baseHash' \| 'createdAt' \| 'updatedAt'>` | — |
| `approvals.ts` `ApprovalRule` | 171–190 (20) | `approvalRules` (schema 167–186) | `Omit<…, 'siteId'> & { match: ApprovalMatchMode }` — `match` is a `varchar(16)` the interface narrows; the 11-line `ruleSelection` (214–225) stays because it deliberately drops `siteId` | `approvals.ts:266,316,362,397` (`as ApprovalRule`) — the `match` narrowing keeps one cast or a `.$type<ApprovalMatchMode>()` on the column |
| `users.ts` `UserCore` | 46–57 (12) | `users` (schema 1641) | `Pick<…, 10 fields>` — the comment says it mirrors the API `UserCore` schema, so keep the name, change the body | — |
| `tags.ts` `Tag` | 6–9 (4) | `tags` | `Pick<…, 'tag' \| 'usageCount'>` | — |
| `locales.ts` `SideloadLocalePack` | 53–61 (9) | `locales` | `Pick<…, 7 fields>` (`strings: Record<string, unknown>` vs untyped `jsonb()`; either add `.$type<Record<string, unknown>>()` to the column or intersect) | — |

- **Proposed target shape:** in each model, `export type Comment = typeof commentsTable.$inferSelect` (one line) replacing the interface; delete `keySelection`/`hookSelection` and the `as X` casts. For `GlossaryTerm`/`BlockCredential`/`ApprovalRule`/`UserCore`/`Tag`/`SideloadLocalePack`, `Omit`/`Pick` one-liners. Where a jsonb/varchar column is narrowed by the interface (`ApprovalRule.match`, `IconSetRow.info`, `SideloadLocalePack.strings`), prefer `.$type<…>()` on the column in `schema.ts` — but only if the type lives somewhere `schema.ts` can import without pulling a model in (`ApprovalMatchMode` is defined in `approvals.ts:25`; move the `approvalMatchModes` const to `helpers/` or `db/` first, or keep the one intersection).
- **Genuinely transformed (NOT findings — leave alone):** `pageHistory.ts` `PageHistoryEntry`/`…Version`/`Recoverable…` (author join, `?? ''` defaults), `comments.ts` `ThreadedComment`/`AdminComment` (joined `authorName`/`pagePath`), `checklists.ts` summaries (joined names), `pageWatching.ts` `WatchedPage` (join + resolved preference), `pageWatchEvents.ts` `InboxNotification`/`PendingDigestEvent` (narrowed `action`, subset), `authentication.ts` `AuthStrategy` (`autoEnrollGroups ?? []`, `config` rebuilt through `buildConfig`, `authentication.ts:225–235`), `storage.ts` `StorageTarget` (module-definition merge), `assets.ts` `Asset` (tree join), `tree.ts` `TreeRow` (`folderPath: string | null` vs `.notNull()`, drops `navigationMode`/`navigationId`), `pages.ts` `Page`, `groups.ts` `GroupRule` and `navigation.ts` `NavigationItem` (jsonb element shapes, no table), `icons.ts` `IconSetRow` (narrows `info` — could be `.$type<IconifyInfo | Record<string, never>>()` on `iconSets.info` since `schema.ts` importing a type from `@iconify/types` is harmless, but the `info ?? {}` mapping at `icons.ts:187,208` would still be needed for the `.default({})` case; marginal, −8 at best).
- **LOC:** ~150 lines of interface + projection constants removed, ~25 one-liners added, ~14 casts deleted → net ≈ −115. Touches 12 files.
- **Risk:** low — type-only; behaviour identical. `npm run typecheck` is the whole verification; every listed file has a co-located `*.test.ts` that compiles against the types (`comments.test.ts`, `apiKeys.test.ts`, `hooks.test.ts`, `classificationLevels.test.ts`, `contentSync.test.ts`, `blockCredentials.test.ts`, `glossary.test.ts`, `approvals.test.ts`, `users.test.ts`, `tags.test.ts`, `locales.test.ts`).
- **One caveat:** `api/schemas/` JSON Schemas reference these names in doc comments only (`UserCore`); nothing imports the TS interfaces from `api/` except as types — grep before renaming any of them.

### F2. `pageHistory.ts` builds the same entry projection + row→entry mapping three times — category 1 | net LOC −45 | risk low | effort S

- **Locations:** projection `{ id, action, via, changedFields, reason, versionDate, locale, path, title }` at `pageHistory.ts:398–407` (`list`), `525–534` (`getVersion`), `619–628` and `654–664` (`listRecoverable`, inner and outer); the `leftJoin(usersTable, eq(usersTable.id, …authorId))` + `authorId: usersTable.id, authorName: usersTable.name` at `408–412`, `537–542`, `665–669`; and the row→entry mapping (`changedFields ?? []`, `reason ?? ''`, `author: { id: row.authorId ?? null, name: row.authorName ?? '' }`) at `438–453`, `556–573`, `689–705`.
- **What differs:** `getVersion` adds `content`/`meta`/`authorEmail`; `listRecoverable` adds `meta` and lifts `tags`/`classification` out of it. The nine base fields and the author defaulting are byte-identical.
- **Also duplicated within the file:** the keyset-cursor `after ? or(lt(versionDate), and(eq(versionDate), lt(id))) : undefined` + `limit(n + 1)` + `hasMore`/`nextCursor` scaffold at `417–426, 431–435, 454–455` and `671–677, 680–684, 707–708` (~20 lines twice).
- **Proposed target shape:** a module-level `const entrySelection = { id: pageHistoryTable.id, … }` (spread into each `select`), a `toEntry(row)` that returns the 9 base fields + author, and a `keysetAfter(table, after)` / `paginate(rows, limit, encode)` pair. `list` and `listRecoverable` shrink to their own distinct parts (the `DISTINCT ON` subquery, the `notExists`).
- **Test coverage:** `pageHistory.test.ts` (622 lines) covers `list` pagination/cursor, `getVersion`, `listRecoverable`, `recoverDeletedPage` — good.
- `record()` vs `auditLog.record()` (`auditLog.ts:186–212`): checked, **not** duplicated — pageHistory snapshots the live `pages` row into `meta`; auditLog is a plain insert of caller-supplied fields. Only the "log and swallow" `try/catch` shape is shared (4 lines); not worth a helper.

### F3. Puppeteer availability / quiet-close / timeout-race is copy-pasted across `diagramRender.ts`, `pdfExport.ts`, `rendering.ts` — category 1 | net LOC −40 | risk low | effort S

`helpers/puppeteer.ts` already owns the launch; three wrappers around it are triplicated:

| Piece | `diagramRender.ts` | `pdfExport.ts` | `rendering.ts` | Identical? |
|---|---|---|---|---|
| `isAvailable()` (`getDefinition('puppeteer')` + `isInstalled`) | 161–164 | 121–124 | 1075–1078 | byte-identical ×3 |
| `ensureCan*()` (throw `CustomError(<name>, <msg>, 503)` if unavailable) | 166–174 (`ensureCanRenderMermaid`) | 126–134 (`ensureCanExport`) | 1080–1093 (`ensureCanRender`, plus an editor check) | same shape, different error name/message |
| `discardBrowser()` (`await browser?.close()` in try, `logger.debug` on failure) | 416–422 | 277–283 | 1296–1302 (`discardRenderer`, closes a `PageRenderer` not a browser) | identical modulo log text |
| `launchBrowser()` (one-line delegation to `launchPuppeteerBrowser(errorName)`) | 411–413 | 269–271 | inlined at 1338 | trivial |
| timeout race (`Promise.race([work, setTimeout-reject CustomError(…, 504)])` + `clearTimeout` in `finally`) | 393–409 (`withTimeout`, generic, called ×3) | 246–267 (`waitForBlocksToSettle`, hard-coded to one call) | 53–? (`withRenderTimeout`, module function) | same mechanism ×3, only the error name/message/ms differ |

- **Proposed target shape:** add to `helpers/puppeteer.ts`: `isPuppeteerAvailable()`, `assertPuppeteerAvailable(errorName, message)`, `closeQuietly(closable, label)`, and `withTimeout<T>(work, ms, errorName, message)`. `pdfExport.waitForBlocksToSettle` becomes `withTimeout(page.evaluate(blockSettleScript, …), EXPORT_SETTLE_TIMEOUT, 'exportSettleTimeout', msg)` — 22 lines → 5. `diagramRender.withTimeout` and `rendering.withRenderTimeout` are deleted.
- **LOC:** ~70 removed, ~30 added → net ≈ −40 across 4 files.
- **Test coverage:** `diagramRender.test.ts` (658), `pdfExport.test.ts` (310), `rendering.test.ts` (718) all stub `launchPuppeteerBrowser`/`extensions.isInstalled` — the availability and timeout paths are asserted (`diagramRender.test.ts` has explicit `…Timeout` cases). Low risk.
- **Rejected as part of this:** the actual `browser.newPage()` / `setContent` / `evaluate` bodies differ per use (mermaid mount vs. page.goto+pdf vs. render-shell); no shared "render session" abstraction is warranted.

### F4. `export.ts#purgeExpired` and `siteImport.ts#purgeExpired` are the same function — category 1 | net LOC −24 | risk low | effort S

- **Locations:** `export.ts:199–222` and `siteImport.ts:389–412`. Line-for-line identical: `readdir` the model's directory (ENOENT → 0, else rethrow), `cutoff = Now.subtract({ seconds: TTL })`, `stat` each entry, `unlink` where `mtime < cutoff`, count. Only the directory getter (`exportsPath` / `importsPath`) and the TTL constant (`EXPORT_TTL_SECONDS` / `IMPORT_TTL_SECONDS`) differ. `deleteExport` (`export.ts:189–191`) and `deleteUpload` (`siteImport.ts:378–380`) are also the same `fs.unlink(...).catch(() => {})` three-liner.
- **Proposed target shape:** `helpers/fsPurge.ts#purgeFilesOlderThan(dir: string, ttlSeconds: number): Promise<number>`; each model's `purgeExpired` becomes a one-line delegation. (Both models already live under `<dataPath>/exports` and `<dataPath>/imports`; a `dataDir(name)` getter in `helpers/` is optional.)
- **Test coverage:** `export.test.ts` (237) and `siteImport.test.ts` (1005) both exercise `purgeExpired` with real temp dirs — the helper inherits both.
- **Not duplicated (checked):** archive *writing* (`export.ts:82–186`, tar via `createTarball`) vs. *reading* (`siteImport.ts#readArchive` 130–~300, streaming `listTarball` with size limits) are inverse operations with no shared body. `glossary.ts` export/import (`356–404`) is plain JSON with no archive at all.

### F5. `mail.ts` repeats the locale-template send scaffold in four `send*` methods — category 1 | net LOC −30 | risk low | effort S

- **Locations:** `sendVerifyEmail` (252–269), `sendWelcomeEmail` (336–354), `sendPasswordResetConfirmed` (365–380), `sendRegistrationAttemptNotice` (393–412). Each is: build `link` via `buildLink`, `params = { name, link }`, then `this.send({ to, subject: resolveString(locale, '<key>.subject'), text: resolveString(locale, '<key>.text', params), html: resolveString(locale, '<key>.html', params) })`. Identical except the template key and the link path.
- **What differs elsewhere:** `sendForgotPassword` (285–317) appends a signature to text/html; `sendTestEmail` (426–450) builds different params per channel. Those two stay as they are (or use the helper for the common half).
- **Proposed target shape:** `private async sendTemplate(to, locale, key, params, { textSuffix = '', htmlSuffix = '' } = {})` doing the three `resolveString` calls + `send`. The four simple senders become 4–6 lines each.
- **Test coverage:** `mail.test.ts` (980) asserts on the `send()` payload per method (subject/text/html strings) — the helper is exercised through every existing test.

### F6. Dead model methods (zero production callers) — category 4 | net LOC −30 | risk low | effort S

Verified by `grep -rn '\b<name>\b' backend frontend/src blocks e2e docs` (excluding `node_modules`, `compiled/`):

| Method | Lines | Callers found | Notes |
|---|---|---|---|
| `blockCredentials.deleteSiteCredentials` | `blockCredentials.ts:154–157` | none | Its own doc comment says "called from `models/sites.ts#deleteSite()`" — false: `sites.ts:504` deletes `blockCredentialsTable` directly inside the transaction. Delete the method (4 lines incl. comment). |
| `authentication.getStrategy` | `authentication.ts:177–179` | none (only `docs/migration/vendor/export-bundle/models-authentication.js:33`, a vendored 2.x source the doc-test `test/migration-export-bundle-doc.test.ts` parses statically — not a live import) | Returns an unfiltered array despite the singular name; `getStrategyById` is what everything uses. |
| `commentProviders.canonicalPageUrl` | `commentProviders.ts:124–127` (inventory said 174; actual def is 124) | `commentProviders.test.ts` only (7 refs) | The only in-model use of `helpers/common.ts#requestOrigin`. Delete method + its test block. |
| `commentProviders.getActiveProvider` | `commentProviders.ts:356–363` | `commentProviders.test.ts` only (5 refs); `commentProviders.ts:455` is a comment | The read-side fallback the comment at 452–455 describes is never exercised in production — `api/comments.ts:248` calls `getSiteProviders({ mask: true })` and picks client-side. Either wire the route through it or delete it; as a survey item it is dead + a stale comment. |
| `contentSync.getState` / `getStatesForContent` / `getStatesForTarget` | `contentSync.ts:89–106, 111–124, 129–134` (~40 lines incl. JSDoc) | test-only (`contentSync.test.ts`); `docs/variances.md:1257` mentions `getState`/`getStatesForTarget` in prose only | Removing them also removes the last consumers of `ContentSyncStateRow` (F1). The variances entry's sentence "`getState`/`getStatesForTarget` still show it" would need rewording. |
| `contentSync.getOutOfDatePages` / `getOutOfDateAssets` | `contentSync.ts:325–355, 356–390` (~60 lines) | test-only | Their `count*` twins (`391–423`, `424–463`) run "the identical LEFT JOIN" (own doc comment at 165–169) — so the row-returning versions are dead *and* a second copy of that join. Delete both; the `OutOfDateContent` interface (31–35) goes with them. |

- **Net:** ≈ −30 in the three small models, ≈ −100 in `contentSync.ts` (plus ~150 lines of now-pointless tests in `contentSync.test.ts`, which the other fork should reconcile with its own contentSync finding — I only sized, per directive).
- **Rejected as dead but flagged:** `blockCredentials.ts` `deleteSiteCredentials` comment is the only place this cross-file contract was written down; once deleted, `sites.ts:503–509`'s own comment already lists block-credential rows, so nothing is lost.

### F7. Over-exported module-private symbols (drop `export`) — category 4 | net LOC 0 | risk none | effort XS

Exported but referenced nowhere outside their own file *and* not by their tests (verified by per-name grep, own-file count > 1 means used internally): `rendering.ts#slugifyHeading` (471), `contentSync.ts#SYNC_CONTENT_TYPES`/`SYNC_DIRECTIONS` (9, 13), `flags.ts#FLAG_KEYS` (24), `import.ts#PANDOC_IMPORT_FORMATS`/`IMPORT_EXTENSION_FORMATS` (102, 164), `siteImport.ts#IMPORT_MAX_ENTRY_BYTES`/`IMPORT_MAX_TOTAL_BYTES` (70, 81), `groups.ts#GROUP_RULE_MATCH_KINDS` (27), `apiKeys.ts#SigningCertificates` (23), `glossary.ts#GLOSSARY_EXPORT_FORMAT_VERSION` (64), `pageviews.ts#pageviewWindows` (24). No LOC change; only shrinks the public surface a reader has to consider. Batch with whatever else touches each file.

## Files ranked by size — verdict

| File | Lines | Verdict |
|---|---|---|
| `db/schema.ts` | 1685 | leave — ~55% is doc comments explaining column intent; the tables are the source of truth F1 points everything at. Only change: a few `.$type<…>()` annotations (F1). |
| `pageHistory.ts` | 945 | leave, extract (F2) — one responsibility, just repetitive. |
| `icons.ts` | 883 | leave — four cache tiers in one class is coherent; the only overlap with `assets.ts` is the 12-line atomic-write (`icons.ts:731–745` vs `assets.ts:951–963`, same tmp+rename+warn+rm shape) and a 5-line `purgeCache`. A `helpers/atomicWriteFile.ts` saves ~10 lines; below the bar on its own, fold into F3/F4's helper pass if someone is in `helpers/` anyway. |
| `glossary.ts` | 849 | leave — terms CRUD + versions + cache are one feature; `replaceAllRows`/`replaceAllRowsIn` + `recordVersionIn` are the tx/no-tx pair pattern, not duplication. |
| `search.ts` | 744 | (registry half surveyed elsewhere) query/engine half: leave. |
| `blocks.ts` | 688 | leave. |
| `comments.ts` | 657 | leave (F1 only). |
| `siteImport.ts` | 642 | leave (F4). `readArchive` is 170 lines of streaming-tar-with-limits and earns them. |
| `sites.ts` | 634 | leave. |
| `mail.ts` | 608 | leave (F5). |
| `authentication.ts` | 601 | leave (F6 one dead method). |
| `apiKeys.ts` | 570 | leave (F1: −38). |
| `contentSync.ts` | 491 | shrink (F6: ~−100, roughly a fifth of the file is test-only reads). |
| `hooks.ts`, `locales.ts`, `liveData.ts`, `jobs.ts`, `extensions.ts`, `diagramRender.ts`, `pdfExport.ts`, `import.ts`, `auditLog.ts`, `pageWatching.ts`, `pageWatchEvents.ts`, `pageviews.ts`, `pageProblems.ts`, `checklists.ts`, `classificationLevels.ts`, `export.ts`, `tags.ts`, `settings.ts`, `security.ts`, `rateLimits.ts`, `passkeys.ts`, `flags.ts`, `blockCredentials.ts`, `commentProviders.ts`, `analytics.ts` | 80–485 | leave. |
| `db/relations.ts` | 20 | leave — three live consumers via `WIKI.db.query.users`/`userKeys` (`users.ts:2482, 2867, 3156`); test fixtures import it to build the same Drizzle instance. Not dead. |

## Checked and rejected

- **The `purge*` family as a helper** — `pageWatchEvents.purgeExpired` (181–186), `pageviews.purgeExpired` (302–307), `sessions.purgeExpiredSessions` (170–175), `rateLimits.purgeStale` (113–118), `users.purgeExpiredKeys` (3199–3202), `apiKeys.purgeRevoked` (439–444), `jobs.cleanHistory` (411–426), `auditLog.purge` (338–360, also records an audit row), `comments.purgeGuestPii` (310–333, an UPDATE not a DELETE), `pageHistory.purge` (896–906). Each is one `delete().where(lt(col, now() - interval))` of 4–6 lines with a different table/column/interval; a `purgeOlderThan(table, column, interval)` helper would save ~2 lines each and hide the one thing a reader wants to see. Reject.
- **`icons.ts` disk cache vs `assets.ts` content cache** — different key scheme (`prefix/name.json` vs `id[0:2]/id-mtime.bin`), different eviction (none vs. size-swept LRU-by-mtime), different read path (JSON parse vs. stream handle). Only the atomic write is shared (see icons row above).
- **`auditLog.record` vs `pageHistory.record`** — different data flow (see F2).
- **Archive read/write across export/import/glossary** — see F4; no shared body.
- **`AuthStrategy` as `$inferSelect`** — genuinely transformed (`?? []` and `buildConfig`); an `Omit & {}` would be as long as the interface.
- **`IconSetRow` as `$inferSelect`** — needs `.$type` on `iconSets.info` and still needs the `?? {}` mapping for the `.default({})` case; −8 at most.
- **`ApiKeyIdentity`, `HookDelivery`, `ChecklistExecution*`, `WatchedPage`, `InboxNotification`, `AuditLogEntry`, `AdminComment`, `ThreadedComment`, `SearchResult`** — all joined/reshaped API types, correctly declared by hand.
- **`hooks.ts#getDeliveryHistory` vs `jobs.ts#getHistory`** — both page `jobHistory`, but hooks filters by `task = 'deliverHook'` + `payload->>hookId` and reshapes; the pagination is 6 lines each. Not worth sharing.
- **`export.ts#exportSite`'s seven `fs.writeFile(JSON.stringify(...))` calls** (117–150) — a `writeJson(dir, name, value)` local would save ~14 lines; noted, not a finding (single file, single function, trivially readable).
- **`db/relations.ts` deletion** — live (see table).
- **`jobs.ts` `JOB_SCHEDULE_SEED`** — exported, own-file only, but it is the seed the scheduler test reads through `jobs.init`; fine.
