# backend/models (+ db/schema.ts, db/relations.ts) survey

All paths relative to the `consolidation` worktree. Every line number below was read, not grepped
into existence; every "zero callers" claim was verified with a repo-wide grep across `backend/`,
`frontend/src`, `blocks/`, `e2e/` and `docs/` (see the "Checked and rejected" section for the
greps that came back non-empty).

## Summary

- 49 model files, ~31k LOC of model code plus ~26k LOC of co-located tests. The nine files over 1k
  lines are mostly *repetitive* rather than tangled: the same 8–15 line block pasted 4–14 times
  inside one file (users.ts's auth-blob write ×14, pages.ts's post-write fan-out ×5, tree.ts's
  folder-404 ×6) or across files (the module-registry skeleton ×4–6, the cluster reload trio ×5).
- The two highest-value extractions are cross-file: **F1** one `helpers/moduleRegistry.ts` for the
  `buildConfig`/`validateConfig`/`hasImplementation`/`ensureModule`/`refreshFromDisk`/`syncSite`
  copies in storage/search/authentication/commentProviders/analytics/extensions (≈ −280 LOC) and
  **F2** one `patchStrategyAuth()` for users.ts's fourteen identical advisory-locked
  read-modify-write blocks (≈ −110 LOC).
- Verified dead code totals ≈ −260 LOC: five test-only `contentSync` readers, `approvals.countSubmissions`,
  `sessions.getByUser`/`clearAllSessions`, `authentication.getStrategy`,
  `blockCredentials.deleteSiteCredentials`, `commentProviders.canonicalPageUrl`/`getActiveProvider`,
  `rendering.sanitize`, `tree.listDescendantPages`, `assets.AssetAtPath`, `approvals.ReviewerScope.actor`.
- Three files warrant a responsibility split — `rendering.ts` (sanitizer policy / post-process /
  render queue), `users.ts` (account CRUD / credentials+2FA / login flows), `approvals.ts` (rules /
  submissions / notifications) — and `assets.ts`'s self-labelled serving cache is a fourth. `pages.ts`
  should only shed its classification cluster. `tree.ts` and `navigation.ts` should stay one file each.
- No rewrite candidates. `approveSubmission`, `updateNavigation`, `movePage` are long but linear and
  heavily commented for concurrency reasons; a rewrite would not be smaller.
- Type declarations: seven interfaces restate a schema table column-for-column and force `as X`
  casts on plain `select()` results (`Comment`, `ApiKey`+`keySelection`, `Hook`+`hookSelection`,
  `ClassificationLevel`, `ContentSyncStateRow`, plus `Pick`/`Omit` cases) — F19, ≈ −115 type-only
  LOC, verified by `npm run typecheck` alone. `GroupUser`/`GroupUserPage` re-declare `UserCore`/`UserPage`
  (F15); `AssetAtPath` ≡ `Asset` (F9). Every other hand-written interface is a transformed API shape
  (flattened jsonb, joined columns) and should stay.

Aggregate if everything below lands: ≈ −1,300 LOC net of model code (plus ≈ −80 test lines), most
of it low risk, all of it covered by existing co-located DB-backed suites.

## Existing shared utilities worth knowing (reuse, don't re-create)

- `helpers/common.ts`: `CustomError(name, message, statusCode=400)`, `parseModuleProps`,
  `maskSensitiveConfig`/`unmaskSensitiveConfig`, `encodeTreePath`/`decodeTreePath`,
  `normalizePagePath`, `generatePathHash`, `defaultLocale(siteId)`, `stripLocalePrefix` & friends.
- `helpers/pageRules.ts`: `ruleMatchesPage`, `resolvePageRule`, `rulesAllow`, `ruleTags`,
  `compiledRegexFor` — the single page-rule evaluator (`groups.checkAccess` delegates to it).
- `helpers/siteRules.ts`: `ruleMatchesSite`, `resolveSiteRule`. (`rulesAllowSite` at :101 has no
  callers outside helpers/tests — cross-area note for the helpers survey.)
- `helpers/advisoryLock.ts#withAdvisoryLock`, `helpers/rateLimit.ts`, `helpers/recoveryCodes.ts`,
  `helpers/totp.ts`, `helpers/images.ts`, `helpers/puppeteer.ts#launchPuppeteerBrowser` (already
  shared by rendering + pdfExport), `helpers/blobTarget.ts#parseLargeThreshold`,
  `helpers/graphCache.ts#invalidateGraphCache`.
- `models/tree.ts` exports `pageIsVisible`, `compareFoldersFirst`, `MAX_DEPTH` for navigation.ts —
  the cross-model reuse convention already exists.
- `models/storage.ts#getFileExtension`/`getContentTypeFromExtension` — the one content-type map.
- `test/db.ts` fixture exposes `db`, so a test that loses a model-level read helper (F4) can read rows
  back directly.
- **Not present anywhere**: `isUniqueViolation(err)`, `escapeLikePattern` as a shared helper, an
  `assertLocaleActive(siteId, locale)`, a `paginate()` helper. Each is proposed below; don't add a
  second one.

## Findings

Ranked by (LOC removed × risk reduction) / effort.

### F1. Module-registry boilerplate ×4–6 across storage / search / authentication / commentProviders / analytics / extensions — utility extraction | net LOC ≈ −280 | risk low–med | effort M
- Locations, per method:
  1. `buildConfig(key, incoming, existing)` — **four byte-identical bodies**: `storage.ts:627-644`,
     `authentication.ts:252-269`, `commentProviders.ts:371-388`, `search.ts:445-462`
     (`buildEngineConfig`). Only the `props` source differs. The merge (`unmaskSensitiveConfig` →
     per-declared-prop `existing ?? default`, `readOnly` never taken from incoming) is pure.
  2. `validateConfig(key, incoming)` — **three identical 36-line bodies**: `storage.ts:654-689`,
     `authentication.ts:279-314`, `commentProviders.ts:398-433`; `search.ts:485-542` has the same
     enum/boolean/number/string switch (497-524) but refuses unknown keys (494-496) and adds a
     required/pattern pass (526-540).
  3. `hasImplementation(key)` — three identical bodies differing only in the probed file name:
     `storage.ts:404-411`, `search.ts:343-350`, `commentProviders.ts:137-144`.
  4. `ensureModule(key)` — `storage.ts:1064-1081` vs `search.ts:364-381`: identical
     memoise/log/catch wrapper around a dynamic `import()`. Per CLAUDE.md the import string is
     extension-sensitive and stays literal in each model; share only the wrapper.
  5. `refreshFromDisk()` definition scan — six copies of one skeleton (readdir → dirs only →
     `definition.yml` → `js-yaml.load` → `key = dir` → `parseModuleProps` → sort → log):
     `storage.ts:336-399`, `search.ts:303-338`, `commentProviders.ts:185-224`,
     `authentication.ts:509-544`, `analytics.ts:44-77`, `extensions.ts:191-217`. The "filtered to
     directories only" comment is pasted in all six. Differences: props-by-`order` sort in 3 of 6,
     `isAvailable` skip in auth/analytics, per-model decoration (storage's actions/versioning).
  6. `syncSite`/`syncAllSites` — `storage.ts:442-495` vs `commentProviders.ts:237-279`: same
     select-existing → insert-missing → delete-orphaned skeleton; only the `values({...})` differs.
     (`blocks.ts#syncSite:181-261` is deliberately different — updates name/description/icon,
     `onConflictDoNothing` — keep it out.)
- Proposed target shape — `backend/helpers/moduleRegistry.ts`:
  `readModuleDefinitions(dirPath, { parseProps, sortPropsByOrder, skipUnavailable, decorate, label })`,
  `mergeModuleConfig(props, incoming, existing)`,
  `validateModuleConfig(props, incoming, { refuseUnknown?, moduleTitle? })`,
  `moduleHasFile(dirPath, key, file)`, `loadModule(cache, key, () => import(...), label)`,
  `syncSiteModuleRows(table, siteId, definitions, rowFor)`. Each model keeps a 2–3 line binding so
  `WIKI.models.*` surfaces don't change. `search.ts:436-444`'s "kept as its own method" comment
  applies to the wrapper, not the merge — rewrite it when this lands.
- LOC: touched ≈ 600 across 6 files + ~120 helper; removed ≈ 280 net.
- Test coverage: `storage.test.ts` (refreshFromDisk :32, buildConfig+mask :718-746,
  hasImplementation :822, ensureModule :846), `search.test.ts:169-314, 534-972`,
  `commentProviders.test.ts:120-127, 246-268, 302-358`, `authentication.test.ts:134-155`,
  `analytics.test.ts`, `extensions.test.ts`.

### F2. users.ts: fourteen identical advisory-locked auth-blob read-modify-write blocks — utility extraction | net LOC ≈ −110 | risk low | effort S
- Locations (`withAdvisoryLock(authLockKey(id))` → `this.getById` → spread entry →
  `.update(usersTable).set({ auth, updatedAt: sql\`now()\` })`): `users.ts:1130-1156`
  (`setUserAuthFlags`, takes `db`), `1228-1247` (`setUserPassword`), `1337-1349`
  (`changeOwnPassword`), `1393-1401` (`setPasswordLoginEnabled`), `1433-1446` (`startTfaSetup`),
  `1469-1482` (`enableTfa`), `1512-1525` (`disableTfa`), `1556-1569` (`adminInvalidateTfa`),
  `1599-1615` (`verifyTfaCode`, early return), `1637-1659` (`verifyAndConsumeRecoveryCode`, early
  return), `1722-1730` (`regenerateRecoveryCodes`), `2150-2163` (`findOrCreateProviderUser`),
  `2923-2936` (`loginChangePassword`), `3053-3066` (`resetPassword`).
- Identical: lock key, re-read, `(current?.auth ?? {}) as Record<string, any>`,
  `currentAuth[strategyId] = { ...currentAuth[strategyId], ...patch }`, the update statement.
  Differs: 7 sites also mirror into the caller's stale `user.auth`; 3 need a conditional early return;
  1 takes a transaction handle.
- Proposed: `private async patchStrategyAuth(userId, strategyId, mutate: (entry) => Partial | null,
  { db?, mirrorInto? })` returning `boolean` (null from `mutate` = no write). Each site → 3 lines.
  Sub-findings that fall out for free: `loginChangePassword:2922-2936` and `resetPassword:3052-3066`
  are the same body as `setUserPassword` (hash + `mustChangePwd: false`); `disableTfa:1512-1525` and
  `adminInvalidateTfa:1556-1569` write the identical `{ tfaIsActive:false, tfaSecret:'', recoveryCodes:[] }`
  (the doc at 1533-1539 justifies two *public* methods, not two copies of the write).
- Test coverage: `users.test.ts` (3587 lines) covers changeOwnPassword, setPasswordLoginEnabled, the
  2FA enable/disable/invalidate paths, recovery codes, loginChangePassword and resetPassword — all
  DB-backed round trips through the public methods, so the private helper is exercised by every one.

### F3. Cluster reload trio (`reloadCache`/`broadcastReload`/`subscribeToEvents`) copy-pasted ×5 — utility extraction | net LOC −95 | risk low | effort S
- Locations: `groups.ts:260-303`, `sites.ts:147-178`, `approvals.ts:255-289`,
  `classificationLevels.ts:39-68`, `locales.ts:449-486`. `broadcastReload()` is literally
  `await this.reloadCache(); WIKI.events.outbound.emit('<name>')` in all five; `subscribeToEvents()`
  is literally `WIKI.events.inbound.on('<name>', () => this.reloadCache())` in all five; each repeats
  the same ~10-line "never call from inside reloadCache or it echoes" comment (three say "mirrors
  groups.ts exactly"). Only the event-name string and `reloadCache`'s body differ. Not the same shape
  (leave out): `glossary.ts:707-737` and `navigation.ts:586-598` are per-site `{ siteId }`
  *invalidates*, not whole-cache reloads.
- Proposed: `helpers/clusterCache.ts` — `abstract class ClusterReloaded { protected abstract readonly
  reloadEvent: string; abstract reloadCache(): Promise<void>; broadcastReload(); subscribeToEvents() }`
  (erasable syntax only). Five models `extends` it and delete two methods + comments each.
  `broadcastReload` becoming public everywhere is harmless (groups/locales already are, called from
  `tasks/simple/import-content.ts` / `update-locales.ts`).
- Test coverage: DB-backed `broadcastReload` describes at `groups.test.ts:1380`,
  `approvals.test.ts:2294`, `classificationLevels.test.ts:315`, plus `locales.test.ts`, `sites.test.ts`;
  `core/db.test.ts` covers the inbound echo.

### F4. contentSync.ts: five production-dead reader methods + one query written twice — dead code | net LOC ≈ −110 | risk low | effort S
- Zero production callers (grep `contentSync\.` across `backend/` minus tests hits only
  `forgetContent`/`forgetContentBatch` (assets.ts:1178/1220, pages.ts:1928/2024), `getTargetSummary`
  (api/storage.ts:98), `purgeOrphaned` (tasks/simple/purge-content-sync-state.ts:8),
  `recordSuccess`/`recordFailure` (tasks/simple/dispatch-storage.ts)):
  `getState` `contentSync.ts:86-106`, `getStatesForContent` `108-124`, `getStatesForTarget` `126-134`,
  `getOutOfDatePages` `321-350`, `getOutOfDateAssets` `352-383`. With them go `ContentSyncStateRow`
  (16-28), `OutOfDateContent` (30-35), `SYNC_CONTENT_TYPES`/`SYNC_DIRECTIONS` (9, 13 — only their
  derived types are used). `docs/variances.md:1257` mentions `getStatesForTarget` and needs a touch.
- Also: `countOutOfDatePages` (391-418) and `countOutOfDateAssets` (424-453) are the same LEFT JOIN
  with `pagesTable`/`'page'` ↔ `assetsTable`/`'asset'` swapped → one `countOutOfDate(contentType, …)`.
- Tests: `contentSync.test.ts` (27 DB-backed tests) uses the five as read-back oracles at
  :115,129,154,172,180,189,204,210-246,308,309,409,449-460,496,618,620,643,644,665 → read rows back
  via `fixtures.db.select().from(contentSyncStateTable)` instead (+~15 test lines).

### F5. pages.ts + assets.ts: ten `hooks.emit` + `storage.dispatch` pairs, and the cache-invalidation trio ×5 — utility extraction | net LOC ≈ −60 | risk low | effort S
- Pairs (same event, near-identical payload: hooks gets `metadata`, dispatch gets `kind`/`fileSize`
  for assets): `pages.ts:1180-1194` (create), `1463-1488` (edit), `1661-1678` (rename), `1931-1944`
  (delete), `2034-2047` (deleteOrphaned); `assets.ts:371-387`, `470-486`, `1140-1155`, `1180-1193`,
  `1225-1239`. ~15 LOC each.
- Invalidation trio `glossary.invalidateCache(siteId)` + `this.invalidateSitemapCache(siteId)` +
  `invalidateGraphCache(siteId)`: `pages.ts:1197-1200`, `1461/1492/1499`, `1654-1657(+1867)`,
  `1919-1924`, `2017-2021`.
- Proposed: `announce(event, siteId, data, { metadata?, dispatchExtra? })` (in `models/hooks.ts` or a
  private in each model) that emits then dispatches — payloads must stay byte-identical (webhook
  consumers and `dispatchStorage` jobs read them; `pages.test.ts:953-963` asserts the create pair's
  exact payloads, `assets.test.ts:574-674` asserts both calls). Plus a private
  `pages.invalidateSiteCaches(siteId, { glossary })`.

### F6. pages.ts: validation blocks duplicated between create / update / move — utility extraction | net LOC ≈ −60 | risk low | effort S
- Duplicate-path probe (`select({id}).where(siteId, locale, path[, ne id]).limit(1)` → `pageDuplicatePath` 409):
  `pages.ts:1048-1057` (create), `1757-1771` (move primary), `1785-1804` (move twins); the alias
  variant `2325-2336`. → `assertNoPageAt(siteId, locale, path, exceptId?)`.
- Reserved-locale first segment: `1012-1019` vs `1723-1732` (also `tree.ts:869, 1102`).
- Active-locale check (`WIKI.sites[siteId]?.config?.locales?.active ?? [defaultLocale(siteId)]` +
  `pageInvalidLocale`): `1020-1033` vs `1736-1747` (`navigation.ts:461` reads the same expression).
- Classification validity + floor: `911-924` (`resolveCreateClassification`) vs `1319-1333`
  (`updatePage`) — identical 14 lines (the only two `classificationInvalid`/`classificationBelowFloor`
  throw sites in the repo).
- Proposed: `assertPathNotReservedLocale(path)`, `assertLocaleActive(siteId, locale)` (in
  `helpers/common.ts` next to `defaultLocale`), `assertClassificationMeetsFloor(requested, floorId)`.
- Test coverage: `pages.test.ts` create/update/move suites cover every one of these refusals
  (duplicate path, reserved segment, inactive locale, below-floor).

### F7. `err.cause?.code === '23505' || err.code === '23505'` ×9 — utility extraction | net LOC −10 (drift risk removed) | risk low | effort S
- `pages.ts:1140, 1841`; `users.ts:774`; `glossary.ts:205, 292`; `blocks.ts:628`;
  `tree.ts:954, 984, 1743`. Predicate identical in all nine; handling differs per site (users.ts
  returns a skip result). Within tree.ts the three handlers are also identical
  (`treeEntryDuplicate` at 955-959, 985-989, 1744-1748, plus `resolveName:1810-1814`).
- Proposed: `helpers/common.ts#isUniqueViolation(err: unknown): boolean` (no such helper exists —
  grep `23505|isUniqueViolation|UNIQUE_VIOLATION` in `helpers core` is empty); tree.ts adds a private
  `duplicateEntryError()`.

### F8. tree.ts: folder-404 block ×6, `listDescendantPages` ⊂ `listDescendants`, folder-duplicate probe ×2 — utility extraction + dead | net LOC ≈ −85 | risk low | effort S
- Folder 404 (`const folder = await this.getFolderById(...); if (!folder) throw new CustomError('treeInvalidFolder', …, 404)`):
  `tree.ts:779-782`, `803-804`, `1017-1020`, `1070-1073`, `1359-1362`, `1427-1430` (byte-identical
  throw at all six; `858-861` is the `treeInvalidParent` variant, leave). → `private requireFolderById(id, siteId, db)`;
  public `getFolderById` stays (nullable form used by `api/tree.ts:475,564,638,748`, `api/assets.ts:180`).
- `listDescendantPages` `1013-1049` is a strict subset of `listDescendants` `1354-1412` (same
  `<@ childPathOf(folder)` query, same pages join; the latter left-joins and partitions
  `{pages, assets}`, returning a superset shape). Sole caller `api/tree.ts:669` reads only
  `.path/.tags/.classification` → use `(await tree.listDescendants(folderId, siteId)).pages`, delete
  the method and its mocks at `api/tree.test.ts:52,342,365`. No model-level test exists for it;
  `tree.test.ts:764-895` covers `listDescendants`.
- `treeFolderDuplicate` 409 probe+throw: `893-901` (createFolder) ≡ `1125-1133` (renameFolder), with
  the preceding probes `880-892` / `1111-1124` identical except `ne(id)`. →
  `assertFolderNameFree(siteId, locale, folderPath, name, exceptId?, db)`.
- `tree.getById` (675-686) has zero external callers (`grep "tree\.getById("` → nothing outside
  tests; the inventory's ext=15 is name collision) and is the one unscoped `tree` lookup — mark
  `private` (internal callers 1607, 1652).
- Test coverage: `tree.test.ts:337-465, 705-737, 764-895, 897-935, 936-1060`.

### F9. Small verbatim dead methods / fields — dead code | net LOC ≈ −75 | risk none | effort S
Each verified by repo-wide grep (backend, frontend/src, blocks, e2e, docs); hits listed.
- `approvals.countSubmissions` `approvals.ts:958-966` — only `approvals.test.ts:1928,1967,2699,2942,2945`
  (assertion helper). Tests switch to `WIKI.db.$count(pageEditSubmissions, …)`.
- `sessions.getByUser` `sessions.ts:10-18`, `sessions.clearAllSessions` `:66-72` — definitions only;
  `rotateSecret:149` already inlines the same `delete(sessionsTable)`.
- `authentication.getStrategy` `authentication.ts:177-180` — definition only (the only other hit is
  `docs/migration/vendor/export-bundle/models-authentication.js:33`, a vendored 2.x file, not an import).
- `blockCredentials.deleteSiteCredentials` `blockCredentials.ts:155-159` — definition only.
- `commentProviders.canonicalPageUrl` `commentProviders.ts:124-127` (test-only:
  `commentProviders.test.ts:373-416`; the only in-model use of `helpers/common.ts#requestOrigin`) and
  `getActiveProvider` `:356-363` (test-only `:78,214-242`; the comment at `:452-455` describes a
  read-side fallback `api/comments.ts:248` never takes — it calls `getSiteProviders({ mask: true })`).
- `blockCredentials.deleteSiteCredentials`'s doc claims `sites.deleteSite()` calls it — false;
  `sites.ts:504` deletes `blockCredentialsTable` inline in its transaction.
- `rendering.sanitize` `rendering.ts:760-770` — `private`, no production caller (`postProcess` calls
  `sanitizeOptions` directly at 502/507/530); `rendering.test.ts:317,425,441` reach it via `as any`.
  Delete (tests call `sanitizeHtml(html, sanitizeOptions(...))`) or promote as part of F11.
- `assets.AssetAtPath` `assets.ts:128-130` — extends `Asset` adding `locale`, which `Asset` already
  has at :121; no reference outside the file.
- `approvals.ReviewerScope.actor` `approvals.ts:65-74` — doc says "effectively unread"; no `.actor`
  read in the model (consumers take `actor` positionally); writers at `:582,584` and `api/approvals.ts:66,89`.
- `groups.mayHoldPermissionSomewhere` `groups.ts:595` — the inner `siteId === null || rule.sites…`
  clause is exactly `ruleMatchesSite` (`helpers/siteRules.ts:59-61`) which the filter at 587-589
  already applied; can never be false. One line.
- Exported-but-only-used-in-file consts (drop `export`, 0 LOC): `rendering.slugifyHeading:471`,
  `flags.FLAG_KEYS:24`, `import.PANDOC_IMPORT_FORMATS:102`/`IMPORT_EXTENSION_FORMATS:164`,
  `siteImport.IMPORT_MAX_ENTRY_BYTES:70`/`IMPORT_MAX_TOTAL_BYTES:81`, `groups.GROUP_RULE_MATCH_KINDS:27`,
  `apiKeys.SigningCertificates:23`, `glossary.GLOSSARY_EXPORT_FORMAT_VERSION:64`,
  `pageviews.pageviewWindows:24`, `tree.TREE_UPDATE_CHUNK_SIZE:19` (test-used — keep).

### F10. users.ts: smaller verbatim duplicates — utility extraction | net LOC ≈ −120 | risk low | effort S
- `register():2408-2421` re-implements `assertAllowedProviderEmail():2175-2191` verbatim (regex
  try/compile, warn, `ERR_EMAIL_NOT_ALLOWED`). −14.
- Pre-flight triple (`getById`→`ERR_INVALID_USER`, `auth[strategyId]`→`ERR_INVALID_STRATEGY`,
  `tfaIsActive`→`ERR_TFA_NOT_ACTIVE`): `1493-1503`, `1544-1554`, `1671-1684`, `1706-1716`; two-check
  variants `1373-1380`, `2782-2789`. → `requireStrategyAuth(userId, strategyId, { tfaActive? })`
  returning `{ user, auth, entry }`. −40.
- Local-user row literal (auth entry with six keys, `meta {location,jobTitle,pronouns}`, `prefs
  {timezone,dateFormat,timeFormat,appearance,cvd}`) written ×3: `createUser:574-606`,
  `importLocalUser:736-770`, `init:1843-1873`. The doc at 637-642 explains why import can't *call*
  createUser (double hashing) — a `localUserRow({ email, name, passwordHash, … })` builder serves all
  three (createUser hashes first). −45.
- Provider-reshaping loop `getUserDetail:493-520` vs `getProfileAuthMethods:1263-1290` (same
  strategy/definition lookup and `{authId, authName, strategyKey, strategyIcon, config:{…}}` build;
  profile adds `enforceTfa`/`isPasswordLoginEnabled`/`canDisablePasswordLogin`). → one
  `describeLinkedProviders(user, { forProfile })`. −20.
- `escapeLikePattern` byte-identical in `users.ts:182-189` and `groups.ts:131-138` (third copy
  `modules/search/db/search.ts:93-95` as `escapeLikePrefix`). → `helpers/common.ts`. −14.
- `bcrypt.hash(x, 12)` literal at `users.ts:567,1227,1336,1849,2922,3052`, `pages.ts:1119,1297`,
  `migration/importers/users-groups.ts:529`, while `users.ts:250` and `pages.ts:25` each declare a
  `…BcryptRounds = 12`. One shared const (0 LOC, consistency).
- Test coverage: `users.test.ts` register/provider-email, 2FA preflights, createUser/importLocalUser
  (`users-import.test.ts`), getUserDetail/getProfileAuthMethods; `groups.test.ts`/`users.test.ts`
  filter tests for the LIKE escape.

### F11. rendering.ts — split by responsibility — long-file split | net LOC ≈ −10 | risk low | effort M
- Three concerns; external surface is only `postProcess`, `isAvailable`, `ensureCanRender`,
  `queuePage`, `drainQueue`, `RenderPermissions`, `TocNode`:
  (a) **sanitizer policy** — allowlist constants `137-450` (314 LOC), `blockAllowances:606-644`,
  `unwrapOrphanedChildBlocks:658-676`, `sanitizeOptions:686-751`, `sanitize:760-770` (≈ 480 LOC,
  pure given `(permissions, block definitions)`) → `helpers/htmlSanitizePolicy.ts`;
  (b) **post-process passes** — `postProcess:494-541`, `stripEditorArtifacts:775-788`,
  `liftIconChildren:802-810`, `inlineIcons:829-865`, `iconSvg:882-962`, `anchorHeadings:970-996`,
  `nestHeadings:1004-1021`, `extractText:1029-1033`, `extractInternalLinks:1045-1071`,
  `slugifyHeading:471-482` (≈ 330) — stays as `models/rendering.ts`;
  (c) **headless render queue** — `RENDER_*`/`withRenderTimeout:38-69`, `PageRenderer:103-126`,
  `isAvailable`/`ensureCanRender:1073-1105`, `queuePage:1118-1158`, `drainQueue:1171-1191`,
  `renderQueuedPages:1205-1294`, `discardRenderer:1303-1309`, `resolveSiteOrigin:1321-1324`,
  `createRenderer:1336-1388` (≈ 320) → `models/renderQueue.ts` (callers: `pages.ts:2083/2100`,
  `tasks/simple/render-pages.ts:11`, `models/index.ts`).
- Test coverage: `rendering.test.ts` (32 tests; postProcess 108-300/372-409/570-633, policy
  301-371/410-699, resolveSiteOrigin 700-717 via private access), `rendering-block-toggle.test.ts`.

### F12. users.ts — split by responsibility — long-file split | net LOC ≈ 0 | risk med | effort M
- Four concerns in one 3205-line class: (a) account CRUD/list/profile/avatar/groups `379-1116`,
  `1757-1903` (≈ 800); (b) local credentials, 2FA, recovery codes `1125-1735` (≈ 610); (c) login /
  register / provider flows and their continuations `1905-3083` (≈ 1180); (d) `userKeys` tokens
  `3121-3202` + `countTfaFailure:215-239` (≈ 100).
- Proposed: `users.ts` (a), `userCredentials.ts` (b + d), `login.ts` (c) — registered in
  `models/index.ts`; callers `WIKI.models.users.login/register/loginTFA/…` in `api/authentication.ts`
  and `mcp/` re-point. Do F2/F10 first — they shrink (b) and (c) by ~230 lines and make the seam
  obvious. `users.test.ts` (3587 lines) splits along the same lines.

### F13. approvals.ts — split by responsibility — long-file split | net LOC ≈ 0 | risk med | effort M
- (1) rules CRUD + cache + matching: types 19-46, 170-238; `246-433`, `deleteRule:1696-1707` (≈ 300);
  (2) who-may-do-what: `435-599`, `777-825` (≈ 220); (3) submission lifecycle: `601-775`, `958-1162`,
  `827-858`, `1164-1589`, `1658-1694` (≈ 800); (4) notifications: `860-956`, `1591-1656` (≈ 160).
- Proposed: `approvalRules.ts` (1), `approvals.ts` (2+3), `approvalNotifications.ts` (4). Callers:
  `api/approvals.ts` (7 rule-route refs), `index.ts:260`, `core/maintenance.ts:66`, `core/db.ts:479`.
- Related extraction (behaviour-neutral only with a flag): `approvals.matchesPage:408-433` +
  `parseTags:207-212` re-implement `helpers/pageRules.ts:224-261` / `ruleTags:167-172` minus the
  case-fold (#2182) and regex memoisation (#2267). Extract `matchPathOrTags(match, rulePath,
  pagePath, tags, { foldCase })` with `foldCase:false` for approvals; adopting the fold is a
  behaviour change (file separately). −20.
- `api/approvals.ts#reviewerFor:60-92` rebuilds the same `ReviewerScope` as
  `pageViewerState:569-584` → `approvals.reviewerScopeFor(req, siteId, page?)`. −18.
- Test coverage: `approvals.test.ts` (60 tests, DB-backed) — rule CRUD, pageViewerState (:2224),
  matching (:331, :1370), broadcastReload (:2294); `api/approvals.test.ts` for reviewerFor.

### F14. assets.ts — lift the serving cache; dedupe the asset projection — split + extraction | net LOC ≈ −35 (split neutral) | risk low | effort S–M
- `assets.ts:753-1095` (343 LOC) is fenced by the file's own `// == SERVING CACHE ==` banner
  (`resolveAssetPath`, `forgetPath`, `forgetAllPaths`, `governingTarget`, `directUrlFor`,
  `readContent`, `contentCachePath`, `read/writeContentCache`, `dropCachedContent`, `sweepCache`,
  `purgeCache` + fields 224-230, consts 25-37). CRUD half calls only `forgetPath`/`dropCachedContent`.
  22 of `assets.test.ts`'s 28 tests (116-420) are about this half. → `models/assetServing.ts`.
- `getAsset:513-544` and `getAssetByPath:596-633` select the same 12 columns and apply the same three
  fix-ups (`fileSize ?? 0`, `decodeTreePath`, `Boolean(hasPreview)`) → module-level `assetSelection` +
  `toAsset(row)`. −25.

### F15. groups.ts re-declares users.ts types and projection — type dedupe | net LOC −30 | risk low | effort S
- `groups.ts:113-129` (`GroupUser`, `GroupUserPage`) are field-for-field `users.ts:46-63`
  (`UserCore`, `UserPage`) — both doc-commented "mirroring the `UserCore` API schema"; neither has an
  external importer (inventory ext=0). `getGroupUsers:965-976` inlines the ten columns of
  `users.ts:316-327 userSelection` (module-private). Both paginate with the identical
  `Promise.all([select…limit.offset, select({ total: count() })])` → `{ total, users }`
  (`groups.ts:963-993` vs `users.ts:457-467`).
- Proposed: export `userSelection`, `UserCore`, `UserPage` from users.ts; groups.ts imports them.
- Test coverage: no `getGroupUsers` describe in `groups.test.ts`; check `api/groups.test.ts` before
  relying on it.

### F16. Offset-pagination + count idiom ×6 — utility extraction | net LOC ≈ −40 | risk low | effort S
- `users.ts:457-471`, `groups.ts:963-993`, `auditLog.ts:292-294`, `hooks.ts:281-283`,
  `jobs.ts:309-311`, `pages.ts:2211-2230` — each ~12 lines of
  `Promise.all([select(proj).from(t).where(w).orderBy(o).limit(l).offset(o), select({ total }).from(t).where(w)])`.
  Half use `count()`, half `sql<number>\`count(*)::int\``.
- Proposed: `helpers/pagination.ts#paginate({ query, where, page|offset, limit })` → `{ total, rows }`.
  Honest note: the approvals/groups fork judged this a 6-line wrapper not worth it on its own; it
  earns its place only if all six migrate in one pass and the two `count` spellings are unified.

### F17. tree.browse ↔ navigation.generateFromTree share the `holdsVisiblePages` EXISTS — utility extraction | net LOC −25 | risk low–med | effort S
- `tree.ts:578-605` (aliases `descendantTree`/`descendantPage`, `childPathPrefix`, `exists(...)`) vs
  `navigation.ts:645-665` (same with `navGen*` aliases; `publicOnly` hard-coded `true`);
  row select `tree.ts:612-635` vs `navigation.ts:667-695` (nav projection is a superset, adds a
  redundant `ne(treeTable.type, 'asset')` at :689 — the following `or(folder, page ∧ …)` already
  excludes assets). `navigation.ts:602-606` says it mirrors `browse()`; make it literal.
- Proposed: export `holdsVisiblePagesUnder(encodedParentPath, publicOnly, aliasSuffix): SQL` from
  tree.ts; both call it. Row selects stay separate (different projections).
- Test coverage: `tree.test.ts:705-737, 936-1060`; `navigation.test.ts:988-1308, 2904+`.

### F18. pages.ts — shed the classification cluster — long-file split | net LOC ≈ 0 | risk low | effort S
- `parentClassifications:659-704`, `parentClassification:872-894`, `resolveCreateClassification:903-928`,
  `descendantsBelowFloor:935-960`, `bulkSetClassification:979-999`, `classificationReport:2176-2191`,
  `listByClassification:2199-2231` (≈ 300 LOC) only touch `pagesTable.classification` and
  `classificationLevels.byId/meetsFloor/defaultLevel/list`. Coupling back into pages.ts is one method
  (`parentClassification`, called from `moveOnePageInTx:1551`, `updatePage:1326`,
  `resolveCreateClassification:909`). → `models/pageClassification.ts`; leaves pages.ts at ≈ 2150
  with a clear read (425-858) / write (1006-2050) / render-glue (2073-2142) shape that does not need
  a further split.

### F19. Seven model interfaces restate a schema table column-for-column (+ `Pick`/`Omit` cases) — type dedupe | net LOC −115 | risk low (type-only) | effort S
- Exact restatements, each forcing `as X` casts on a plain `select()`:
  `comments.ts:24-37 Comment` ≡ `comments` (schema 841-866), casts at `:238,267,279`;
  `apiKeys.ts:85-108 ApiKey` + `:165-178 keySelection` (lists every column, so `.select(keySelection)` ≡ `.select()`) ≡ `apiKeys` (39-108), casts `:284,306,387`;
  `hooks.ts:70-85 Hook` + `:141-155 hookSelection` ≡ `hooks` (506-526; `state` already `hookStateEnum`), casts `:225,237`;
  `classificationLevels.ts:11-17 ClassificationLevel` ≡ `classificationLevels` (408-415), casts `:41,175,198`;
  `contentSync.ts:17-28 ContentSyncStateRow` ≡ `contentSyncState` (261-280), casts `:105,123,133` (all three casting methods are dead per F4).
- `Pick`/`Omit` one-liners: `blockCredentials.ts:10-17 BlockCredential` = `Omit<…,'secret'>`;
  `glossary.ts:16-24 GlossaryTerm` = `Omit<…,'siteId'>`; `approvals.ts:88-94 PageEditSubmission` =
  `Pick<…, 5>`; `approvals.ts:171-190 ApprovalRule` = `Omit<…,'siteId'> & { match: ApprovalMatchMode }`
  (casts `:266,316,362,397`; `ruleSelection:214-225` stays); `users.ts:46-57 UserCore` = `Pick<…, 10>`
  (keep the name — it mirrors the API schema); `tags.ts:6-9 Tag` = `Pick<…,'tag'|'usageCount'>`;
  `locales.ts:53-61 SideloadLocalePack` = `Pick<…, 7>` (needs `.$type<Record<string, unknown>>()` on
  `locales.strings`).
- `jobs.ts:17,273,399`, `search.ts:229`, `icons.ts:844`, `tree.ts:164`, `pages.ts:1540` already use
  `typeof t.$inferSelect`; `sites.ts:299`, `storage.ts:778`, `authentication.ts:435` use
  `Partial<typeof t.$inferInsert>` — the pattern to copy. Where an interface narrows a jsonb/varchar
  (`ApprovalRule.match`, `SideloadLocalePack.strings`, `IconSetRow.info`), prefer `.$type<…>()` on the
  column, but only if the type can be imported into `schema.ts` without pulling a model in
  (`approvalMatchModes` lives at `approvals.ts:25` — move it to `db/` or keep one intersection).
- **Genuinely transformed — leave**: `pageHistory.ts` entry types, `comments.ts ThreadedComment`/`AdminComment`,
  `checklists.ts` summaries, `pageWatching.ts WatchedPage`, `pageWatchEvents.ts` inbox types,
  `authentication.ts AuthStrategy` (`?? []` + `buildConfig`), `storage.ts StorageTarget`,
  `assets.ts Asset`, `tree.ts TreeRow` (nullability differs, drops nav columns), `pages.ts Page`,
  `groups.ts GroupRule`, `navigation.ts NavigationItem` (jsonb element shapes), `icons.ts IconSetRow`
  (−8 at best), `ApiKeyIdentity`, `HookDelivery`, `AuditLogEntry`, `SearchResult`.
- LOC: ~150 interface/projection lines removed, ~25 added, ~14 casts deleted; 12 files.
- Test coverage: every listed file has a co-located `*.test.ts` that compiles against the types;
  `npm run typecheck` is the whole verification. `api/schemas/` references these names in doc
  comments only — grep before renaming.

### F20. pageHistory.ts builds the same entry projection + author mapping + keyset scaffold three times — utility extraction | net LOC −45 | risk low | effort S
- Projection `{ id, action, via, changedFields, reason, versionDate, locale, path, title }` at
  `pageHistory.ts:398-407` (`list`), `525-534` (`getVersion`), `619-628` and `654-664`
  (`listRecoverable`); `leftJoin(usersTable, …)` + `authorId/authorName` at `408-412`, `537-542`,
  `665-669`; row→entry mapping (`changedFields ?? []`, `reason ?? ''`, `author: { id ?? null, name ?? '' }`)
  at `438-453`, `556-573`, `689-705`. `getVersion` adds `content`/`meta`/`authorEmail`;
  `listRecoverable` lifts `tags`/`classification` out of `meta`; the nine base fields are byte-identical.
- Keyset cursor `after ? or(lt(versionDate), and(eq(versionDate), lt(id))) : undefined` +
  `limit(n+1)` + `hasMore`/`nextCursor` at `417-426, 431-435, 454-455` and `671-677, 680-684, 707-708`.
- Proposed: module-level `entrySelection`, `toEntry(row)`, `keysetAfter(table, after)` +
  `paginate(rows, limit, encode)`.
- Test coverage: `pageHistory.test.ts` (622 lines — list cursor, getVersion, listRecoverable, recover).
- Checked: `record()` vs `auditLog.record()` (`auditLog.ts:186-212`) — different data flow, only a
  4-line log-and-swallow `try/catch` shared. Not a finding.

### F21. Puppeteer availability / quiet-close / timeout race copy-pasted across diagramRender / pdfExport / rendering — utility extraction | net LOC −40 | risk low | effort S
- `helpers/puppeteer.ts` already owns the launch; the wrappers are triplicated:
  `isAvailable()` (`getDefinition('puppeteer')` + `isInstalled`) byte-identical at
  `diagramRender.ts:161-164`, `pdfExport.ts:121-124`, `rendering.ts:1075-1078`;
  `ensureCan*()` (503 `CustomError` if unavailable) at `166-174`, `126-134`, `1080-1093`;
  `discardBrowser()` (quiet `close()` + debug log) at `416-422`, `277-283`, `1296-1302`;
  the timeout race (`Promise.race` + `setTimeout` reject 504 + `clearTimeout` in `finally`) at
  `diagramRender.ts:393-409` (`withTimeout`, generic), `pdfExport.ts:246-267`
  (`waitForBlocksToSettle`, hard-coded to one call), `rendering.ts:53-69` (`withRenderTimeout`).
- Proposed: add to `helpers/puppeteer.ts`: `isPuppeteerAvailable()`, `assertPuppeteerAvailable(errorName, message)`,
  `closeQuietly(closable, label)`, `withTimeout<T>(work, ms, errorName, message)`.
  `waitForBlocksToSettle` becomes a 5-line `withTimeout(page.evaluate(blockSettleScript, …), …)`.
- Test coverage: `diagramRender.test.ts` (658, explicit timeout cases), `pdfExport.test.ts` (310),
  `rendering.test.ts` (718) all stub `launchPuppeteerBrowser`/`extensions.isInstalled`.
- Rejected as part of this: the `newPage`/`setContent`/`evaluate` bodies differ per use; no shared
  "render session" abstraction.

### F22. `export.purgeExpired` ≡ `siteImport.purgeExpired`; `mail.ts` send scaffold ×4 — utility extraction | net LOC −54 | risk low | effort S
- `export.ts:199-222` and `siteImport.ts:389-412` are line-for-line identical (`readdir` with
  ENOENT→0, `cutoff = Now.subtract({ seconds: TTL })`, `stat`, `unlink` where `mtime < cutoff`,
  count); only the directory getter and TTL const differ. `deleteExport:189-191` ≡ `deleteUpload:378-380`.
  → `helpers/fsPurge.ts#purgeFilesOlderThan(dir, ttlSeconds)`. −24. Tests: `export.test.ts`,
  `siteImport.test.ts` both exercise `purgeExpired` with real temp dirs.
- `mail.ts`: `sendVerifyEmail:252-269`, `sendWelcomeEmail:336-354`, `sendPasswordResetConfirmed:365-380`,
  `sendRegistrationAttemptNotice:393-412` are the same `buildLink` → `params` → `send({ subject:
  resolveString(locale,'<key>.subject'), text: …, html: … })` scaffold, differing only in template key
  and link path (`sendForgotPassword:285-317` appends a signature; `sendTestEmail:426-450` differs).
  → `private sendTemplate(to, locale, key, params, { textSuffix?, htmlSuffix? })`. −30. Tests:
  `mail.test.ts` (980) asserts the `send()` payload per method.

## Files ranked by size with a one-line verdict

| File | LOC | Verdict |
| --- | --- | --- |
| `users.ts` | 3205 | **split** (F12) after F2/F10 remove ~230 lines of repetition |
| `pages.ts` | 2470 | **leave as one file** after F5/F6/F18 (≈ −120 and the classification cluster out) |
| `tree.ts` | 1870 | **leave** — ~330 lines are doc; F7/F8 drop ~90; a read/mutation split cuts `getFolderById`/`countTowardsFolderAt` on the seam |
| `approvals.ts` | 1710 | **split** (F13) into rules / submissions / notifications |
| `db/schema.ts` | 1685 | **leave** — ~55% doc comments; the single source F19 points everything at; only a few `.$type<…>()` annotations |
| `rendering.ts` | 1391 | **split** (F11) — sanitizer policy / post-process / render queue; F21 |
| `assets.ts` | 1244 | **split** (F14) — serving cache out; `assetSelection`/`toAsset` |
| `navigation.ts` | 1131 | **leave** — `updateNavigation` is long but linear with a dedicated test matrix; F17 only |
| `storage.ts` | 1127 | **leave** as a file; F1 lifts ~90 of its lines into the registry helper |
| `groups.ts` | 1067 | **leave**; F3/F10/F15 |
| `pageHistory.ts` | 945 | **leave**, extract (F20) — one responsibility, just repetitive |
| `icons.ts` | 883 | **leave** — four cache tiers in one coherent class; only a 12-line atomic-write overlaps `assets.ts:951-963` (below the bar) |
| `glossary.ts` | 849 | **leave**; F7, F19 (`replaceAllRows`/`replaceAllRowsIn`, `recordVersionIn` are the tx/no-tx pair pattern, not duplication) |
| `search.ts` | 744 | **leave**; F1 |
| `blocks.ts` | 688 | **leave**; F7 |
| `comments.ts` | 657 | **leave**; F19 |
| `siteImport.ts` | 642 | **leave**; F22 (`readArchive`'s 170 lines of streaming-tar-with-limits earn their place) |
| `sites.ts` | 634 | **leave**; F3 |
| `mail.ts` | 608 | **leave**; F22 |
| `authentication.ts` | 601 | **leave**; F1, F9 |
| `apiKeys.ts` | 570 | **leave**; F19 (−38) |
| `contentSync.ts` | 491 | **shrink** (F4) — a fifth of the file is test-only reads |
| `diagramRender.ts`, `pdfExport.ts` | 425, 286 | **leave**; F21 |
| everything else ≤ 500 | — | leave (sessions/blockCredentials/commentProviders: F9; hooks/classificationLevels/tags/locales: F19) |

## Things I checked and rejected (so nobody re-checks them)

- **"8 `onConflict` sites in tree.ts"** — all are the `onConflict: 'error' | 'suffix'` *parameter* of
  `addEntry`/`resolveName` (`tree.ts:1531,1588,1681,1694,1716,1778,1786,1809`). tree.ts has no
  Drizzle upsert at all. navigation.ts's four real upserts (`435, 807, 1026, 1042`) have three
  different semantics; approvals' two (`734`, `1312`) are bespoke. No shared upsert helper falls out.
- **A generic `findOne(table, where)`/"select by site and id" helper** — the 60-odd `.limit(1)` sites
  differ in projection and predicate; tree.ts's seven `(siteId, locale, folderPath, fileName[, type])`
  lookups split into two families (existence probes vs row fetches) and a `findEntry({...})` would be
  25 lines to save 30 and make each site less readable. navigation.ts's five `id+siteId` reads select
  five different projections; a shared full-row read would over-fetch `items` jsonb. Rejected.
- **Soft-delete helper** — there is no `isDeleted` column or pattern anywhere in models (grep empty).
- **History-row insertion helper** — `pageHistory.record()` (299-385) is already the single writer;
  every model calls it. Nothing to extract.
- **`WIKI.cache` invalidation helper** — glossary/navigation/locales/liveData/pages each key their
  own cache differently (per-site, per-locale, TTL); only the pages.ts trio (F5) repeats.
- **`getEntry` (navigation.ts:882-893) vs `tree.getById`** — siteId-scoped + throws vs unscoped +
  null. Direction noted in F8; not a duplicate.
- **API/model duplication of nav mode logic** — `api/navigation.ts` is a pass-through (one model call
  per handler at :82,131,180,235,289,349,411,489,583).
- **`addPage`/`addAsset` vs `addEntry`; `renameFolder` vs `renameEntry`;
  `refreshDescendantPaths`/`fireDescendantMoveSideEffects` vs `pages.recordPageMoveSideEffects`** —
  deliberate, commented asymmetries (tree has no actor); folding needs a behaviour change.
- **`groups.checkAccess`/`checkSiteAccess` vs `helpers/pageRules|siteRules`** — guards + one
  `resolve*Rule` call; no duplicated evaluation.
- **`groups.createGroup` vs `createGroupFromImport`** — 10 shared lines, doc explains the split.
- **`approvals.getActorGroupIds:443-448` vs `groups.groupIdsForRequest:342-350`** — identical except
  the latter honours `req.apiKey.groupIds`; unifying changes API-key behaviour on approval routes
  (`api/approvals.ts:70,810,895`, `api/blocks.ts:51`). Behaviour — flag for triage, not consolidation.
- **`approveSubmission:1198-1449` vs `pages.updatePage`** — delegates to `updatePage` at :1415; owns
  only the vote/threshold/claim-revert protocol. Not a rewrite candidate.
- **`requiredApprovalsForPage:816-825` re-inlined at 1086-1091** — comment at 1074-1077 says the
  inline is deliberate (one `getRules` read per queue).
- **classificationLevels.ts ↔ pages.ts classification methods** — no shared logic; pages calls
  `byId/meetsFloor/defaultLevel/list`. Only a relocation (F18), no LOC saving.
- **`pages.queueRerender`/`enqueueRerender`/`storeRender` vs the render queue** — thin delegations.
- **`icons.renderSvg`/`renderInlineSvg` vs `rendering.iconSvg`** — layered, not duplicated.
- **`storage.getSiteTargets` vs `commentProviders.getSiteProviders`** — same 8-line skeleton, almost
  no shared fields; nothing readable to extract.
- **`assets.upload` vs `replace`** — `replace` is `upload`'s overwrite branch (sole caller :319);
  only the emit/dispatch pair (F5) is shared. The hand-built `Asset` literals (389-402, 492-506) have
  no row for `toAsset`.
- **`contentSync.recordSuccess`/`recordFailure`** — ~8 overlapping lines; a helper is as long.
- **`assets.deleteAsset`/`renameAsset` vs `tree.deleteEntry`/`renameEntry`** — delegation.
- **`blocks.syncSite`** — different operation from storage/commentProviders' `syncSite`.
- **`tt.tree IN ('page','folder')` in navigation's cascade CTE (`:1102,1110`)** — looks like a typo,
  is correct: the `type` column is physically named `tree` (`db/schema.ts:1552`).
- **`ancestorNavId`'s `(result.rows ?? result)`** — one-token defensive cast, not a compat shim.
- **`relations.ts`** — 20 lines, used by `WIKI.db.query.users/userKeys` at `users.ts:2482, 2867, 3156`
  (the only relational-API uses). Live.
- **Exported test-only helpers** (`computeCompleteness`, `parseSideloadLocalePack`,
  `importBlockScript`, `mountBlockElementScript`, `extractDiagramScript`, `installRequest`,
  `buildInstallArgs`, `resolvePreference`, `wantsAction`, `isValidNavItemTarget`, `securityCspSeed`,
  `readArchive`, `matchRecoveryCode`, `DEFAULT_SETS`, `NOT_FOUND_CACHE_MAX`, `MAX_CONCURRENT_PANDOC`,
  `DEFAULT_THEME_COLORS`) — all used in-file and by their co-located tests. Not dead.
- **`docs/migration/vendor/export-bundle/models-authentication.js`** — vendored 2.x source parsed
  statically by `test/migration-export-bundle-doc.test.ts`, not an import target; its `getStrategy`
  hit does not keep `authentication.getStrategy` alive.
- **The `purge*` family as a helper** — `pageWatchEvents.purgeExpired:181-186`, `pageviews.purgeExpired:302-307`,
  `sessions.purgeExpiredSessions:170-175`, `rateLimits.purgeStale:113-118`, `users.purgeExpiredKeys:3199-3202`,
  `apiKeys.purgeRevoked:439-444`, `jobs.cleanHistory:411-426`, `auditLog.purge:338-360` (also writes an
  audit row), `comments.purgeGuestPii:310-333` (an UPDATE), `pageHistory.purge:896-906`. Each is one
  4–6 line `delete().where(lt(col, now() - interval))` on a different table/column/interval; a helper
  saves ~2 lines each and hides the one thing a reader wants to see. Reject. (F22's file-system purge
  pair is different — two 24-line functions that are line-identical.)
- **`icons.ts` disk cache vs `assets.ts` content cache** — different key scheme, eviction and read
  path; only the tmp+rename atomic write overlaps (`icons.ts:731-745` vs `assets.ts:951-963`, ~10 LOC).
- **`hooks.getDeliveryHistory` vs `jobs.getHistory`** — both page `jobHistory` but hooks filters on
  `payload->>hookId` and reshapes; 6 lines of pagination each.
- **`export.exportSite`'s seven `fs.writeFile(JSON.stringify(...))` calls (117-150)** — a local
  `writeJson` saves ~14 lines in one function; noted, not a finding.
- **`AuthStrategy`/`IconSetRow` as `$inferSelect`** — genuinely transformed; an `Omit & {}` is as long
  as the interface.
