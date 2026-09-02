# Backend API + controllers survey

Scope: `backend/api/*.ts` (33 route plugins, `index.ts`), `backend/api/schemas/*.ts` (34 files),
`backend/controllers/*.ts` (11 files). ~20.6k non-test lines, ~26k test lines in the same
directories. Every claim below was verified by reading the cited lines; all paths are relative to
`backend/`.

## Summary

- The area is in good shape on dead code: every export in `api/`/`controllers/` has a non-test
  importer, every registered JSON-schema `$id` is `$ref`'d somewhere, no `FIXME`/legacy shims. The
  one real dead branch is a set of `req.query.limit ?? N` fallbacks that AJV `useDefaults` already
  makes unreachable (F9).
- The dominant waste is **route-handler preambles copied by hand**: "does this site exist" (36
  copies, two spellings), "load the page / 404 / check permission / 403 / locked" (13 copies),
  "`manage:X` or `site:X` delegation" (5 identical functions), and `params:` JSON-schema blocks for
  `siteId`/`pageId` (~60 inline copies plus 6 files each redeclaring a `siteIdParam` constant).
  Together these are roughly 500–600 net lines of removable duplication at low risk (F1–F4, F6).
- `api/pages.ts` is a **helper module hiding inside a route file**: `actorFrom`/`mayOnPage`/
  `loadReadablePage` & co. (lines 110–372) are imported by 8 other route plugins,
  `controllers/collab.ts`, `mcp/`, and a helper test. Moving them to `helpers/` is the prerequisite
  for any split of `pages.ts` and also removes two inline re-implementations of `mayOnAsset` in
  `controllers/files.ts`/`thumb.ts` (F1).
- The four long files split cleanly by responsibility (F5), but **three structural tests scan
  `api/` non-recursively and `import()` every top-level `.ts` expecting a default route plugin**
  (`routeTags.test.ts:60`, `responseErrors.test.ts:53`, `index.test.ts:208`). A subdirectory split
  silently drops out of their coverage, and a non-route helper file dropped at `api/*.ts` breaks
  them. Any split must update those scanners in the same change.
- `system.ts` carries three copy-pasted GET/PUT "toggle a boolean config flag" pairs (~300 lines,
  F7) — the only feature-shaped rewrite candidate I would name; everything else is extraction.

## Existing shared utilities worth knowing (that this area's code should reuse)

- `helpers/common.ts`: `guardSiteEnabled(site, reply)` + `siteEnabledPreHandler` (already a
  plugin-level hook in `api/index.ts:62` — the natural home for a site-existence hook too),
  `resolveRequestSite`, `normalizeHostname`, `isValidUuid`, `normalizePagePath`, `decodeTreePath`,
  `defaultLocale`, `replyWithFile`, `CustomError`, `rethrowAsBadRequest`, `generateHash`.
- `helpers/apiKeySite.ts`: `enforceApiKeySite(req, reply, siteId)` (controllers use it directly).
- `helpers/permissions.ts` (`PAGE_PERMISSIONS`, `GLOBAL_PERMISSIONS`), `helpers/siteRules.ts`
  (`SITE_PERMISSIONS`, pure rule resolution), `helpers/pageRules.ts`.
- `models/groups.ts`: `actorForRequest(req)` (:353), `groupIdsForRequest(req)` (:342),
  `checkAccess(actor, permission, pageRef)` (:448), `checkSiteAccess(actor, permission, siteId)`
  (:610), `mayHoldPermissionSomewhere` (:551), `holdsSystemPermission(req)` (:1023),
  `getAllGroups()`.
- `models/sites.ts`: `getSiteById({ id })` is **just `return WIKI.sites[id]`** (:110–115) — an
  `await` over a synchronous map read. `getSiteByHostname` is the same map via `sitesMappings`.
- `models/auditLog.ts`: `actorFromRequest(req)` (audit actor, distinct from `actorForRequest`).
- `api/pages.ts` (to be relocated, F1): `actorFrom`, `mayOnPage`, `mayBypassPassword`,
  `unlockedFor`, `pagePermissionsFor`, `loadReadablePage`; `api/assets.ts#mayOnAsset`;
  `api/tree.ts#mayOnFolder`, `visibleTreeItems`.
- `api/schemas/error.ts` `ApiError` (576 `$ref`s — the only shared *param/response* fragment today).
- `controllers/icons.ts#sendCacheable` (:22) — the one existing ETag/304 helper (F10 generalises it).

## Findings

### F1. Page/asset access helpers live in route files; relocate to `helpers/pageAccess.ts` — utility extraction + split prerequisite | net LOC −45 | risk low | effort M

- Locations (definitions): `api/pages.ts:110` `actorFrom`, `:188` `mayBypassPassword`, `:202`
  `unlockedFor`, `:229` `mayOnPage`, `:315` `pagePermissionsFor`, `:350` `loadReadablePage`
  (+ `:186` `PAGE_PASSWORD_BYPASS_ROLES`); `api/assets.ts:32` `mayOnAsset`; `api/tree.ts:84`
  `visibleTreeItems`, `:122` `mayOnFolder`.
- Importers of a *route file* for these helpers (verified with grep): `api/approvals.ts:2`,
  `api/checklists.ts:1`, `api/comments.ts:1`, `api/notifications.ts:1`, `api/tags.ts:2`,
  `api/watching.ts:1`, `api/tree.ts:4-5` (both `pages.ts` and `assets.ts`), `controllers/collab.ts:1`,
  `helpers/apiKeySite.test.ts:7`, plus `mcp/` (doc references) — 26 files reference `mayOnPage`,
  20 reference `actorFrom`.
- What is duplicated: `controllers/files.ts:63-70` and `controllers/thumb.ts:51-60` each inline the
  exact body of `mayOnAsset` (`checkAccess(actorForRequest(req), 'read:assets', { path:
  folder ? `${folder}/${fileName}` : fileName, siteId, locale, classification: null })`) — identical
  save for the variable name (`asset` vs `thumbnail`). `api/watching.ts:13` `loadWatchablePage` and
  `api/approvals.ts:15` `loadSuggestablePage` are `loadReadablePage` with different `getPage`
  options: watching omits `publicOnly`/`withContent` (irrelevant — `watcherOf` already 401s
  anonymous callers before it is reached, `watching.ts:32-39`), approvals adds
  `withContent: true` + `withPassword: (page) => mayBypassPassword(...)`. All three end with the
  same `if (!page || !mayOnPage(req, 'read:pages', siteId, page)) return null`.
- Proposed target shape: new `helpers/pageAccess.ts` exporting the six page helpers plus
  `mayOnAsset`, `mayOnFolder`, `visibleTreeItems`; `loadReadablePage(req, siteId, pageId,
  { withContent?, withPassword? })` absorbs `loadSuggestablePage` (`withPassword: true` →
  `mayBypassPassword`) and `loadWatchablePage` (call with no options). `controllers/files.ts` and
  `thumb.ts` call `mayOnAsset`. Route files import from `../helpers/pageAccess.ts`;
  `api/pages.ts` shrinks by ~260 lines before any split. Update the two doc comments that point at
  `api/pages.ts` for these (`helpers/permissions.ts:26`, `models/pages.test.ts:1962`).
- Test coverage: `api/pages.actorFrom.test.ts` (134 L, imports only `actorFrom`),
  `api/pages.mayBypassPassword.test.ts` (224 L, `mayBypassPassword`/`unlockedFor`), the
  `mayOnPage`/`pagePermissionsFor` describes inside `api/pages.test.ts:14`, `controllers/files.test.ts`
  (411 L) and `controllers/thumb.test.ts` (158 L) already exercise the `read:assets` gate. The two
  helper-only test files move to `helpers/pageAccess.test.ts` (CLAUDE.md co-location rule).

### F2. Site-existence preamble copied 36 times in two spellings — utility extraction | net LOC −115 | risk low | effort S

- Async spelling, `const site = await WIKI.models.sites.getSiteById({ id: req.params.siteId }); if (!site) { return reply.notFound('Site does not exist.') }` (4 lines each, `site` **never read again** — verified by grep for `site.id|site.config|site.hostname` returning 0 in every one of these files): `api/approvals.ts:249,308`, `api/blockCredentials.ts:60,119,172,238,284`, `api/blocks.ts:126,203,341,408`, `api/comments.ts:244,288,392,438`, `api/liveData.ts:107`, `api/search.ts:110,193,249,316,386`, `api/storage.ts:47,162` — 23 copies. (`api/sites.ts:693,882,962` also do it but use `site` afterwards; `api/authentication.ts:273` too.)
- Sync spelling, `if (!WIKI.sites[req.params.siteId]) { return reply.notFound('This site does not exist.') }` (3 lines, different message): `api/glossary.ts:63,109,155,204,255,300,343,391,435,471,513` (11), `api/navigation.ts:286`, `api/tree.ts:427` — 13 copies.
- What's wrong: `getSiteById` is `return WIKI.sites[id]` (`models/sites.ts:110-115`), so both spellings are the same map lookup; the async form pays an `await` and a binding for nothing; two 404 messages exist for one condition; and every *other* `:siteId` route (all of `pages.ts`, `tree.ts` except one, `assets.ts`, `checklists.ts`, `watching.ts`, `notifications.ts`, `graph.ts`, …) simply doesn't check, answering "page does not exist" for an unknown site.
- Proposed target shape: extend the existing plugin-level hook. `siteEnabledPreHandler`
  (`helpers/common.ts:352`) is already registered on the `contentApp` scope in `api/index.ts:62`
  for every `:siteId` route; add the 404 for `req.params.siteId && !WIKI.sites[siteId]` there (one
  message), and delete all 36 blocks. Its doc comment (`common.ts:340-350`) currently *explains*
  leaving the 404 to routes — that paragraph goes with the change. The cheaper, zero-behaviour-change
  alternative is a `requireSite(req, reply)` helper returning the row or sending the 404, which still
  removes ~2 lines per copy (net ≈ −70) but keeps the inconsistency.
- Test coverage: `api/index.test.ts` describes 2–3 (`:165-300`, the structural scan + the "fully
  booted api/index.ts" describe at `:303`) already prove the hook reaches every `:siteId` route and
  is the place to add an "unknown site → 404" case. Only `api/authentication.test.ts` asserts on a
  site-missing message (1 hit), so harmonising the string is cheap. Per-file suites
  (`blockCredentials.test.ts`, `comments.test.ts`, `search.test.ts`, `storage.test.ts`,
  `glossary.test.ts`, `blocks.test.ts`, `approvals.test.ts`) mount the plugin alone without the
  hook — each needs the hook registered in its `buildApp` (one line) or their unknown-site tests
  move to `index.test.ts`.

### F3. Five identical "global permission OR site:* delegation" gate functions — utility extraction | net LOC −40 | risk low | effort S

- Locations: `api/approvals.ts:107` `mayAdministerApprovals` (`manage:sites` / `site:approvals`),
  `api/blocks.ts:64` `mayManageBlocks` (`manage:sites` / `site:blocks`),
  `api/blockCredentials.ts:12` `mayManageCredentials` (same pair as blocks — its own comment says
  "Same gate `api/blocks.ts#mayManageBlocks` uses"), `api/navigation.ts:19` `canManageNavigation`
  (`manage:navigation` / `site:navigation`), `api/sites.ts:89` `maySaveSiteImage` (`manage:sites` /
  per-kind `site:general`|`site:login`). Each is the same 6-line body
  `const actor = actorForRequest(req); return actor.permissions.includes(G) || checkSiteAccess(actor, S, siteId)`
  plus a 6–10-line doc comment repeating the "keeps working exactly as before delegation existed"
  paragraph. `api/sites.ts:634-665` (PUT site) hand-rolls a per-key variant of the same check over
  `SITE_FIELD_PERMISSIONS`.
- Proposed target shape: `WIKI.models.groups.checkSiteAdminAccess(req, globalPermission,
  sitePermission, siteId)` next to `checkSiteAccess` (`models/groups.ts:610`) — or a pure
  `helpers/siteAccess.ts` if keeping `WIKI` out of helpers is preferred; `helpers/siteRules.ts` is
  deliberately WIKI-free so don't put it there. Call sites become one line; the five wrappers and
  their comments go, with the one shared rationale written once on the new function.
- Test coverage: `api/approvals.test.ts:10` ("site:approvals permission (task 683)"),
  `api/blocks.test.ts`, `api/blockCredentials.test.ts`, `api/navigation.test.ts`, `api/sites.test.ts`
  (imports `SITE_PERMISSIONS`) all drive these gates through the routes; `models/groups.test.ts`
  covers `checkSiteAccess`.

### F4. `siteId`/`pageId` params schemas declared inline ~70 times — schema `$ref` extraction | net LOC −300 | risk low | effort M

- Per-file constants, byte-identical except formatting: `api/pages.ts:70-92` (`siteIdParam`,
  `pageIdParam`), `api/tree.ts:39-61` (`siteIdParam`, `folderIdParam`), `api/comments.ts:33-68`
  (`siteIdParam`, `pageIdParam`, + two 3-key variants), `api/graph.ts:199-203`,
  `api/notifications.ts:35-40`, `api/watching.ts:41-48` (`pageParams` = `pageIdParam`),
  `api/checklists.ts:22-40`, `api/assets.ts:7-20`, `api/tags.ts:4-16`.
- Inline `params: { type: 'object', properties: { siteId: { type: 'string', format: 'uuid' } }, required: ['siteId'] }`
  blocks (5–9 lines each) in files with no constant: `required: ['siteId']` appears 49 times across
  19 files (`authentication.ts` 8, `glossary.ts` 7, `search.ts` 4, `approvals.ts` 3, `blocks.ts` 3,
  `comments.ts` 3, `navigation.ts` 3, `sites.ts` 3, …), `required: ['siteId', 'pageId']` 7 times.
  `api/schemas/*.ts` already register everything else via `app.addSchema` + `$ref` (95 ids), and
  routes already use `$ref` for `body:` (`PageInput#`, `HookInput#`, …) — params are the one
  schema slot never shared.
- Proposed target shape: `api/schemas/params.ts` registering `SiteIdParams`, `SitePageParams`,
  `SitePageCommentParams`, `SiteFolderParams`, `SiteTagParams`, … (≈ 10 ids), wired in
  `api/index.ts` with the other 34; routes write `params: { $ref: 'SiteIdParams#' }`. Compound
  params with extra keys (`checklists.ts:22-40`, `glossary.ts` termId/versionId) either get their
  own id or stay inline — only the pure `siteId`/`siteId+pageId` shapes need converting to get most
  of the win.
- Test coverage: every route-file suite injects real requests with UUIDs, so a wrong `$ref` fails
  loudly at boot (`FST_ERR_SCH_*`) and `api/index.test.ts:303`'s fully-booted describe catches a
  missing registration. `apiKeys.swagger.test.ts` / `routeTags.test.ts` don't inspect params.

### F5. Split the four long route files by responsibility (with the test-scanner fix) — long-file splitting | net LOC ≈ 0 (−30 after F1) | risk med | effort L

**Hard constraint first.** `api/routeTags.test.ts:60-63`, `api/responseErrors.test.ts:53-55` and
`api/index.test.ts:208-211` do `readdirSync(apiDir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))`
and then `const mod = await import(`./${file}`); await mod.default(app)`. Consequences: (a) any
`api/<name>/` subdirectory is invisible to all three — the split routes lose the `tags` /
`ApiError` / site-scoped-path checks silently (the `routeFiles.length >= 20` sanity assert still
passes); (b) a helper module placed at `api/*.ts` without a default plugin export throws inside
these tests. So: make the three scanners recursive (walk `api/**`, skip `schemas/`, treat a
directory's `index.ts` as its plugin or import each leaf file), and never park a non-route module at
`api/` top level (F1 puts helpers under `helpers/`, which is the right answer anyway).
`test/apiKeySitePinCoverage.test.ts:67` mounts `api/index.ts` whole and is unaffected.

Per file (route inventory verified from the source; sizes are route-block lengths):

- **`api/pages.ts` (2816 L, 25 routes)** → `api/pages/index.ts` registering:
  - `read.ts` — search (:412, 165 L), include (:577), get (:643, 130 L), unlock (:773), alias (:2698),
    userPermissions (:2765), translations (:1848), backlinks (:2399) ≈ 700 L
  - `write.ts` — create (:856), update (:1218, 239 L), move (:1689, 159 L), render (:1908),
    delete (:2230), bulk (:1987, 175 L), + `replyForRenderRefusal` (:47) ≈ 900 L
  - `import.ts` — the two multipart routes (:942, :1036) **and** the `addContentTypeParser('*')` +
    `fastifyMultipart` registration (`:378-407`), which today applies to the whole plugin; scoping it
    to `import.ts` is the one behaviour-adjacent detail (the `'*'` buffer parser would stop applying
    to the JSON routes — verify no JSON route relies on it; none should, per its own comment).
  - `classification.ts` — conflicts/resolve (:1457), report (:1585), level listing (:1626),
    `recordClassificationChange(s)` (:254-313) ≈ 300 L
  - `history.ts` — history list (:2277), version (:2339), deleted (:2515), recover (:2584) ≈ 300 L
  - `export.ts` — pdf (:2162), markdown/html (:2445), `exportFilenameStem` (:32) ≈ 150 L
  - Tests already map onto this: `pages.classification.test.ts` → `classification`,
    `pages-export.test.ts` + `pagesExportPdf.test.ts` → `export`, `pages.backlinks.test.ts` → `read`;
    `pages.test.ts` (4289 L, 20 describes) splits along its describe titles (import ×2 → `import`,
    deleted/recover/history ×3 → `history`, path/move/translations/userPermissions/bulk → `write`/`read`).
    All of them build the app with `app.register(pagesRoutes)` on the default export, so the
    aggregate `pages/index.ts` keeps every existing test valid with only an import-path change.
- **`api/users.ts` (2614 L, 35 routes)** — two audiences that share nothing but the file:
  - `users/admin.ts` — list/recent-logins/whoami/defaults/:userId CRUD/passkeys/tfa-invalidate/
    reassignContent/delete (`:171-323`, `:1633-2615`, ≈ 1150 L, all `config.permissions`-gated) +
    `systemUserGuard`, `hasUnknownGroups`, `DELETE_USER_BLOCKING_RELATIONS`, `whoAmI` (exported to
    `bootstrap.ts`).
  - `users/profile.ts` — the 21 `/profile*` routes (`:324-1632`, ≈ 1300 L), every one opening with
    the same 4-line `sessionUserId`/401 preamble (20 copies, `:344,394,499,561,627,669,758,843,904,948,
    1032,1082,1144,1212,1287,1338,1393,1449,1496,1561`) — worth a `preHandler` on that sub-plugin
    (`profile.ts` registers `addHook('preHandler', requireSessionUser)`; net −60 L) since every
    route in it needs it. Could go a step further into `profile.ts` (profile/avatar/groups/editor
    settings) and `profileSecurity.ts` (auth/password/tfa/recovery-codes/passkeys/api-keys, ≈ 650 L).
  - Tests: `users.test.ts` (454 L), `users.reassignContent.test.ts`, `users.createWelcomeEmail.test.ts`,
    `sessionInvalidation.test.ts` → admin; `profileApiKeys.test.ts` → profile. All register the
    default export under no prefix, so `users/index.ts` keeps them working.
- **`api/system.ts` (1857 L, 29 routes, all `manage:system`/`access:admin`)** →
  `system/info.ts` (info :103 156 L, cluster :972, checkForUpdate :1387, + exported
  `getClusterNodes` used by `controllers/metrics.ts`), `system/settings.ts` (flags/security/api/
  metrics/pageviews GET+PUT pairs :259-970, see F7), `system/extensions.ts` (:432-597),
  `system/maintenance.ts` (websockets/cache/certificates/api-keys purge/sessions invalidate/history
  purge :1027-1386), `system/transfer.ts` (export/download/import/pages scan :1438-1858 + the
  gzip `addContentTypeParser` at :93 which only `/import` needs). `system.test.ts` (591 L, 6
  describes) splits along the same seams; it mounts the default export.
- **`api/authentication.ts` (1737 L, 20 routes)** → `auth/site.ts` (public per-site login surface:
  strategies list :177 154 L, login :331, register :435, change-password :524, forgot/reset
  :617/:690, tfa :784, passkey challenge/login :899/:964, verify :1269, logout :1316 ≈ 1000 L),
  `auth/provider.ts` (authorize :1036, callback GET/POST :1142/:1212 + `callbackUrl`,
  `loginErrorUrl`, `CallbackFlowError`, `matchCallbackFlow`, `finishProviderLogin` :25-172 ≈ 400 L),
  `auth/strategies.ts` (admin CRUD :1409-1738, `manage:system`, ≈ 330 L). `authentication.test.ts`
  (1565 L, 11 describes) maps 1:1 onto those three (describes 1–4 → provider, 5–6/10 → site, 7/8/9
  → strategies).
- **`api/sites.ts` (1053 L)** — leave whole, but its `PUT /:siteId` route is 360 lines (:473-833)
  of which ~120 are the body schema listing every config key; `SITE_CONFIG_KEYS` (:19) already
  enumerates them — generating the `properties` map from the shared `Site#` schema
  (`schemas/site.ts`) would drop ~100 lines. Lower priority.

### F6. "Load page → 404 → check permission → 403 → locked → 403" preamble ×13 — utility extraction | net LOC −55 | risk low | effort S

- Locations (all after F1's `loadReadablePage`): `api/pages.ts:2319-2328` (history list),
  `:2374-2383` (version), `:2477-2500` (md/html export), `:2200-2206` (pdf), `:2419-2423` (backlinks);
  `api/comments.ts:499-507`, `:570`, `:693-701`, `:775-783`; `api/checklists.ts:73-81`, `:117-125`,
  `:149-157`, `:211-219`. Each is `const page = await loadReadablePage(...); if (!page) return reply.notFound('This page does not exist.'); if (!mayOnPage(req, P, siteId, page)) return reply.forbidden(M); if (page.isLocked) return reply.forbidden('This page is password protected.')`
  — 9–10 lines, differing only in `P` and the 403 message. `'This page does not exist.'` is
  spelled 27 times across `pages/comments/checklists/approvals/watching`;
  `'This page is password protected.'` 12 times.
- Proposed target shape: `requireReadablePage(req, reply, siteId, pageId, { permission?, forbiddenMessage?, withContent?, allowLocked? })`
  in `helpers/pageAccess.ts` returning the page or `null` after sending the reply — the same
  "returns null once a reply is sent" convention `watcherOf`/`callerOf` already use.
- Test coverage: `pages.test.ts` history/export describes (:3105, :3864), `pages-export.test.ts`,
  `pagesExportPdf.test.ts`, `comments.test.ts:170` ("page-scoped comment routes"),
  `checklists.test.ts` — all assert the 404/403 statuses these preambles produce.

### F7. `system.ts` boolean-flag toggle triplet — feature rewrite (small) | net LOC −160 | risk med | effort S

- Locations: `api/system.ts:598-631` + `:632-699` (`/api`), `:700-733` + `:734-803` (`/metrics`),
  `:804-850` + `:851-920` (`/pageviews`). The three PUT handlers are line-for-line identical modulo
  the config key (`WIKI.config.api|metrics|pageviews`), `saveToDb([key])`, the audit event name
  and three message strings; the three GETs return `{ isEnabled }` (pageviews adds `summary`). The
  route schemas repeat the same `{ ok, message, isEnabled }` response and `{ isEnabled }` body.
- Proposed target shape: `registerFlagToggle(app, { path, configKey, auditEvent, label, summary, description, extraGet? })`
  local to `system/settings.ts`, emitting both routes; pageviews passes `extraGet: () => ({ summary: await WIKI.models.pageviews.summary() })`.
  Swagger text stays per-toggle via the options object. `/flags` and `/security` are different
  shapes and stay hand-written.
- Test coverage: only `GET /pageviews` (`system.test.ts:202`) — the PUTs have none, which is the
  reason this is "med" risk: add a PUT test per toggle first (three small injects) before
  factoring.

### F8. Small duplicate-helper bundle — utility extraction | net LOC −45 | risk low | effort S

- `api/notifications.ts:26` `callerOf` ≡ `api/watching.ts:32` `watcherOf` (its own comment admits
  it: "Identical to `watching.ts#watcherOf` — kept local rather than exported there to avoid
  coupling two otherwise-independent route files"). With F1's `helpers/pageAccess.ts` there is a
  neutral home: `requireActorId(req, reply, message)`.
- `api/pages.ts:61` `splitList` and `api/tree.ts:31` `splitList` — same split/trim/filter; tree's
  returns `null` for empty, pages' `[]`. One helper with the `[]` contract and `?? null` at tree's
  two call sites.
- `api/users.ts:151` `hasUnknownGroups` vs the inline loop at `api/apiKeys.ts:152-158` (same
  `getAllGroups()` + `some(!known.some(...))`; apiKeys adds a guests-group refusal) vs
  `api/approvals.ts:193` `rejectUnknownGroups` (via `models/approvals.getUnknownGroupIds`) — three
  ways to ask "are these real group ids"; `models/groups.ts` should own one.
- `api/users.ts:757-812` (personal token create) vs `api/apiKeys.ts:136-215` (admin key create):
  identical name regex, `siteId` existence check, `allowedClassifications` validation, `createKey`
  call and `apiKey.issued` audit record; differs in `groups` (admin only) and `userId`
  (personal only). A shared `validateApiKeyInput(body)` + `issueKey(...)` removes ~35 lines.
- `req.hostname ? await getSiteByHostname({ hostname: req.hostname }) : null` ×3 in `users.ts`
  (`:121-123`, `:135-137`, `:1219-1221`), and the `'current'`/uuid/hostname three-way resolution
  duplicated between `api/sites.ts:311-322` and `controllers/site.ts:63-69` — a
  `resolveSiteParam(param, req.hostname, { strict })` beside `resolveRequestSite` in
  `helpers/common.ts`.
- Test coverage: `notifications.test.ts`, `watching.test.ts`, `profileApiKeys.test.ts`,
  `apiKeys.test.ts`, `sites.test.ts`, `controllers/site.test.ts` (518 L) all hit these paths.

### F9. `req.query.limit ?? N` fallbacks are unreachable — dead code | net LOC −8 | risk low | effort S

- Locations: `api/users.ts:221` (`?? 20`, `:220` `page ?? 1`), `:280` (`?? 10`),
  `api/auditLog.ts:71-72`, `api/groups.ts:536-537`, `api/hooks.ts:224`, `api/scheduler.ts:232`.
- Why dead: each route's `querystring` schema declares `default:` for the same property
  (`users.ts:196-197`, `auditLog.ts:43-44`, `groups.ts:506-507`, `hooks.ts:193`,
  `scheduler.ts:204`), and Fastify's AJV runs with its default `useDefaults: true` — `index.ts:323-340`
  customises only `plugins`/`onCreate`, never `customOptions`. A missing query param is therefore
  filled before the handler runs. Tests mount plain `fastify()` too, so they see the same behaviour.
- Fix: read `req.query.limit` directly (type the generic as non-optional).

### F10. ETag / `If-None-Match` / 304 dance hand-rolled in six controllers — utility extraction | net LOC −25 | risk low | effort S

- Locations: `controllers/site.ts:114-120`, `controllers/files.ts:81-87`, `controllers/thumb.ts:65-71`,
  `controllers/blocks.ts:46-52`, `controllers/user.ts:45-51`, `api/locales.ts:107-113`; and the
  already-extracted `controllers/icons.ts:22` `sendCacheable` (which also computes the hash). All
  set `ETag`, `Cache-Control`, `X-Content-Type-Options: nosniff`, then `if (req.headers['if-none-match'] === etag) return reply.code(304).send()`.
- Proposed target shape: `helpers/httpCache.ts#notModifiedOrPrepare(req, reply, { etag, cacheControl })`
  returning `true` when the 304 was sent; `sendCacheable` becomes a thin wrapper.
- Test coverage: `controllers/site.test.ts`, `files.test.ts`, `thumb.test.ts`, `blocks.test.ts`,
  `user.test.ts`, `api/locales.test.ts` all assert 304 behaviour.

## Files ranked by size with a one-line verdict each (split / leave / rewrite)

| File | Lines | Verdict |
| --- | --- | --- |
| `api/pages.ts` | 2816 | **split** (F5) after extracting helpers (F1); 6 sub-plugins |
| `api/users.ts` | 2614 | **split** (F5) admin vs profile; profile gets a preHandler for the 20× session gate |
| `api/system.ts` | 1857 | **split** (F5) + rewrite the toggle triplet (F7) |
| `api/authentication.ts` | 1737 | **split** (F5) site / provider / admin strategies |
| `api/sites.ts` | 1053 | leave; trim the 360-line PUT schema off `SITE_CONFIG_KEYS`/`Site#` |
| `api/approvals.ts` | 940 | leave; F2/F3 remove ~40 L |
| `api/comments.ts` | 803 | leave; F2/F6 remove ~45 L |
| `api/tree.ts` | 800 | leave; F1 moves `mayOnFolder`/`visibleTreeItems` out |
| `api/schemas/page.ts` | 765 | leave (16 ids; `PageHistoryEntry`/`PageHistoryListEntry` near-twins are deliberate — see rejected) |
| `api/groups.ts` | 732 | leave (one 201-line PUT, mostly validation prose) |
| `api/icons.ts` | 644 | leave |
| `api/navigation.ts` | 599 | leave; F3/F4 |
| `api/glossary.ts` | 525 | leave; F2 removes 11 × 3 L, F4 removes 11 inline params |
| `api/hooks.ts` | 500 | leave |
| `api/storage.ts` | 482 | leave; F2 |
| `api/assets.ts` | 462 | leave; F1 moves `mayOnAsset` out |
| `api/blocks.ts` | 431 | leave; F2/F3 |
| `api/search.ts` | 399 | leave; F2 removes 5 site checks |
| `api/schemas/site.ts` | 389 | leave |
| `api/graph.ts` | 326 | leave |
| `api/scheduler.ts` | 314 | leave |
| `api/blockCredentials.ts` | 303 | leave; F2/F3 remove ~35 L |
| `api/schemas/user.ts` | 301 | leave |
| `api/schemas/storage.ts` | 295 | leave |
| `api/apiKeys.ts` | 283 | leave; F8 shares creation validation with `users.ts` |
| `api/schemas/authentication.ts` | 259 | leave |
| `api/mail.ts` | 246 | leave |
| `api/checklists.ts` | 236 | leave; F6 |
| `api/watching.ts` | 233 | leave; F1/F8 |
| `controllers/seo.ts` | 225 | leave (pure builders + one route, well tested) |
| `api/auditLog.ts` | 204 | leave; F9 |
| `api/classificationLevels.ts` | 194 | leave |
| `api/tags.ts` | 189 | leave |
| `api/notifications.ts` | 179 | leave; F8 |
| `api/locales.ts` | 163 | leave; F10 |
| `controllers/site.ts` | 140 | leave; F8 (site param resolution), F10 |
| `api/liveData.ts` | 120 | leave; F2 |
| `controllers/files.ts` | 118 | leave; F1 (`mayOnAsset`), F10 |
| `controllers/metrics.ts` / `icons.ts` | 112 / 112 | leave |
| `api/index.ts` | 100 | leave; grows by one hook (F2) and one schema registration (F4) |
| everything else | < 100 | leave |

## Things I checked and rejected (so nobody re-checks them)

- **Dead exports**: every `export` in `api/*.ts` and `controllers/*.ts` has ≥ 1 non-test importer
  (checked each symbol with `grep -rl` over `backend/**/*.ts` excluding its own file; smallest
  counts: `GRAPH_NODE_CAP`, `folderOf`, `controllers/seo.ts` builders — 1 non-test importer each,
  all real). `PAGE_PASSWORD_BYPASS_ROLES` is used at `pages.ts:546`.
- **Unreferenced schema `$id`s**: none — each of the 95 ids is `$ref`'d from a route or another
  schema (`grep -rho "'<id>#'"` over `api mcp controllers models`).
- **`PageHistoryEntry` vs `PageHistoryListEntry`** (`schemas/page.ts:467` / `:616`): identical
  except the former carries `author.email`; the `RecoverablePageEntry` comment (`:69-75` of that
  diff) documents this as a deliberate exposure decision (OpenProject #2168). Not a dedupe.
- **`FIXME`/`TODO`/legacy/compat shims**: grep over `api/` and `controllers/` finds only prose
  ("Deprecated icons are left out", extension "compatible"). Nothing to delete.
- **The six `addContentTypeParser` registrations** (`assets.ts:58`, `blocks.ts:80`, `pages.ts:378`,
  `sites.ts:229`, `users.ts:163`, `system.ts:93`): four share the 6-line raw-buffer shape, but each
  has a different MIME list / body limit and `system.ts`'s is a streaming parser; a helper saves
  ~12 lines for a genuinely different-per-file registration. Not worth it.
- **`sessionUserId` (users.ts:62) vs `actorFrom` (pages.ts:110)**: not duplicates —
  `sessionUserId` deliberately excludes API-key callers (profile routes must not be driven by a
  token), `actorFrom` includes personal tokens. Keep both; F8 only merges the two identical
  `actorFrom`-based wrappers.
- **`WIKI.models.approvals.getActorGroupIds(req)` (`models/approvals.ts:443`) vs
  `groups.groupIdsForRequest(req)` (`models/groups.ts:342`)**: differ on API-key requests (approvals
  ignores `req.apiKey.groupIds`). Same-looking but not the same contract; flagging as a
  *models*-area question, not a consolidation here.
- **Pagination parsing**: only `users.ts` list and `groups.ts` group-users share the
  `page/limit → { page, limit, total, items }` shape (2 sites); the rest are limit/offset or
  cursor with differing bounds. No helper warranted beyond F9's dead fallbacks.
- **`ApiError` response entries** (576 `$ref`s, e.g. `401:` ×176, `403:` ×177): already the
  minimal one-liner; an `errorResponses(401, 403, 404)` spread would save one line per route at the
  cost of `responseErrors.test.ts`'s static inspection. Left alone.
- **`maskSensitiveConfig`/`unmaskSensitiveConfig`**: no `api/` file calls them (masking happens in
  models); no route-level module-config duplication to consolidate.
- **`controllers/render.ts`, `terminal.ts`, `collab.ts`, `metrics.ts`**: each is a single
  bespoke route; the `manage:system` checks in `terminal.ts` (session) and `metrics.ts` (bearer
  key) look alike but read different credentials by design.
