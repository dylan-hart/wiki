# Locale Structural (Option A) Implementation Plan — Epic #990

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make locale a structural, enforced dimension of Wiki.js 3.x content — DB-enforced uniqueness, fail-closed permission rules, locale-scoped cascades, one canonical parser/composer pair, reserved locale-code names, canonical URLs, and closure of every known locale leak.

**Architecture:** Keep the per-page-locale model and path-prefix URLs exactly as they are. Remove every place where locale correctness depends on a call site remembering: the database enforces `(siteId, locale, path)` uniqueness; `RulePageRef` requires an explicit locale (or an explicit, knowing `null`); every tree/nav cascade carries `locale = folder.locale`; all parse/compose flows go through `helpers/common.ts` ⟷ `helpers/pagePaths.js`; locale codes are reserved as first path segments; `/en/page` 302s to `/page`.

**Tech Stack:** Backend TypeScript 7 (no build step, native type stripping), Fastify, Drizzle 1.0.0-rc.4 on PostgreSQL, `node:test`; Frontend Vue 3 + Pinia + Vitest; Lit blocks.

**Spec:** `docs/decisions/locale-architecture.md` (Status: Decided — Option A). OpenProject epic #990, features #991–#995 (bug #932 under #992, bug #949 under #995). Feature #996 (translation-group spike) is **out of scope for this plan** — deliberately skipped until asked, per the handoff.

## Global Constraints

- Backend is TypeScript 7, **no build step**: relative imports carry the real `.ts` extension; `import type` for type-only imports; no enums/namespaces (`erasableSyntaxOnly`); `catch (err: any)` per site.
- **Zero errors, zero warnings**: after each task run `npm run typecheck` (backend) and `npx oxlint` in the touched workspace(s). Warnings are failures.
- **Scoped tests only — never full suites.** Run exactly the test file(s) named in the task: `node --test path/to/file.test.ts` from `backend/`, `npx vitest run path/to/file.test.js` from `frontend/`.
- DB-backed backend tests need `DATABASE_URL`. Throwaway instance: `docker run --rm -d --name wiki-test-db -p 56001:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:17`, then `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56001/postgres node --test <file>`. Suites gate on `hasTestDatabase()` (`backend/test/db.ts`) and must skip cleanly without it.
- Schema changes: edit `backend/db/schema.ts`, then `npm run db-generate` (from `backend/`), commit the generated migration folder. Never edit an already-committed migration; hand-adding a data-backfill statement to a **freshly generated, not-yet-committed** migration is allowed and used in Tasks 1 and 18.
- Style: oxfmt (no semicolons, single quotes, 2-space); never two statements in a Vue template attribute; `es-toolkit` not lodash-es; native `Temporal` not luxon.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Coordination:** a knowledge-graph epic (#848) may land a `links` jsonb column on `pages` concurrently. As of 2026-08-21 it has NOT landed (verified: no `links` in `db/schema.ts`, no uncommitted `backend/` changes). If `git pull`/rebase surfaces a new migration mid-execution, re-run `npm run db-generate` so migration history stays linear, and merge—don't overwrite—`db/schema.ts` / `models/pages.ts`.
- **CLAUDE.md correction (do not be misled):** CLAUDE.md claims `modules/storage/*` is definition-only with no `storage.ts`. That is stale — all 7 storage modules have real implementations (`git/sync.ts`, `disk/storage.ts`, `sftp/pages.ts`, …), gated by `models/storage.ts`'s `hasImplementation()`. WP #960 owns fixing CLAUDE.md; do not edit it here.
- **Locale vocabulary** (three distinct things — never conflate):
  - *Site locale config*: `WIKI.sites[siteId].config.locales` = `{ primary, active: string[], forcePrefix, showMenu }`. Routing subset typed as `LocaleRoutingConfig` (`helpers/common.ts:247`).
  - *Installed locales*: rows in the `locales` table, via `WIKI.models.locales.getLocales()` (cached). A locale can be installed but not active on a site.
  - *Frontend*: content locale is `pageStore.locale` (fallback `siteStore.locales.primary`); `commonStore.locale` is the **UI language** and must never be used as a content locale.

---

### Task 1: DB unique indexes + `tree.folderPath` NOT NULL (#991)

**Files:**
- Modify: `backend/db/schema.ts` (pages table `:543-613`, tree table `:1134-1173`)
- Create: `backend/db/migrations/<generated>_main/` (via `npm run db-generate`, then hand-add backfill)
- Test: `backend/models/pages.test.ts` (existing DB-backed suite), `backend/models/tree.test.ts` (extend if it exists, else add cases to pages suite)

**Interfaces:**
- Produces: unique index `pages_siteId_locale_path_idx` on `(siteId, locale, path)`; plain index `pages_siteId_locale_hash_idx` on `(siteId, locale, hash)` (backs `getPage`'s hash lookup, `models/pages.ts:420-423`); partial unique indexes `tree_composite_page_idx` / `tree_composite_nonpage_idx` on `(siteId, locale, folderPath, fileName)`; `tree.folderPath` becomes `NOT NULL DEFAULT ''`.

Design decisions (already made — implement, don't relitigate):
- Uniqueness is on **path, not hash**: `generatePathHash` is cyrb53, 53-bit, non-cryptographic (`helpers/common.ts:358-384`) — a unique index on hash would reject a legitimate page whose distinct path collides. The hash index is a plain (non-unique) supporting index.
- `tree` uniqueness is **type-conditional**: the app rule (see probes at `models/tree.ts:898-912` and `resolveName` `:1320-1374`) is that a page may share a name with a folder, but nothing else shares. Two partial unique indexes encode the enforceable part: at most one `page` row and at most one non-page row per `(siteId, locale, folderPath, fileName)`. The page↔asset cross-partition exclusion stays app-level (the existing probes remain as defense-in-depth) — a pure unique index cannot express it.
- `folderPath` is currently nullable and root rows hold NULL **or** `''` depending on writer; Postgres treats NULLs as distinct in unique indexes, which would gut the constraint at the root. Fix structurally: `NOT NULL DEFAULT ''`, with a backfill. No migration-compat concerns per CLAUDE.md's charter.

- [ ] **Step 1: Write the failing DB-backed tests**

In `backend/models/pages.test.ts`, inside the existing `describe(..., { skip: !hasTestDatabase() })` suite (follow its existing fixture usage — `setupTestDb()` returns `{ db, siteId, userId, groupId }`):

```ts
test('the database itself rejects a duplicate (siteId, locale, path) even bypassing the model', async () => {
  await WIKI.models.pages.createPage(siteId, pageInput({ path: 'unique/dupe-probe', locale: 'en' }), actor)
  await assert.rejects(
    db.insert(pagesTable).values(rawPageRow({ path: 'unique/dupe-probe', locale: 'en', siteId })),
    (err: any) => (err.cause?.code ?? err.code) === '23505'
  )
})

test('the same path in two locales coexists', async () => {
  await WIKI.models.pages.createPage(siteId, pageInput({ path: 'unique/two-locales', locale: 'en' }), actor)
  // requires 'fr' in the test site's active locales — extend the fixture site config if needed
  const fr = await WIKI.models.pages.createPage(siteId, pageInput({ path: 'unique/two-locales', locale: 'fr' }), actor)
  assert.equal(fr.locale, 'fr')
})
```

Reuse/extend the suite's existing page-input helper (it already creates pages in tests). `rawPageRow` = minimal `.values()` object satisfying NOT NULLs (copy the column list from an existing insert in the suite, or select an existing row and re-insert with a new id). If the fixture site's `config.locales.active` is `['en']` only, patch it in `before()`: update the sites row's config JSONB to `active: ['en', 'fr']` and call `WIKI.models.sites.reloadCache()` — check how `test/db.ts` seeds the site first and follow its idiom.

- [ ] **Step 2: Run to verify the first test fails** (raw insert currently succeeds — no index):
`cd backend && DATABASE_URL=... node --test models/pages.test.ts` → the duplicate-probe test FAILS.

- [ ] **Step 3: Edit `backend/db/schema.ts`**

`pages` index array — append:

```ts
    // -> The invariant every probe in models/pages.ts assumes ("path unique within (site, locale)"),
    //    finally held by the database itself. On path, not hash: the hash is cyrb53 (53-bit,
    //    non-cryptographic), so two distinct paths may legitimately collide.
    uniqueIndex('pages_siteId_locale_path_idx').on(table.siteId, table.locale, table.path),
    // -> Backs getPage's hottest read (siteId + hash + locale equality). Plain, not unique — see above.
    index('pages_siteId_locale_hash_idx').on(table.siteId, table.locale, table.hash)
```

`tree` — change the column:

```ts
    folderPath: ltree('folderPath').notNull().default(''),
```

`tree` index array — append:

```ts
    // -> One page row per name per (site, locale, folder), and one non-page row: the app rule is that
    //    a page may share a name with a folder but nothing else shares (see the probes in
    //    models/tree.ts). The page<->asset cross-partition exclusion cannot be a unique index and
    //    stays enforced by those probes.
    uniqueIndex('tree_composite_page_idx')
      .on(table.siteId, table.locale, table.folderPath, table.fileName)
      .where(sql`"tree" = 'page'`),
    uniqueIndex('tree_composite_nonpage_idx')
      .on(table.siteId, table.locale, table.folderPath, table.fileName)
      .where(sql`"tree" <> 'page'`)
```

(The type column's DB name is `"tree"` — `treeTypeEnum('tree')`.)

- [ ] **Step 4: Generate the migration** — `cd backend && npm run db-generate`. Open the new `db/migrations/<timestamp>_main/migration.sql` and hand-add the backfill **before** the `SET NOT NULL` statement:

```sql
UPDATE "tree" SET "folderPath" = '' WHERE "folderPath" IS NULL;--> statement-breakpoint
```

Sanity-read the rest: expect `CREATE UNIQUE INDEX ... WHERE`, `CREATE INDEX`, `ALTER TABLE "tree" ALTER COLUMN "folderPath" SET NOT NULL` (+ `SET DEFAULT ''`). If drizzle-kit fails to emit the partial `.where()` indexes (rc quirk), fall back to the house precedent that already works — `pageEditSubmissions_page_author_idx` at `schema.ts:778-787` uses `.where(sql\`...\`)` successfully, so match its exact call shape.

- [ ] **Step 5: Run the tests** — same command as Step 2. `setupTestDb()` runs real migrations, so both tests now PASS. Also re-run the whole file to confirm no existing test regressed (the create/move/delete suite exercises these paths).

- [ ] **Step 6: Typecheck + lint** — `npm run typecheck && npx oxlint` (backend). `folderPath` is now `string` not `string | null`; if typecheck flags now-redundant `?? ''` sites, leave them (harmless) unless the checker errors.

- [ ] **Step 7: Commit** — `git add backend/db/schema.ts backend/db/migrations backend/models/pages.test.ts` (+ tree test if touched); message `feat(db): enforce (siteId, locale, path) uniqueness on pages and tree (#991)`.

---

### Task 2: Unique-violation → clean 409 (#991)

**Files:**
- Modify: `backend/models/pages.ts` (`createPage` insert ~`:616`, `movePage` update `:923-933`), `backend/models/tree.ts` (`addPage`, `addAsset`, `createFolder` inserts — grep `insert(treeTable)`)
- Modify: `backend/api/pages.ts:1038-1041` (move route response schema — document the 409 it already throws)
- Test: `backend/models/pages.test.ts`

**Interfaces:**
- Consumes: Task 1's indexes (the raw `23505` now actually fires on a race).
- Produces: `CustomError('pageDuplicatePath', …, 409)` / `CustomError('treeEntryDuplicate', …, 409)` from the write paths on unique violation, instead of the generic 500 the global error handler emits for status-less errors (`index.ts:862-883`).

House idiom (from `models/users.ts:673-680` — drizzle rc sometimes wraps the driver error):

```ts
} catch (err: any) {
  if (err.cause?.code === '23505' || err.code === '23505') {
    throw new CustomError('pageDuplicatePath', 'A page already exists at this path.', 409)
  }
  throw err
}
```

- [ ] **Step 1: Write the failing test** (`backend/models/pages.test.ts`, DB-backed suite). Simulate the race by deleting the probe's target between probe and insert being impossible from outside — instead call the model twice concurrently:

```ts
test('a create race on the same path surfaces as a 409 CustomError, not a raw 23505', async () => {
  const input = () => pageInput({ path: 'unique/race-probe', locale: 'en' })
  const results = await Promise.allSettled([
    WIKI.models.pages.createPage(siteId, input(), actor),
    WIKI.models.pages.createPage(siteId, input(), actor)
  ])
  const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
  assert.equal(results.length - rejected.length, 1)
  for (const r of rejected) {
    assert.equal((r.reason as any).statusCode, 409)
    assert.equal((r.reason as any).name, 'pageDuplicatePath')
  }
})
```

(Both may pass the probe before either inserts; with the index, exactly one insert wins. If the probe catches the loser first it already throws the same 409 — the assertion holds either way, which is the point.)

- [ ] **Step 2: Run to verify** — it may pass or fail depending on interleaving; the deterministic check is Step 3's code review + a direct-throw unit: wrap the insert, then in the same test file add a non-DB test that a fabricated error with `code: '23505'` (precedent: `models/users-import.test.ts:166`) thrown through the wrapper maps to the 409. If restructuring for that is awkward, the race test + code inspection suffices — do not over-engineer.

- [ ] **Step 3: Implement** — wrap in try/catch per the idiom:
  - `createPage`'s `WIKI.db.insert(pagesTable)` → `pageDuplicatePath`.
  - `movePage`'s `.update(pagesTable)` → `pageDuplicatePath`.
  - In `models/tree.ts`, each `insert(treeTable)` in `addPage` / `addAsset` / `createFolder` → `CustomError('treeEntryDuplicate', 'Something with this name already exists here.', 409)` — same name/message `resolveName` already uses (`tree.ts:1357-1362`). In `resolveName`'s `'suffix'` mode nothing changes (the probe loop stays; a 23505 through the wrapper in the caller is acceptable as a 409 on a true race).
  - `api/pages.ts` move-route response schema: add a 409 response entry mirroring how the recover route documents `pageDuplicatePath` (`api/pages.ts:1473` prose + the shared `ApiError` `$ref` shape used by the 401/403/404 entries in the same schema).

- [ ] **Step 4: Run tests** — `node --test models/pages.test.ts` PASS. **Step 5:** typecheck + oxlint. **Step 6: Commit** — `fix(pages/tree): surface unique-violation races as 409, not 500 (#991)`.

---

### Task 3: Page rules fail closed on locale and site (#992)

**Files:**
- Modify: `backend/helpers/pageRules.ts` (`RulePageRef` `:60-65`, `ruleMatchesPage` `:108-146`, header doc `:47-51`)
- Test: `backend/helpers/pageRules.test.ts`

**Interfaces:**
- Produces: `RulePageRef` becomes `{ path: string; locale: string | null; siteId: string | null; tags?: string[] }` — `locale` and `siteId` **required**, `null` meaning "no locale/site context, and I know it": a locale-scoped (site-scoped) rule then does NOT match. Locale comparison becomes case-insensitive (URL parsing is case-insensitive; rules must agree).
- Consumed by: Task 4 (every construction site), Tasks 8/12/14/16 (new refs).

This task changes ONLY the helper + its tests; the compile errors it creates across the backend are Task 4's worklist. Do both tasks in one session/commit series if the reviewer prefers a green tree per commit — Task 3's commit may leave `npm run typecheck` red; Task 4's commit restores it. Say so in the commit message.

- [ ] **Step 1: Invert/extend the tests.** In `pageRules.test.ts`:
  - The fixture `page()` (`:22-27`) gains `siteId: null` in its defaults (keep `locale: 'en'`).
  - **Invert** the test at `:137` (`'a page with no locale is not excluded by a locale-scoped rule'`) — it locks in the old fail-open behavior and its own comment (task 446) anticipated this change:

```ts
test('a ref with an explicitly unknown locale is excluded by a locale-scoped rule (fail closed)', () => {
  const rule = makeRule({ match: 'START', path: '', locales: ['en'] })
  assert.equal(ruleMatchesPage(rule, page({ locale: null })), false)
})

test('a locale-scoped rule matches case-insensitively', () => {
  const rule = makeRule({ match: 'START', path: '', locales: ['pt-BR'] })
  assert.equal(ruleMatchesPage(rule, page({ locale: 'pt-br' })), true)
})

test('an unscoped rule still matches a ref with unknown locale', () => {
  const rule = makeRule({ match: 'START', path: '', locales: [] })
  assert.equal(ruleMatchesPage(rule, page({ locale: null })), true)
})
```

  - Same inversion for the site test at `:164` (`'a page with no siteId is not excluded by a site-scoped rule'`) → fail closed with `siteId: null`.
  - Check `backend/test/permissionScenario.ts` (shared fixture) — its refs must gain explicit `locale`/`siteId` values; give them real ones (`'en'` / `null`) matching each scenario's intent.

- [ ] **Step 2: Run** — `node --test helpers/pageRules.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement.**

```ts
/** A page as a rule sees it. `locale`, `siteId` and `path` place it; `tags` are what tag rules match on.
 *
 * `locale` and `siteId` are REQUIRED: a caller that genuinely has no locale (or site) context says
 * `null` explicitly — and a locale-scoped (site-scoped) rule then does not match, i.e. the rules
 * fail CLOSED. The old optional fields let a dozen call sites silently skip locale scoping. */
export interface RulePageRef {
  path: string
  locale: string | null
  siteId: string | null
  tags?: string[]
}
```

`ruleMatchesPage` guards:

```ts
  // -> A rule may be limited to particular locales; an empty list means every one of them. A ref
  //    with an unknown locale (`null`) fails closed: the rule does not match. Case-insensitive,
  //    matching how URL parsing recognizes locale codes (`stripLocalePrefix`).
  if (rule.locales?.length > 0) {
    const refLocale = page.locale?.toLowerCase()
    if (!refLocale || !rule.locales.some((code) => code.toLowerCase() === refLocale)) {
      return false
    }
  }

  // -> Same fail-closed treatment for sites
  if (rule.sites?.length > 0 && (!page.siteId || !rule.sites.includes(page.siteId))) {
    return false
  }
```

Update the header doc block (`:47-51`) to state the fail-closed semantics.

- [ ] **Step 4: Run** — helpers tests PASS (typecheck across the repo will be red until Task 4 — expected). **Step 5: Commit** — `feat(rules): RulePageRef requires locale/siteId; locale-scoped rules fail closed (#992)` noting typecheck completes in the next commit.

---

### Task 4: Fix every RulePageRef construction site (#992)

**Files:**
- Modify (known list — typecheck is the authority; fix every error it reports):
  - `backend/api/tree.ts` — `visibleTreeItems` `:93-106`, `mayOnFolder` `:121-131` + 4 call sites (`:464`, `:546`, `:612`, `:669`), browse filter `:324-333`
  - `backend/api/assets.ts` — `mayOnAsset` `:31-42` + 5 call sites (`:151` upload, `:203`, `:247`, `:329`, `:376`)
  - `backend/models/assets.ts` — `getAsset` projection `:467-497` (add locale)
  - `backend/mcp/tools/listNavigation.ts:45-63`
  - `backend/models/approvals.ts:501-518`, `backend/api/approvals.ts:59-78`
  - `backend/models/pages.ts` — every `RulePageRef`/`mayOnPage`/`hasPermission` ref (`createPage`'s `pageRef` `:601`, `getPathFromAlias` if it builds one, `listPagesForSitemap`'s `rulesAllow(… row)` `:1226`)
  - `backend/api/pages.ts` — `mayOnPage` helper + its call sites (create `:754-759`, move `:1056`, userPermissions `:1614+`)
- Test: `backend/api/tree.test.ts` / `backend/api/pages.test.ts` if they cover these paths (run the ones that exist); primary verification is typecheck + targeted tests below.

**Interfaces:**
- Consumes: Task 3's `RulePageRef`.
- Produces: `mayOnFolder(req, permission, siteId, path, locale)` (new trailing `locale: string` param); `visibleTreeItems(req, siteId, locale, items)` (new third param); `mayOnAsset` ref type gains `locale: string`; `models/assets.ts` `getAsset` result gains `locale: string`; `api/approvals.ts` `reviewerFor`'s `page` param type becomes `{ path: string; locale: string | null; tags?: string[] }`.

Rules for each site — the locale is on the row in every case, just dropped:

- [ ] **Step 1: `api/tree.ts`.**
  - `mayOnFolder`: add `locale: string` param, pass into the ref. Call sites: GET `:464` → `folder.locale`; RENAME `:612` / DELETE `:669` → `existing.locale`; CREATE `:546` → hoist the locale the handler computes at `:551` **above** the check: `const locale = req.body.parentId ? (parent?.locale ?? req.body.locale ?? defaultLocale(req.params.siteId)) : (req.body.locale ?? defaultLocale(req.params.siteId))` (mirrors `createFolder`'s own parent-wins rule at `models/tree.ts:750-751`), use it in both the check and the model call.
  - Browse `:324-333`: hoist `:313`'s expression to `const locale = req.query.locale ?? defaultLocale(req.params.siteId)` and add `locale` to the filter's ref.
  - `visibleTreeItems`: add `locale: string` param → ref gains `locale`. Its GET-route caller passes the handler's resolved locale (Task 6 makes that always-present; until then pass `q.locale ?? defaultLocale(req.params.siteId)`).
- [ ] **Step 2: `api/assets.ts` + `models/assets.ts`.** Add `locale: treeTable.locale,` to `getAsset`'s projection (the tree row places the asset and carries its locale; the join is already there at `:485`). Widen `mayOnAsset`'s param to `asset: { folderPath?: string | null; fileName: string; locale: string }` and pass `locale` into the ref. Upload site `:151`: hoist the locale resolution from `:160` above the check (`const locale = req.query.locale ?? WIKI.sites[req.params.siteId]?.config?.locales?.primary ?? 'en'`) and use it in both.
- [ ] **Step 3: `mcp/tools/listNavigation.ts:61`** — add `locale` (the value resolved at `:48`) to the filter ref. Mirror the same one-line fix in the HTTP browse filter if Step 1 didn't already.
- [ ] **Step 4: Approvals.** `api/approvals.ts` `reviewerFor` param type gains `locale: string | null`; the site-wide-queue fallback at `:72` becomes `{ ...(page ?? { path: '', locale: null }), siteId }` — **deliberately `null`**: a reviewer whose only `review:pages` grant is locale-scoped no longer gets blanket `reviewsAll`, which is the safe direction; add a one-line comment saying exactly that. Callers that have a page pass `page.locale` (check each caller's page shape; the model's `getPage` result carries `locale`). `models/approvals.ts:509-513`: add `locale: page.locale` (verify the enclosing method's `page` param carries it; if not, widen that param the same way).
- [ ] **Step 5: `models/pages.ts` + `api/pages.ts`.** `createPage`'s `pageRef` gains `siteId` (it already has `locale`). `listPagesForSitemap`'s filter row: map to `{ path: row.path, locale: row.locale, siteId, tags: row.tags }`. `getPathFromAlias`: if it selects a page and builds a ref, add `locale` to its SELECT projection and the ref (this closes the alias gap the old test comment at `pageRules.test.ts:137-146` described). `mayOnPage` in `api/pages.ts`: its ref param type must now satisfy the new interface — audit each call site; every one has the page row (`target.locale`) or the request body (`req.body.locale ?? defaultLocale`) in scope. Where a route genuinely has neither, pass `locale: null` **with a comment**.
- [ ] **Step 6: `npm run typecheck`** — drive it to zero. Every remaining error is a construction site the list above missed; fix it with the row's locale, or an explicit commented `null`.
- [ ] **Step 7: Run scoped tests** — `node --test helpers/pageRules.test.ts api/pages.test.ts` (and `api/tree.test.ts` / `models/approvals.test.ts` if present). `npx oxlint`. **Step 8: Commit** — `fix(api): thread locale into every page-rule ref; rules now fail closed (#992)`.

---

### Task 5: Locale-scoped cascades, in transactions (#992 / bug #932)

**Files:**
- Modify: `backend/models/tree.ts` — `renameFolder` cascade `:923-958`, `refreshDescendantPaths` `:960-1008`, `deleteFolder` `:1010-1058`, `countTowardsFolderAt` `:1381-1413` + all its callers (grep `countTowardsFolderAt(`)
- Modify: `backend/models/navigation.ts` — raw-SQL cascade `:789-805`
- Test: `backend/models/tree.test.ts` (create if absent, using `test/db.ts` exactly as `models/pages.test.ts` does)

**Interfaces:**
- Consumes: Task 1 (`folderPath` non-null).
- Produces: `refreshDescendantPaths(siteId: string, locale: string, path: string, db?: WikiDbOrTx)`; `countTowardsFolderAt(siteId: string, locale: string, path: string, delta: number, db?: WikiDbOrTx)`. `renameFolder`/`deleteFolder` run their multi-statement sequences inside `WIKI.db.transaction`.

- [ ] **Step 1: Write the failing DB-backed tests** (`backend/models/tree.test.ts`, `describe('tree cascades', { skip: !hasTestDatabase() })`, with `before(setupTestDb)` / `after(teardownTestDb)`; make `fr` active on the fixture site as in Task 1):

```ts
test('renaming a folder moves only its own locale (bug #932)', async () => {
  const en = await WIKI.models.tree.createFolder({ pathName: 'docs', title: 'Docs', locale: 'en', siteId })
  const fr = await WIKI.models.tree.createFolder({ pathName: 'docs', title: 'Docs', locale: 'fr', siteId })
  await WIKI.models.pages.createPage(siteId, pageInput({ path: 'docs/intro', locale: 'en' }), actor)
  await WIKI.models.pages.createPage(siteId, pageInput({ path: 'docs/intro', locale: 'fr' }), actor)

  await WIKI.models.tree.renameFolder({ folderId: en.id, pathName: 'guides', title: 'Guides' })

  const frPage = await WIKI.models.pages.getPage({ siteId, hash: generatePathHash('docs/intro'), locale: 'fr' })
  assert.ok(frPage, 'the fr page must still live at docs/intro')
  const enPage = await WIKI.models.pages.getPage({ siteId, hash: generatePathHash('guides/intro'), locale: 'en' })
  assert.ok(enPage, 'the en page must have moved to guides/intro')
  const frFolder = await WIKI.models.tree.getFolderById(fr.id)
  assert.equal(frFolder!.fileName, 'docs')
})

test('deleting a folder deletes only its own locale (bug #932)', async () => {
  // same two-locale setup with folder 'doomed' + one page per locale under it
  // deleteFolder(enFolder.id) → fr page still exists, fr folder row still exists, en descendants gone
})

test('folder child counts move only in their own locale', async () => {
  // two-locale folder 'counted'; add a page under en only; read both folder rows' meta.children
})
```

(Fill the second and third bodies with the same explicit create/assert shape as the first — no shortcuts; `generatePathHash` imports from `../helpers/common.ts`.)

- [ ] **Step 2: Run to verify FAIL** — the fr page moves / dies today; that's the bug.

- [ ] **Step 3: Implement `models/tree.ts`.**
  - `renameFolder`: wrap everything from the cascade UPDATEs (`:930`) through `refreshDescendantPaths` (`:950`) in `await WIKI.db.transaction(async (tx) => { ... })`, replacing `WIKI.db` with `tx` inside; add `eq(treeTable.locale, folder.locale)` to both cascade `and(...)` clauses (`:933`, `:940`) — the idiom is already present in the same method's duplicate check at `:906`.
  - `refreshDescendantPaths`: new signature above; add `eq(treeTable.locale, locale)` to the SELECT's `and(...)` (`:984`); use the passed `db` for all three queries. Caller passes `folder.locale` and the tx.
  - `deleteFolder`: wrap the descendant DELETE + own-row DELETE (`:1027-1040`) in a transaction; add `eq(treeTable.locale, folder.locale)` to the descendant DELETE's `and(...)`. Keep `deleteNavForEntries` and `countTowardsFolderAt` after/inside as they are, but pass `folder.locale` (and the tx to `countTowardsFolderAt`, which already accepts `db`). The `.returning()` already selects `locale` (`:1037`) — the WHERE finally agrees with it.
  - `countTowardsFolderAt`: insert `locale: string` as the second param; add `eq(treeTable.locale, locale)` to the WHERE. Grep every caller (`addPage`, `addAsset`, `createFolder`, `deleteEntry`, `deleteFolder`, …) and pass the row's/folder's locale — each caller demonstrably has it (it inserts or deleted a row carrying one).
- [ ] **Step 4: `models/navigation.ts:789-805`.** Add locale to both levels of the raw SQL (the `entry` row updated at `:784` is a full tree row and carries `entry.locale`):

```ts
        WHERE tt."siteId" = ${siteId}
          AND tt."locale" = ${entry.locale}
          AND tt.tree IN ('page', 'folder')
          ...
            WHERE tc."siteId" = ${siteId}
              AND tc."locale" = ${entry.locale}
              AND tc.tree IN ('page', 'folder')
```

Missing the inner one would let a nearer override in a *different* locale wrongly shield rows — that's why both.

- [ ] **Step 5: Run tests** → PASS. `npm run typecheck && npx oxlint`. **Step 6: Commit** — `fix(tree/nav): scope every folder cascade to its own locale, in transactions (#932, #992)`.

---

### Task 6: `getTree` requires locale (#992, backend half)

**Files:**
- Modify: `backend/models/tree.ts` — `getTree` signature `:249-277`, conditional `:320-323`
- Modify: `backend/api/tree.ts` — GET handler `:224-242`, querystring schema `:163-167`
- Test: `backend/models/tree.test.ts`

**Interfaces:**
- Consumes: Task 4's `visibleTreeItems(req, siteId, locale, items)`.
- Produces: `getTree({ …, locale: string, … })` — required, non-null. The HTTP API keeps `locale` optional but **defaults it to the site's primary** in the handler (a per-site default is inexpressible in static JSON Schema; the browse route at `:313` is the precedent).

- [ ] **Step 1: Failing test** (`models/tree.test.ts`): create a folder+page in `en` and in `fr`; call `getTree({ siteId, locale: 'en', includeRootFolders: true })`; assert no `fr`-only entry appears. (Today, omitting locale merges; after the change the signature forces it and filters unconditionally.)
- [ ] **Step 2: Implement.** `getTree`: change `locale?: string | null` → `locale: string`; replace the conditional at `:321-323` with an unconditional `conditions.push(eq(treeTable.locale, locale))`. Update the JSDoc. API handler: `locale: q.locale ?? defaultLocale(req.params.siteId)` hoisted to a `const locale`, passed to both `getTree` and `visibleTreeItems`. Schema description → `'Only entries in this locale. Defaults to the site's primary locale.'`
- [ ] **Step 3:** `npm run typecheck` — fix any other `getTree` caller it finds (each has a locale in scope or uses the same default). Run the test → PASS; `npx oxlint`. **Step 4: Commit** — `feat(tree): getTree requires a locale; API defaults to the site primary (#992)`.

---

### Task 7: Frontend tree callers send the content locale (#992)

**Files:**
- Modify: `frontend/src/components/FileManager.vue` (locale button `:14-26`, `loadTree` `:893-915`, upload `:1287-1298`, `openItem`/`copyItemURL` `:1446-1472`, `editItem` `:1498-1503`)
- Modify: `frontend/src/components/TreeBrowserDialog.vue` (`loadTree` `:336-358`, props) + every component that mounts it (grep `TreeBrowserDialog` / `tree-browser-dialog`)
- Modify: `frontend/src/components/LinkPickerDialog.vue` (`loadTree` `:260-278`, comment `:219-223`)
- Test: none new (these components have no existing suites; the backend default keeps un-migrated callers correct). Verify by `npx oxlint` + `npm run build` staying green.

**Interfaces:**
- Consumes: Task 6's API default; Task 10 adds `siteStore.localeRouting` — if Task 10 hasn't run yet, build the `{useLocales, primary, forcePrefix}` triple by hand as the 5 existing call sites do.
- Produces: FileManager exposes `state.locale` (content locale being browsed); TreeBrowserDialog gains a `locale` String prop (default `null`).

- [ ] **Step 1: FileManager gets a real content-locale selector.** The current button (`:17-26`) shows `commonStore.locale` — the **UI language** — and mounts `<locale-selector-menu/>`, which switches UI language; in a file manager it reads as "which locale's files am I seeing" and filters nothing. Replace it:
  - Add `locale: null` to the component `state`; initialize on open to `pageStore.locale || siteStore.locales.primary`.
  - Replace the button with a `w-btn` labeled `state.locale`, gated `v-if="siteStore.useLocales"`, whose menu lists `siteStore.locales.active` (`code` + `nativeName`); selecting an entry sets `state.locale` and reloads the tree from the root (`loadTree({ initLoad: true })` after resetting current-folder state — mirror what the existing refresh/navigation code in the file does). Remove the `<locale-selector-menu/>` import/usage here (it remains in MainLayout, where UI language is the right meaning).
  - `loadTree` searchParams gain `locale: state.locale`.
  - Upload searchParams (`:1290-1293`) gain `locale: state.locale`; update the `:1287-1288` comment (the locale is no longer "left to the server").
- [ ] **Step 2: FileManager links carry the locale** (this pre-empts the A.5 list for this file — Task 19 must NOT touch FileManager):
  - `openItem` page case: `router.push(localizedPagePath(pagePath, state.locale, routing))` where `routing` is the triple (or `siteStore.localeRouting` once Task 10 lands).
  - `copyItemURL`: `\`${window.location.origin}${localizedPagePath(pagePath, state.locale, routing)}\``.
  - `editItem`: `router.push({ path: item.folderPath ? \`/_edit/${item.folderPath}/${item.fileName}\` : \`/_edit/${item.fileName}\`, query: siteStore.useLocales ? { locale: state.locale } : undefined })` (consumed by Task 15).
  - Import `localizedPagePath` from `@/helpers/pagePaths`.
- [ ] **Step 3: TreeBrowserDialog** — add `locale: { type: String, default: null }` to props; `loadTree` searchParams gain `...(props.locale ? { locale: props.locale } : {})`. Grep its mount sites and pass `:locale="pageStore.locale"` wherever a page context exists (page-save dialogs); a site-admin context with no page passes nothing (server default = primary).
- [ ] **Step 4: LinkPickerDialog** — `loadTree` searchParams gain `locale: pageStore.locale`. Rewrite the comment at `:219-223`: it says "The tree this picker browses isn't scoped to a locale" — after this change the tree IS scoped, which also fixes the live bug it implied (picking a `fr` page while editing `en` yielded `/en/<fr-path>`, a dead link).
- [ ] **Step 5:** `cd frontend && npx oxlint` (zero findings) and `npm run build` (must stay green). **Step 6: Commit** — `feat(frontend): tree browsing is locale-scoped; FileManager gets a real content-locale selector (#992)`.

---

### Task 8: `movePage` gains a locale parameter (#992)

**Files:**
- Modify: `backend/models/pages.ts` — `movePage` `:885-993`
- Modify: `backend/api/pages.ts` — move route `:995-1074` (Body type `:997`, body schema `:1012-1027`, handler)
- Modify: `backend/modules/storage/git/sync.ts:217`, `backend/modules/storage/git/content.ts` (page:rename handler)
- Modify: `frontend/src/stores/page.js` — `pageMove` `:649-664`
- Test: `backend/models/pages.test.ts`

**Interfaces:**
- Consumes: Task 1's unique index (cross-locale collision enforcement), Task 3's ref shape.
- Produces: `movePage(siteId, id, { path, title, locale }: { path: string; title?: string; locale?: string }, actor)` — `locale` optional, defaulting to the page's current locale; `page:rename` hook/storage payloads gain `previousLocale: string`.

The five divergence points inside `movePage` (each is a bug if missed):

- [ ] **Step 1: Failing tests** (`models/pages.test.ts`, DB-backed suite):

```ts
test('movePage can re-home a page into another locale', async () => {
  const page = await WIKI.models.pages.createPage(siteId, pageInput({ path: 'move/xloc', locale: 'en' }), actor)
  const moved = await WIKI.models.pages.movePage(siteId, page.id, { path: 'move/xloc', locale: 'fr' }, actor)
  assert.equal(moved!.locale, 'fr')
  assert.equal(moved!.path, 'move/xloc')
  assert.ok(await WIKI.models.pages.getPage({ siteId, hash: generatePathHash('move/xloc'), locale: 'fr' }))
  assert.equal(await WIKI.models.pages.getPage({ siteId, hash: generatePathHash('move/xloc'), locale: 'en' }), null)
})

test('movePage rejects a destination-locale collision as 409', async () => {
  await WIKI.models.pages.createPage(siteId, pageInput({ path: 'move/occupied', locale: 'fr' }), actor)
  const en = await WIKI.models.pages.createPage(siteId, pageInput({ path: 'move/occupied', locale: 'en' }), actor)
  await assert.rejects(
    WIKI.models.pages.movePage(siteId, en.id, { path: 'move/occupied', locale: 'fr' }, actor),
    (err: any) => err.statusCode === 409 && err.name === 'pageDuplicatePath'
  )
})

test('movePage rejects an inactive destination locale', async () => {
  const page = await WIKI.models.pages.createPage(siteId, pageInput({ path: 'move/badloc', locale: 'en' }), actor)
  await assert.rejects(
    WIKI.models.pages.movePage(siteId, page.id, { path: 'move/badloc', locale: 'zz' }, actor),
    (err: any) => err.name === 'pageInvalidLocale'
  )
})
```

- [ ] **Step 2: Run to verify FAIL** (first test: locale-only move currently hits the `:899` early return and no-ops).
- [ ] **Step 3: Implement `movePage`:**
  1. Param object: `{ path, title, locale }: { path: string; title?: string; locale?: string }`; `const destLocale = locale ?? page.locale`. Validate `destLocale` against the site's active list exactly as `createPage:567-576` does (same `pageInvalidLocale` CustomError).
  2. Early return (`:899`): add `&& destLocale === page.locale`.
  3. Duplicate probe (`:911`): `eq(pagesTable.locale, destLocale)`; run it when `newPath !== page.path || destLocale !== page.locale`.
  4. The UPDATE (`:925-931`): add `locale: destLocale`.
  5. `tree.addPage` (`:945`): `locale: destLocale`.
  6. `changedFields` (`:955-958`): append `...(destLocale !== page.locale ? ['locale'] : [])`.
  7. Hook + storage payloads (`:976-991`): add `previousLocale: page.locale` to both.
  8. `search.renamed(siteId, rawMoved, page.path)` (`:975`): read `models/search.ts`'s `renamed` signature first. If the search index keys documents by page id, nothing changes. If it keys by (locale, path) — or dispatches `previousPath` to modules that do — add a `previousLocale = rawMoved.locale` trailing parameter defaulted so existing callers are untouched, and thread it to wherever `previousPath` is consumed. Do whichever the code actually requires; do not add an unused parameter.
- [ ] **Step 4: `page:rename` consumers.** Grep `page:rename` across `backend/`. The git storage handler composes the OLD file path from `previousPath` — it must now use `previousLocale` for that composition (`pageRelPath(siteId, previousLocale, previousPath, …)` in `content.ts`), else a cross-locale rename deletes/writes the wrong repo file. Update its type for the payload accordingly.
- [ ] **Step 5: API route.** Body type → `{ path: string; title?: string; locale?: string }`; body schema gains `locale: { type: 'string', maxLength: 10, description: 'Move the page into this locale. Unchanged when absent.' }`. Handler: after the existing source `mayOnPage(req, 'manage:pages', …, target)` check, add a destination check when the ref differs:

```ts
      const destRef = { path: req.body.path, locale: req.body.locale ?? target.locale }
      if (!mayOnPage(req, 'manage:pages', req.params.siteId, destRef)) {
        return reply.forbidden('You are not allowed to move this page there.')
      }
```

- [ ] **Step 6: Call sites.** `git/sync.ts:217` → `{ path: newMeta.path, locale: newMeta.locale }` — this is what makes `git mv en/foo.md fr/foo.md` actually change the locale (today it silently stays `en`). Frontend `pageMove`: accept `locale`, include it in the JSON body when set, and fix the follow-link at `:662` → `this.router.replace(localizedPagePath(path, locale ?? this.locale, { useLocales: siteStore.useLocales, primary: siteStore.locales.primary, forcePrefix: siteStore.locales.forcePrefix }))` (`localizedPagePath` is already imported at `:8`).
- [ ] **Step 7:** Run the three tests → PASS; `npm run typecheck && npx oxlint` (both workspaces). **Step 8: Commit** — `feat(pages): movePage can change locale; git reverse-sync stops dropping cross-locale renames (#992)`.

---

### Task 9: Backend canonical composer + port backend compose/parse sites (#993)

**Files:**
- Modify: `backend/helpers/common.ts` (add `localizedPagePath` beside `shouldPrefixLocale:329`)
- Modify: `backend/models/navigation.ts:481-495`, `backend/migration/navigation-import.ts:162-169` + caller `:241-261`
- Test: `backend/helpers/common.test.ts`

**Interfaces:**
- Produces: `localizedPagePath(path: string, locale: string, locales?: LocaleRoutingConfig | null): string` — the backend mirror of `pagePaths.js:155`, consumed by Tasks 16 (sitemap) and 18 (mail).

- [ ] **Step 1: Failing tests** in `common.test.ts` (reuse the `locales()` fixture at `:13-18`):

```ts
describe('shouldPrefixLocale', () => {
  test('the primary locale is bare unless forcePrefix', () => {
    assert.equal(shouldPrefixLocale('en', locales({ forcePrefix: false })), false)
    assert.equal(shouldPrefixLocale('en', locales({ forcePrefix: true })), true)
  })
  test('a non-primary active locale is always prefixed', () => {
    assert.equal(shouldPrefixLocale('fr', locales({ forcePrefix: false })), true)
  })
  test('a single active locale never prefixes', () => {
    assert.equal(shouldPrefixLocale('en', locales({ active: ['en'], forcePrefix: true })), false)
  })
})

describe('localizedPagePath', () => {
  test('prefixes exactly when shouldPrefixLocale says to', () => {
    assert.equal(localizedPagePath('guides/x', 'fr', locales({ forcePrefix: false })), '/fr/guides/x')
    assert.equal(localizedPagePath('guides/x', 'en', locales({ forcePrefix: false })), '/guides/x')
    assert.equal(localizedPagePath('guides/x', 'en', locales({ forcePrefix: true })), '/en/guides/x')
  })
})
```

(This also closes the zero-backend-tests gap on `shouldPrefixLocale`.)

- [ ] **Step 2: Implement** in `common.ts` directly below `shouldPrefixLocale`:

```ts
/**
 * Build a link to a bare page path, prefixed with its locale segment when `shouldPrefixLocale`
 * calls for one. The backend mirror of `localizedPagePath` in `frontend/src/helpers/pagePaths.js`,
 * and the inverse of `stripLocalePrefix`.
 *
 * @param path Bare page path, without a leading slash, as `pages.path` stores it
 * @param locale The path's own locale
 * @returns The slash-leading path to link to
 */
export function localizedPagePath(
  path: string,
  locale: string,
  locales?: LocaleRoutingConfig | null
): string {
  const bare = `/${path}`
  return shouldPrefixLocale(locale, locales) ? `/${locale}${bare}` : bare
}
```

- [ ] **Step 3: Port `models/navigation.ts:489-491`** — replace the inline ternary compose with:

```ts
            ...(row.type === 'page' && {
              target: localizedPagePath(
                parentPath ? `${parentPath}/${row.fileName}` : row.fileName,
                locale,
                locales
              )
            }),
```

(adjust the import at `:8` from `shouldPrefixLocale` to `localizedPagePath`; drop `shouldPrefixLocale` if now unused there).

- [ ] **Step 4: `migration/navigation-import.ts`.** `parsePageTarget` currently accepts ANY first segment as a locale. Give it the known set: change signature to `parsePageTarget(target: string, knownLocales: Set<string>)`; after the regex match, `if (!knownLocales.has(locale)) return null`. At the caller, derive the set once per import from the staged pages themselves: `const knownLocales = new Set([...ctx.pages.keys()].map((k) => k.split('::')[0]!))` (keys are `locale::path`, `:127-129`). This keeps the 2.x always-prefixed contract (validating against *this* site's `active` would wrongly drop targets for locales being imported) while ending the "any first segment is a locale" guess. Update the drop-reason string to say the segment wasn't a locale present in the import.
- [ ] **Step 5:** `node --test helpers/common.test.ts` (+ the navigation-import test file if one exists — grep for it) → PASS; typecheck; oxlint. **Step 6: Commit** — `feat(common): backend localizedPagePath composer; port nav generate/import onto canonical pair (#993)`.

---

### Task 10: Frontend compose sites onto the canonical pair (#993)

**Files:**
- Modify: `frontend/src/stores/site.js` (add `localeRouting` getter after `useLocales:215-217`)
- Modify: `frontend/src/stores/page.js` (`breadcrumbs` getter `:106-126`, `editorExitPath` `:144-152`)
- Modify: the 5 hand-built-triple call sites — `frontend/src/router/routes.js:28`, `frontend/src/components/LocaleSelectorMenu.vue:97`, `frontend/src/components/NavBrowseMenu.vue:247`, `frontend/src/components/LinkPickerDialog.vue:227`, plus any Task 7/8 additions
- Test: `frontend/src/stores/page.test.js` (create if absent, following `stores/user.test.js`'s harness usage)

**Interfaces:**
- Produces: `siteStore.localeRouting` → `{ useLocales, primary, forcePrefix }`, the exact third argument `shouldPrefixLocale`/`localizedPagePath` take.

- [ ] **Step 1: Failing test** (`stores/page.test.js`; the harness rebuilds `API_CLIENT`/`EVENT_BUS` per test — see `test/setup.js`):

```js
test('breadcrumbs carry the page locale and localized cumulative paths', () => {
  const siteStore = useSiteStore()
  siteStore.$patch({ locales: { primary: 'en', forcePrefix: false, active: [{ code: 'en' }, { code: 'fr' }] } })
  const pageStore = usePageStore()
  pageStore.$patch({ path: 'guides/deep/page', locale: 'fr' })
  const crumbs = pageStore.breadcrumbs
  expect(crumbs.map((c) => c.path)).toEqual(['/fr/guides', '/fr/guides/deep', '/fr/guides/deep/page'])
  expect(crumbs.every((c) => c.locale === 'fr')).toBe(true)
})
```

- [ ] **Step 2: Implement.**
  - `site.js` getters:

```js
    /** The exact triple `shouldPrefixLocale` / `localizedPagePath` take — built once here instead of
     *  by hand at every call site. */
    localeRouting() {
      return {
        useLocales: this.useLocales,
        primary: this.locales.primary,
        forcePrefix: this.locales.forcePrefix
      }
    },
```

  - `page.js` `breadcrumbs` — replace the reduce (this also fixes the hardcoded `locale: 'en'` at `:121`, which is A.5 item 5's first hardcode — Task 20 must not re-fix it):

```js
    breadcrumbs: (state) => {
      const siteStore = useSiteStore()
      const segments = state.path.split('/')
      return segments.map((value, key) => ({
        id: key,
        title: value,
        icon: 'la:file-alt',
        locale: state.locale,
        path: localizedPagePath(segments.slice(0, key + 1).join('/'), state.locale, siteStore.localeRouting)
      }))
    },
```

  - `editorExitPath` and the 5 listed call sites: replace each hand-built `{ useLocales: …, primary: …, forcePrefix: … }` object with `siteStore.localeRouting`.
  - `frontend/src/helpers/renderedContent.js:126-129` (`headingUrl`): **no code change.** The WP lists it, but it strips the `/_edit/` app-route prefix, not a locale prefix — the address bar already carries the right locale and must keep it. Add one sentence to its comment saying so ("not a locale parse site — the locale prefix from the address bar is deliberately preserved") so the next survey doesn't re-flag it.
- [ ] **Step 3:** `npx vitest run src/stores/page.test.js` → PASS; `npx oxlint`. **Step 4: Commit** — `refactor(frontend): siteStore.localeRouting; breadcrumbs use localizedPagePath with the real locale (#993)`.

---

### Task 11: Git storage parses locales strictly; orphaned-asset fix; convention recorded (#993)

**Files:**
- Modify: `backend/modules/storage/git/sync.ts` (`LOCALE_SEGMENT`/`parseLocaleAndPath` `:125-141`, `processAssetEntry` `:260-324`, import at `:30`)
- Modify: `docs/decisions/locale-architecture.md` §5.3 (record the convention resolution)
- Test: `backend/modules/storage/git/sync.test.ts` (exists)

**Interfaces:**
- Consumes: `stripLocalePrefix` from `helpers/common.ts`; Task 8's `movePage` locale param (already wired at `:217`).
- Produces: git keeps **primary-bare** serialization, but its parser validates against `locales.active`, case-preserving.

- [ ] **Step 1: Failing tests** in `sync.test.ts` (follow the file's existing WIKI/site stubbing pattern — it already stubs `WIKI.sites` for `parseLocaleAndPath`'s current behavior; find and extend those cases):

```ts
test('a two-letter folder that is not an active locale stays a folder path', () => {
  // site stub: locales { primary: 'en', active: ['en', 'fr'] }
  assert.deepEqual(parseLocaleAndPath(siteId, 'it/setup'), { locale: 'en', path: 'it/setup' })
})

test('an active locale folder is recognized case-preservingly', () => {
  // site stub: locales { primary: 'en', active: ['en', 'pt-BR'] }
  assert.deepEqual(parseLocaleAndPath(siteId, 'pt-BR/intro'), { locale: 'pt-BR', path: 'intro' })
  // a mis-cased folder still resolves to the code AS STORED, never a lowercased twin
  assert.deepEqual(parseLocaleAndPath(siteId, 'pt-br/intro'), { locale: 'pt-BR', path: 'intro' })
})
```

(If `parseLocaleAndPath` isn't exported, export it — it's exactly the kind of pure seam the suite already tests.)

- [ ] **Step 2: Implement the parser.** Delete `LOCALE_SEGMENT` (`:126`); rewrite:

```ts
/**
 * The inverse of `content.ts`'s `localeNamespace` + `pageRelPath`: split `[locale/]path` (already
 * stripped of its extension) back into the locale it was written under and the bare page path.
 * Validated against the site's ACTIVE locales via the canonical `stripLocalePrefix` — a folder
 * merely shaped like a locale code (`it/`, `qa/`) is a folder, and the code comes back exactly as
 * stored in `active` (`pt-BR`, never a lowercased `pt-br` twin). A path with no active-locale
 * prefix is the site's primary locale, exactly as `created()` writes it.
 */
function parseLocaleAndPath(siteId: string, pathNoExt: string): { locale: string; path: string } {
  const locales = WIKI.sites?.[siteId]?.config?.locales
  const primary = locales?.primary ?? 'en'
  const match = stripLocalePrefix(`/${pathNoExt}`, locales)
  if (match && match.path !== '/') {
    return { locale: match.locale, path: match.path.slice(1) }
  }
  return { locale: primary, path: pathNoExt }
}
```

Add `stripLocalePrefix` to the `helpers/common.ts` import at `:30`. (The `match.path !== '/'` guard keeps a file literally named after a locale — `fr.md` at the root — a page named `fr` in the primary locale rather than an empty path; Task 12's reserved names then forbids creating such a page going forward, but the parser must not crash on a repo that has one.)

- [ ] **Step 3: Orphaned-asset fix** (`processAssetEntry:269-287`). Today a rename whose bytes ALSO changed skips the whole rename branch (the `contentUnchanged` guard), leaving the old row orphaned while a fresh upload lands at the new path. Restructure so rename detection is independent of content change:

```ts
  if (entry.exists && entry.relPath !== entry.oldPath) {
    const existing = await WIKI.models.assets.getAssetByPath(target.siteId, entry.oldPath)
    if (existing) {
      const contentUnchanged =
        entry.before === entry.after || (entry.deletions === 0 && entry.insertions === 0)
      const newFolder = dirnameOf(entry.relPath)
      if (contentUnchanged && newFolder === existing.folderPath) {
        await WIKI.models.assets.renameAsset(target.siteId, existing.id, path.basename(entry.relPath))
        return
      }
      // -> Renamed across folders, or renamed AND rewritten in one commit: either way the old row
      //    cannot be updated in place (renameAsset only changes the file name; upload() below keys
      //    on the new path) — delete it so the fresh upload doesn't leave it orphaned.
      await WIKI.models.assets.deleteAsset(target.siteId, existing.id)
    }
    // -> fall through to the upload below
  } else if (
```

(Remove the old `contentUnchanged` computation above the branch; keep the delete-only branch and the upload tail as they are.) Add a test: a diff entry with `relPath !== oldPath` and `insertions > 0` ends with exactly one asset row, at the new path — follow the suite's existing model-stubbing pattern for `WIKI.models.assets`.

- [ ] **Step 4: Record the convention decision** in `docs/decisions/locale-architecture.md` §5.3: change its status line to resolved, e.g. — "**Resolved (this epic, A.3): primary-bare kept for git and sftp** (`content.ts`'s `localeNamespace`, `sftp/pages.ts`'s `remotePathForPage` — they already agree); the parser now validates against `locales.active`, case-preserving, which was the actual ambiguity. **Disk stays always-prefixed** (`disk/storage.ts` `dump`/`importAll`) — it is a backup format that round-trips only with itself and the unambiguous scheme is right there; divergence documented in each module's header comment." Then add exactly those one-line header comments to `git/content.ts` (`localeNamespace`), `sftp/pages.ts` (`remotePathForPage`), `disk/storage.ts` (`dump`), each naming the convention it implements and pointing at the decision doc.
- [ ] **Step 5:** `node --test modules/storage/git/sync.test.ts` → PASS; typecheck; oxlint. **Step 6: Commit** — `fix(storage/git): strict case-preserving locale parsing; no more orphaned rows on rename+modify (#993)`.

---

### Task 12: Reserved locale-code names + integrity check (#994)

**Files:**
- Modify: `backend/models/locales.ts` (new `isReservedLocaleCode`), `backend/models/pages.ts` (`createPage`, `movePage`), `backend/models/tree.ts` (`createFolder`, `renameFolder`)
- Modify: `backend/models/pageProblems.ts` (fifth check) + `backend/tasks/simple/scan-page-problems.ts` (log line)
- Test: `backend/models/pages.test.ts`, `backend/models/tree.test.ts`, `backend/models/pageProblems.test.ts` (extend if exists, else create)

**Interfaces:**
- Produces: `WIKI.models.locales.isReservedLocaleCode(segment: string): Promise<boolean>` — true when `segment` case-insensitively equals any **installed** locale code (`getLocales()`, cached). Installed, not per-site-active, per the decision doc item 4: a locale can be activated later, and a page created under a then-inactive code would become unreachable the day it is.
- Produces: `PageProblemsReport` gains `localeCollisions: { count: number; entries: LocaleCollisionEntry[] }` with `LocaleCollisionEntry = { table: 'pages' | 'tree'; id: string; siteId: string; locale: string; path: string; collidingCode: string }`.

- [ ] **Step 1: Failing tests.**

```ts
// models/pages.test.ts
test('a page path whose first segment is an installed locale code is rejected', async () => {
  await assert.rejects(
    WIKI.models.pages.createPage(siteId, pageInput({ path: 'fr/shadowed', locale: 'en' }), actor),
    (err: any) => err.name === 'pageReservedLocaleSegment'
  )
})
test('movePage refuses a destination path starting with an installed locale code', async () => {
  const page = await WIKI.models.pages.createPage(siteId, pageInput({ path: 'move/ok', locale: 'en' }), actor)
  await assert.rejects(
    WIKI.models.pages.movePage(siteId, page.id, { path: 'en/shadowed' }, actor),
    (err: any) => err.name === 'pageReservedLocaleSegment'
  )
})
// models/tree.test.ts — createFolder at the root named after an installed code; renameFolder of a
// root folder to such a name; and the negative: a NESTED folder named 'fr' is fine (only the first
// segment shadows).
```

(Check what the `locales` table is seeded with in `test/db.ts` — `getLocales()` must return at least `en`/`fr` for these; if the fixture doesn't seed installed locales, seed them in the suite's `before()` by inserting rows the way `models/locales.ts`'s own init does, and clear the `locales` cache key on `WIKI.cache` if the stub caches.)

- [ ] **Step 2: Implement `isReservedLocaleCode`** in `models/locales.ts`:

```ts
  /**
   * Whether a path segment is reserved because it names an INSTALLED locale.
   *
   * Locale codes are reserved as first path segments for pages and folders (decision doc, Option A
   * item 4): on a site with `fr` active, a root folder `fr/` is unreachable — shadowed by
   * `stripLocalePrefix` — and one created while `fr` is merely installed becomes unreachable the
   * day it is activated. Case-insensitive, matching URL parsing.
   */
  async isReservedLocaleCode(segment: string): Promise<boolean> {
    if (!segment) {
      return false
    }
    const codes = (await this.getLocales()).map((lc: any) => String(lc.code).toLowerCase())
    return codes.includes(segment.toLowerCase())
  }
```

- [ ] **Step 3: Wire the write paths.**
  - `createPage` (after `normalizePath`) and `movePage` (after `normalizePath(path)`):

```ts
    const firstSegment = path.split('/')[0] ?? ''
    if (await WIKI.models.locales.isReservedLocaleCode(firstSegment)) {
      throw new CustomError(
        'pageReservedLocaleSegment',
        `"${firstSegment}" is an installed locale code and cannot begin a page path.`,
        400
      )
    }
```

  (in `movePage` use `newPath`.)
  - `tree.createFolder`: only a **root-level** folder can shadow — after the parent resolution (`:743-752`), when the resolved parent `path === ''`, run the same check on `name` with error `treeReservedLocaleSegment`. `renameFolder`: when `!folder.folderPath` (root), check `name` likewise.
- [ ] **Step 4: `pageProblems` fifth check.** Add to `scan()` a check that flags EXISTING rows grandfathered in: fetch installed codes once (`getLocales()`); then

```ts
    const codes = new Set(installed.map((lc) => String(lc.code).toLowerCase()))
    // pages: first segment of `path`; tree: root rows are fileName itself, nested rows' first
    // segment is the first label of folderPath
    const pageHits = pagesRows.filter((r) => codes.has((r.path.split('/')[0] ?? '').toLowerCase()))
    const treeHits = treeRows.filter((r) => {
      const first = r.folderPath ? decodeTreePath(r.folderPath)!.split('/')[0]! : r.fileName
      return codes.has(first.toLowerCase())
    })
```

Follow the existing four checks' structure exactly (how they select rows, shape entries, count) — read `pageProblems.ts:92-114` first and reuse its row fetch if the columns suffice. Extend `PageProblemsReport` (`:63-70`) and the task's log line in `scan-page-problems.ts` (`… duplicate paths, ${report.localeCollisions.count} locale-code collisions, …`).
- [ ] **Step 5:** Run the three test files → PASS; typecheck; oxlint. **Step 6: Commit** — `feat(locale): reserve installed locale codes as first path segments; scan reports existing collisions (#994)`.

---

### Task 13: Canonical URLs — prefixed→bare 302 (#994)

**Files:**
- Modify: `backend/helpers/common.ts` (new `localePrefixStripTarget` beside `localePrefixRedirectTarget:300`)
- Modify: `backend/index.ts:707-716` (the SEO hook's locale branch)
- Test: `backend/helpers/common.test.ts`

**Interfaces:**
- Produces: `localePrefixStripTarget(urlPath: string, locales?: LocaleRoutingConfig | null): string | null` — the mirror of `localePrefixRedirectTarget`: where that one adds a missing required prefix, this one removes (or re-cases) an unwarranted explicit one.

- [ ] **Step 1: Failing tests** (`common.test.ts`, same `locales()` fixture — note its default is `forcePrefix: true`, so pass `{ forcePrefix: false }` explicitly where needed):

```ts
describe('localePrefixStripTarget', () => {
  test('an explicit primary prefix is stripped', () => {
    assert.equal(localePrefixStripTarget('/en/guides/x', locales({ forcePrefix: false })), '/guides/x')
  })
  test('a bare locale-only primary path strips to the root', () => {
    assert.equal(localePrefixStripTarget('/en', locales({ forcePrefix: false })), '/')
  })
  test('a non-primary prefix is kept', () => {
    assert.equal(localePrefixStripTarget('/fr/guides/x', locales({ forcePrefix: false })), null)
  })
  test('under forcePrefix nothing is stripped', () => {
    assert.equal(localePrefixStripTarget('/en/guides/x', locales({ forcePrefix: true })), null)
  })
  test('a mis-cased prefix canonicalizes to the code as stored', () => {
    assert.equal(localePrefixStripTarget('/FR/guides/x', locales({ forcePrefix: false })), '/fr/guides/x')
  })
  test('a single-active-locale site strips its own explicit prefix', () => {
    assert.equal(localePrefixStripTarget('/en/guides/x', locales({ active: ['en'], forcePrefix: false })), '/guides/x')
  })
  test('an unprefixed path is not a candidate', () => {
    assert.equal(localePrefixStripTarget('/guides/x', locales({ forcePrefix: false })), null)
  })
})
```

- [ ] **Step 2: Implement:**

```ts
/**
 * Whether a page URL carries a locale prefix it should not (or spells one wrong), and if so, where
 * to redirect.
 *
 * The other half of `localePrefixRedirectTarget`: that one ADDS the prefix `forcePrefix` requires;
 * this one REMOVES an explicit prefix the site's rules leave bare (`/en/page` and `/page` are
 * otherwise two URLs for the same document — the sitemap, hreflang and caches all want exactly
 * one), and re-cases a recognized-but-mis-cased prefix to the code as stored in `active`. Returns
 * null when the URL is already canonical.
 *
 * @returns The canonical path to redirect to (query string reattached by the caller), or null
 */
export function localePrefixStripTarget(
  urlPath: string,
  locales?: LocaleRoutingConfig | null
): string | null {
  const stripped = stripLocalePrefix(urlPath, locales)
  if (!stripped) {
    return null
  }
  if (shouldPrefixLocale(stripped.locale, locales)) {
    const canonical = `/${stripped.locale}${stripped.path === '/' ? '' : stripped.path}`
    return canonical === urlPath ? null : canonical
  }
  return stripped.path
}
```

- [ ] **Step 3: Wire the hook** (`index.ts`, directly after the `localeRedirect` branch at `:710-715`; the two are mutually exclusive — `localePrefixRedirectTarget` only fires when NO prefix is present):

```ts
      // -> The mirror image: an explicit prefix the site's rules leave bare (`/en/page`) 302s to
      //    the one canonical URL (`/page`), and a mis-cased prefix re-cases. 302 for the same
      //    reason as above — which locales are active, and forcePrefix, are settings.
      const localeStrip = localePrefixStripTarget(trimmed, siteConfig?.locales)
      if (localeStrip) {
        reply.redirect(withQuery(localeStrip), 302)
        return
      }
```

Add `localePrefixStripTarget` to the `helpers/common.ts` import at `:38`. Note for reviewers: client-side SPA navigation to `/en/page` never hits this hook — the frontend router parses the prefix and renders the right page at a non-canonical address, which is cosmetic and acceptable; every full page load, crawler fetch and shared link gets the 302.
- [ ] **Step 4:** `node --test helpers/common.test.ts` → PASS; typecheck; oxlint. **Step 5: Commit** — `feat(url): one canonical URL per page — explicit prefixes 302 to their canonical form (#994)`.

---

### Task 14: Bug #949 — missing-page flow uses the stripped pair; userPermissions takes locale (#995)

**Files:**
- Modify: `backend/api/pages.ts` (userPermissions route `:1614+` — body schema + ref)
- Modify: `frontend/src/stores/user.js` (`fetchPagePermissions` `:206-224`), `frontend/src/pages/Index.vue` (catch branch `:813-833`), every other `fetchPagePermissions` caller (grep — includes the per-route refresh in `App.vue`)
- Test: `backend/api/pages.test.ts` (extend the existing harness)

**Interfaces:**
- Consumes: Task 3's ref shape (the endpoint must supply a locale to be answered correctly at all now).
- Produces: `POST /sites/:siteId/pages/userPermissions` body gains optional `locale` (defaulted server-side to the site primary); `userStore.fetchPagePermissions(path, locale)`.

- [ ] **Step 1: Backend.** userPermissions body schema gains `locale: { type: 'string', maxLength: 10 }`; handler resolves `const locale = req.body.locale ?? WIKI.sites[req.params.siteId]?.config?.locales?.primary ?? 'en'` and puts it (plus `siteId`) in the ref it checks. Add a test to the existing route's coverage in `api/pages.test.ts`: a group rule scoped `locales: ['fr']` granting `write:pages` answers true for `{ path: 'x', locale: 'fr' }` and false for `{ path: 'x', locale: 'en' }` — follow however the file already builds groups/rules for permission tests.
- [ ] **Step 2: Frontend `fetchPagePermissions(path, locale)`** — include `locale` in the JSON body when given. Grep callers and pass the right value at each: `App.vue`'s per-route refresh passes the same locale it just resolved for the route (it already computes `resolveRouteLocale` in `beforeEach` at `:418-425`; if the permissions refresh lives elsewhere in the file, thread `pageStore.locale`, which that guard just set).
- [ ] **Step 3: Index.vue catch branch** (`:824-833`) — the success path already computed the stripped pair at `:771-778` (`pagePath`, `pageLocale`), in scope in the catch. Use it:

```js
          pageStore.pageNotFound({ path: pagePath })
          await userStore.fetchPagePermissions(pagePath, pageLocale)
```

That single change fixes all three #949 consequences at once: the create screen shows the bare path, the permission probe asks about the real `(path, locale)` pair, and `createPage` (`:995`, `pageCreate({ path: pageStore.path })`) no longer bakes `fr/` into a page that is already `locale: 'fr'` (App.vue's guard set `pageStore.locale` from the prefix). Also pass the locale explicitly for self-evidence: `pageCreate({ editor, path: pageStore.path, locale: pageStore.locale })`.
- [ ] **Step 4:** Backend test PASS; `npx oxlint` both workspaces; `npm run typecheck`. **Step 5: Commit** — `fix(page-not-found): use the stripped (path, locale) pair for display, permissions and creation (#949, #995)`.

---

### Task 15: `/_edit` addresses the right translation (#995)

**Files:**
- Modify: `frontend/src/pages/Index.vue` (`/_edit` branch `:744-756`), `frontend/src/stores/page.js` (`pageEdit` `:580-619`)
- Modify: every `/_edit` push site — grep `'/_edit` and `` `/_edit `` across `frontend/src` and `blocks/`: known ones are `frontend/src/components/PageRedirect.vue:260-262` (`editPage`) and FileManager (already done in Task 7 Step 2); fix any others the grep finds the same way
- Test: none new (route-watcher plumbing; verified by lint/build)

**Interfaces:**
- Consumes: `resolveRouteLocale` (`pagePaths.js:112`) already reads `?locale=` for `/_` routes and App.vue's guard already sets `pageStore.locale` from it — the bug is that nothing SETS the param and `pageEdit` ignores the store.

- [ ] **Step 1: `pageEdit` threads a locale.** Signature → `pageEdit({ path, id, locale, fromNavigate = false } = {})`. In the path-addressed branch: `loadArgs.path = path; loadArgs.locale = locale ?? this.locale` — `this.locale` is what App.vue's guard resolved from `?locale=` (or defaulted to primary), so an un-migrated caller gets today's behavior and a `?locale=fr` visit loads the `fr` translation. (`pageLoad` already forwards `locale` to the API — `page.js:173-184`.)
- [ ] **Step 2: Index.vue `/_edit` branch** passes it explicitly:

```js
      await pageStore.pageEdit({
        path: route.params.pagePath,
        locale: typeof route.query.locale === 'string' ? route.query.locale : undefined,
        fromNavigate: true
      })
```

- [ ] **Step 3: Entry points set the param.** `PageRedirect.vue` `editPage`:

```js
function editPage() {
  router.push({
    path: `/_edit/${pageStore.path}`,
    query: siteStore.useLocales ? { locale: pageStore.locale } : undefined
  })
}
```

(import/instantiate `useSiteStore` if the component lacks it). Apply the same `query` shape to every other `/_edit` push the grep finds, sourcing the locale from the entity being edited (`pageStore.locale`, a row's `locale`, etc. — never `commonStore.locale`).
- [ ] **Step 4:** `npx oxlint`; `npm run build` green. **Step 5: Commit** — `fix(edit): /_edit carries ?locale= from every entry point and pageEdit honors it (#995)`.

---

### Task 16: Sitemap emits localized URLs + hreflang clusters (#995)

**Files:**
- Modify: `backend/controllers/seo.ts` (`SitemapPage` `:10-14`, `buildSitemapXml` `:57-78`, route `:103-112`)
- Test: `backend/controllers/seo.test.ts` (extend if exists — grep; else create as a pure-unit suite, `buildSitemapXml` needs no WIKI)

**Interfaces:**
- Consumes: Task 9's backend `localizedPagePath`; Task 13 guarantees the emitted forms are the canonical ones. `listPagesForSitemap` (`models/pages.ts:1194-1229`) **already returns `locale`** — only the XML builder drops it.
- Produces: `SitemapPage = { path: string; locale: string; updatedAt: Date }`; `buildSitemapXml(baseUrl: string, pages: SitemapPage[], locales?: LocaleRoutingConfig | null): string`.

- [ ] **Step 1: Failing test** (pure unit):

```ts
test('translations emit localized URLs with a full hreflang cluster', () => {
  const xml = buildSitemapXml(
    'https://wiki.example.com',
    [
      { path: 'guides/x', locale: 'en', updatedAt: new Date('2026-08-01T00:00:00Z') },
      { path: 'guides/x', locale: 'fr', updatedAt: new Date('2026-08-02T00:00:00Z') },
      { path: 'solo', locale: 'en', updatedAt: new Date('2026-08-03T00:00:00Z') }
    ],
    { primary: 'en', active: ['en', 'fr'], forcePrefix: false }
  )
  assert.match(xml, /<loc>https:\/\/wiki\.example\.com\/guides\/x<\/loc>/)
  assert.match(xml, /<loc>https:\/\/wiki\.example\.com\/fr\/guides\/x<\/loc>/)
  // both cluster members list BOTH alternates (Google requires self-inclusion)
  assert.equal((xml.match(/hreflang="en" href="https:\/\/wiki\.example\.com\/guides\/x"/g) ?? []).length, 2)
  assert.equal((xml.match(/hreflang="fr" href="https:\/\/wiki\.example\.com\/fr\/guides\/x"/g) ?? []).length, 2)
  // a page with no translations carries no alternate links
  assert.doesNotMatch(xml, /solo"[^>]*hreflang/)
  assert.match(xml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/)
})
```

- [ ] **Step 2: Implement.** `SitemapPage` gains `locale: string` (update its doc comment — the omission was the bug). `buildSitemapXml`:

```ts
export function buildSitemapXml(
  baseUrl: string,
  pages: SitemapPage[],
  locales?: LocaleRoutingConfig | null
): string {
  // -> Translations share a path (that is the whole translation link in this data model), so the
  //    hreflang cluster for a page is every row with its path
  const clusters = new Map<string, SitemapPage[]>()
  for (const page of pages) {
    const list = clusters.get(page.path) ?? []
    list.push(page)
    clusters.set(page.path, list)
  }
  const urls = pages
    .map((page) => {
      const loc = escapeXml(`${baseUrl}${localizedPagePath(page.path, page.locale, locales)}`)
      const lastmod = page.updatedAt
        .toTemporalInstant()
        .toZonedDateTimeISO('UTC')
        .toPlainDate()
        .toString()
      const cluster = clusters.get(page.path)!
      // -> Every member of a multi-locale cluster lists every alternate, itself included — the
      //    reciprocity hreflang consumers require. A lone page lists nothing.
      const alternates =
        cluster.length > 1
          ? cluster
              .map(
                (alt) =>
                  `    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.locale)}" href="${escapeXml(`${baseUrl}${localizedPagePath(alt.path, alt.locale, locales)}`)}"/>`
              )
              .join('\n') + '\n'
          : ''
      return `  <url>\n    <loc>${loc}</loc>\n${alternates}    <lastmod>${lastmod}</lastmod>\n  </url>`
    })
    .join('\n')
  const body = urls ? `\n${urls}\n` : '\n'
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${body}</urlset>\n`
}
```

Route: `buildSitemapXml(baseUrl, pages, site.config?.locales)` (the site row is already in hand at `:104`). Import `localizedPagePath` and the `LocaleRoutingConfig` type from `../helpers/common.ts`.
- [ ] **Step 3:** Test PASS; typecheck; oxlint. **Step 4: Commit** — `fix(seo): sitemap emits localized URLs with hreflang clusters instead of duplicated bare paths (#995)`.

---

### Task 17: App shell renders the request's locale for lang/dir (#995)

**Files:**
- Modify: `backend/helpers/appShell.ts` (new `resolveAppShellLocale`), `backend/index.ts` (`setNotFoundHandler` `:836-841`)
- Test: `backend/helpers/appShell.test.ts` (extend if exists, else create — pure unit)

**Interfaces:**
- Produces: `resolveAppShellLocale(urlPath: string, search: string | undefined, locales?: LocaleRoutingConfig | null): string` — the request's resolved content locale: the URL's active-locale prefix; for `/_` app routes, a valid `?locale=`; else the site primary.

- [ ] **Step 1: Failing tests:**

```ts
const cfg = { primary: 'en', active: ['en', 'ar'], forcePrefix: false }
test('a locale-prefixed page path resolves to its own locale', () => {
  assert.equal(resolveAppShellLocale('/ar/guides/x', undefined, cfg), 'ar')
})
test('an app route reads ?locale=', () => {
  assert.equal(resolveAppShellLocale('/_edit/guides/x', 'locale=ar', cfg), 'ar')
})
test('an invalid query locale falls back to the primary', () => {
  assert.equal(resolveAppShellLocale('/_edit/guides/x', 'locale=zz', cfg), 'en')
})
test('a bare path is the primary', () => {
  assert.equal(resolveAppShellLocale('/guides/x', undefined, cfg), 'en')
})
```

- [ ] **Step 2: Implement** in `appShell.ts` (import `stripLocalePrefix` + the type from `./common.ts`):

```ts
/**
 * The locale the app shell should be stamped with (`<html lang dir>`) for one request — the same
 * resolution the frontend's `resolveRouteLocale` performs once booted, done server-side so an RTL
 * translation never flashes LTR (the exact flash the shell templating exists to prevent).
 */
export function resolveAppShellLocale(
  urlPath: string,
  search: string | undefined,
  locales?: LocaleRoutingConfig | null
): string {
  const primary = locales?.primary ?? 'en'
  if (urlPath.startsWith('/_')) {
    const candidate = search ? new URLSearchParams(search).get('locale') : null
    const match = candidate
      ? locales?.active?.find((code) => code.toLowerCase() === candidate.toLowerCase())
      : null
    return match ?? primary
  }
  return stripLocalePrefix(urlPath, locales)?.locale ?? primary
}
```

- [ ] **Step 3: Wire the handler** (`index.ts:836-841`) — the handler already splits `req.raw.url`; keep the query half instead of discarding it:

```ts
      const [urlPathOnly, urlSearch] = req.raw.url!.split('?')
      ...
      const lang = resolveAppShellLocale(urlPathOnly!, urlSearch, siteConfig?.locales)
```

(replacing `const lang = siteConfig?.locales?.primary ?? 'en'`; the `isRTL` lookup below it stays — it already keys off `lang`). NOTE the handler's existing `urlPath` variable at `:825` is used for the system-path checks — rename carefully or reuse it; don't shadow.
- [ ] **Step 4:** Tests PASS; typecheck; oxlint. **Step 5: Commit** — `fix(shell): lang/dir follow the request's locale, killing the RTL flash (#995)`.

---

### Task 18: Notifications and mail carry the page's locale (#995)

**Files:**
- Modify: `backend/db/schema.ts` (`pageWatchEvents` ~`:927-931`) + generated migration
- Modify: the `pageWatchEvents` writer (grep `insert(pageWatchEvents` / the model that records watch events — likely `models/pageWatching.ts` or the pages model's notify path), `backend/api/notifications.ts` (projection + response schema), `backend/models/mail.ts` (`WatchEventItem`, `renderWatchEventLine` `:293-325`)
- Modify: `frontend/src/pages/InboxWatching.vue` (`openPage`/`openNotification` `:218-234`, bare caption `:32`)
- Test: `backend/models/mail.test.ts` (extend if exists; else the send-watch-digests test — `tasks/simple/send-watch-digests.test.ts` exists and exercises the render path)

**Interfaces:**
- Produces: `pageWatchEvents.pageLocale: text().notNull().default('en')` — captured at write time like `pagePath`/`pageTitle` (the row must outlive the page; the default exists only so the migration applies to a table with rows — writers always set it); notifications API rows gain `pageLocale`; `WatchEventItem.page` gains `locale: string`.

- [ ] **Step 1: Schema + migration.** Add below `pagePath`:

```ts
    /** The page's locale as of this change, for the same reason `pagePath` is captured here. */
    pageLocale: text().notNull().default('en'),
```

`npm run db-generate`; commit the migration (no hand edit needed — the default satisfies existing rows).
- [ ] **Step 2: Writer + API.** Grep the insert into `pageWatchEvents` and record the page's `locale` alongside `pagePath`. `api/notifications.ts`: add `pageLocale` to the row projection and the route's response schema properties.
- [ ] **Step 3: mail.ts.** `WatchEventItem`'s `page` gains `locale: string`; `renderWatchEventLine` composes the link with the canonical composer — the enclosing senders (`sendPageWatchNotification` / `sendPageWatchDigest`) have `siteId`, so resolve `const locales = WIKI.sites[siteId]?.config?.locales` there and thread it (or the composed path) in. Replace `this.buildLink(`/${page.path}`)` with `this.buildLink(localizedPagePath(page.path, page.locale, locales))`. Rewrite the `@param page.path` doc at `:308-309` — its claim "the wiki's page route has no locale segment" is false and this change retracts it in code and prose at once.
- [ ] **Step 4: InboxWatching.vue.**

```js
function openPage(page) {
  router.push(localizedPagePath(page.path, page.locale, siteStore.localeRouting))
}
async function openNotification(notification) {
  await markRead(notification, { silent: true })
  router.push(localizedPagePath(notification.pagePath, notification.pageLocale, siteStore.localeRouting))
}
```

(imports: `localizedPagePath` from `@/helpers/pagePaths`, `useSiteStore` if absent; `WatchedPage` rows already carry `locale` — `models/pageWatching.ts:68-81`.)
- [ ] **Step 5:** Extend the digest/mail test to assert a non-primary-locale event's link contains `/fr/`; run it + typecheck + oxlint both workspaces. **Step 6: Commit** — `feat(watch): notifications and mail record and link the page's locale (#995)`.

---

### Task 19: Remaining bare-path link sites (#995)

**Files:**
- Modify: `frontend/src/pages/Search.vue:187,196`, `frontend/src/components/HeaderSearch.vue:160,172`, `frontend/src/components/PageHistoryOverlay.vue:686`, `frontend/src/pages/AdminPagesDeleted.vue:272`, `frontend/src/components/PageRedirect.vue` (target composition feeding `:252`), `blocks/block-index/component.js:386`
- Excluded (already done): FileManager (Task 7), `stores/page.js:662` (Task 8), InboxWatching (Task 18)
- Test: none new (template link plumbing) — oxlint + `npm run build` in `frontend/`, `npm run build` in `blocks/`

Each site's locale source is confirmed present in its row data:

- [ ] **Step 1: Search.vue + HeaderSearch.vue.** `SearchResult` carries `locale` (`models/search.ts:55-66`). Template: `:to="localizedPagePath(item.path, item.locale, siteStore.localeRouting)"` (both components; add the `localizedPagePath` import and a `siteStore` instance where missing). Leave the visible `/{{ item.path }}` captions as the bare path — that is the page's identity; only the navigation target changes.
- [ ] **Step 2: PageHistoryOverlay.** The branch-to-new-page POST already sends the version's own locale (`full.locale || pageStore.locale`) and the response page carries it back; follow with `router.push(localizedPagePath(page.path, page.locale, siteStore.localeRouting))`.
- [ ] **Step 3: AdminPagesDeleted.** `router.push(localizedPagePath(resp.page.path, resp.page.locale, siteStore.localeRouting))` (the recover response's page carries `locale`; the recovery locale is `overrides.locale ?? row.locale`).
- [ ] **Step 4: PageRedirect.** Read how `redirect.value` is composed in the component (above `:241`). For the in-app (`kind !== 'url'`) case: if the author-written target already carries an active-locale prefix (`parseLocalePrefix(target, activeCodes)` non-null), leave it verbatim — the author addressed a specific translation; otherwise wrap it: `localizedPagePath(bareTarget, pageStore.locale, siteStore.localeRouting)` — a redirect page's target stays within its own locale by default. Implement at the composition site, not inside `go()`.
- [ ] **Step 5: block-index.** Every row is in `WIKI_STATE.page.locale` by construction (the fetch at `:376` sends it). Blocks can't import frontend helpers (separate workspace) — inspect what `WIKI_STATE.site` exposes: if it carries the locales config (`primary`/`active`/`forcePrefix` in some shape), compose locally:

```js
      const locales = WIKI_STATE.site?.locales
      const pageLocale = WIKI_STATE.page?.locale
      const prefix =
        locales?.active?.length > 1 && pageLocale && (pageLocale !== locales.primary || locales.forcePrefix)
          ? `/${pageLocale}`
          : ''
      this._pages = pages.map((p) => ({ ...p, href: `${prefix}/${p.path}` }))
```

If `WIKI_STATE.site` does NOT expose the locales config, extend the place the frontend builds `WIKI_STATE` (grep `WIKI_STATE` in `frontend/src` — likely a boot file or App.vue) to include `{ primary, forcePrefix, active: [...codes] }`, then use the snippet. Add a `component.test.js` case only if the block already has a suite covering `connectedCallback` fetch mapping; otherwise leave to the existing coverage pattern.
- [ ] **Step 6:** `npx oxlint` + `npm run build` (frontend), `npm run build` (blocks). **Step 7: Commit** — `fix(links): every page link carries its target's locale prefix (#995)`.

---

### Task 20: Small hardcodes — PageHeader primary-locale gate, MainLayout i18n (#995)

**Files:**
- Modify: `frontend/src/components/PageHeader.vue:596,600`, `frontend/src/layouts/MainLayout.vue:19,21`
- Modify: `backend/locales/en.json` (new key in the `common.sidebar.*` block, `:1708-1711`)
- Excluded (already done): breadcrumbs `locale: 'en'` (Task 10)
- Test: none new — oxlint + build

- [ ] **Step 1: PageHeader.** `:596`: `pageStore.locale === 'en'` → `pageStore.locale === siteStore.locales.primary` (the Welcome overlay is a primary-locale concern, not an English one; verify `siteStore` is instantiated in the component — it is used at `:598`). `:600`: the create-discard `router.replace('/')` drops a non-primary-locale author to the primary home; replace with:

```js
    router.replace(shouldPrefixLocale(pageStore.locale, siteStore.localeRouting) ? `/${pageStore.locale}` : '/')
```

(import `shouldPrefixLocale` from `@/helpers/pagePaths`).
- [ ] **Step 2: MainLayout.** Both literal `Switch Locale` strings (`:19` aria-label, `:21` tooltip) → `t('common.sidebar.switchLocale')` (the component already has `const { t } = useI18n()` at `:207`; the aria-label becomes `:aria-label="t('common.sidebar.switchLocale')"`). Add to `backend/locales/en.json`, alphabetically in its block:

```json
  "common.sidebar.switchLocale": "Switch Locale",
```

- [ ] **Step 3:** oxlint + `npm run build` (frontend). **Step 4: Commit** — `fix(frontend): primary-locale gates and i18n'd locale-switcher strings (#995)`.

---

### Task 21: Locale deactivation refuses to orphan content (#995)

**Files:**
- Modify: `backend/api/sites.ts` (locale validation block `:654-682`)
- Modify: `backend/locales/en.json` (`admin.locale.siteUpdateLocaleHasPages`)
- Test: `backend/api/sites.test.ts` (extend if it exists; else `backend/models/sites.test.ts`'s DB harness with a direct call to the extracted check — see Step 2)

- [ ] **Step 1: Failing test.** Preferred home: the API test harness (`backend/api/pages.test.ts` proves one exists — reuse its boot pattern; check for an existing `api/sites.test.ts` first). Scenario: site with `active: ['en','fr']`, one `fr` page; `PUT /sites/:id` with `locales.active: ['en']` → 409, error `siteUpdateLocaleHasPages`, message naming `fr (1)`; after deleting the page, the same PUT succeeds.
- [ ] **Step 2: Implement** — append inside the existing `if (req.body.locales)` block, after the primary-active check at `:676-681`:

```ts
        // -> Deactivating a locale that still holds pages would orphan them: unreachable by URL
        //    (the prefix parser only recognizes ACTIVE codes), uncreatable, yet still surfacing in
        //    the file manager and search. Refuse with counts; moving or deleting the pages first is
        //    the explicit path. (Decision doc, Option A item 5.)
        const removedLocales = (site.config.locales?.active ?? []).filter(
          (code: string) => !active.includes(code)
        )
        if (removedLocales.length > 0) {
          const counts = await WIKI.db
            .select({ locale: pagesTable.locale, total: count() })
            .from(pagesTable)
            .where(
              and(eq(pagesTable.siteId, req.params.siteId), inArray(pagesTable.locale, removedLocales))
            )
            .groupBy(pagesTable.locale)
          if (counts.length > 0) {
            throw new CustomError(
              'siteUpdateLocaleHasPages',
              `Cannot deactivate locale(s) still holding pages: ${counts
                .map((c) => `${c.locale} (${c.total})`)
                .join(', ')}. Move or delete those pages first.`,
              409
            )
          }
        }
```

Add the missing imports to `api/sites.ts` (`count`, `inArray` from `drizzle-orm`; `pages as pagesTable` from `../db/schema.ts` — match the file's existing import style; `and`/`eq` may already be there). The "block with a count" option is the decision (vs. offering migrate/delete) — cheapest safe behavior; a migrate flow can be a later feature if ever wanted. `AdminLocale.vue`'s error handling already maps new codes to `admin.locale.<code>` (`:288`), so add to `en.json`:

```json
  "admin.locale.siteUpdateLocaleHasPages": "This locale still holds pages. Move or delete them before deactivating it.",
```

- [ ] **Step 3:** Run the test file → PASS; typecheck; oxlint. **Step 4: Commit** — `feat(sites): deactivating a locale with content is refused with counts (#995)`.

---

## Execution notes (coordinator)

- **Worktree:** create via superpowers:using-git-worktrees before ANY implementation; verify `pwd` is inside it; pass the absolute worktree path to every subagent, whose first action is `cd` there. This plan file lives in the main checkout — pass its absolute path too.
- **Sequencing:** Tasks 1–2 (#991) and 3–8 (#992) first — they stop live data corruption. Tasks 3+4 form one typecheck-atomic pair. Then 9–11 (#993, needs Task 8), 12–13 (#994), 14–21 (#995) — 14 depends on 3/4; 16 on 9 and 13; 18/19 on 9/10. #996 is skipped until asked.
- **OpenProject:** the coordinator (not subagents) transitions each feature WP (`In progress` when its first task starts, the completed status the workflow offers when its last task's review passes) and bugs #932 (after Task 5) / #949 (after Task 14) via `mcp__openproject__transition_status`.
- **Verification bar per task:** zero errors AND zero warnings from `npm run typecheck` (backend), `npx oxlint` (touched workspaces), the named scoped tests, `npm run db-generate` output committed for schema tasks. Frontend-heavy tasks also keep `npm run build` green. Never run full suites.

## Self-review record

- **Spec coverage:** #991 → Tasks 1–2 (indexes, supporting index, 409s, migration). #992 → 3–8 (fail-closed rules incl. sites-prefilter + case normalization; cascades #932; getTree; movePage). #993 → 9–11 (canonical pair ports; git strict parsing + orphaned asset; convention recorded; renderedContent documented as a deliberate non-change). #994 → 12–13 (reserved names + scan; canonical 302 both directions — bare→prefixed already existed). #995 → 14–21 (#949; /_edit; sitemap/hreflang; app shell; ten link sites — FileManager in T7, pageMove-follow in T8, Inbox in T18, remainder in T19; hardcodes split T10/T20; deactivation). #996 deliberately excluded.
- **Known open risk, decided:** the tree partial-unique pair cannot express the page↔asset cross-partition exclusion — app probes stay authoritative for that one case (documented in Task 1).
- **Type consistency check:** `RulePageRef` (T3) consumed by T4/T8/T12/T14/T16 with `locale: string | null`, `siteId: string | null` throughout; `localizedPagePath(path, locale, locales)` backend (T9) consumed by T11-comment/T16/T18; frontend `siteStore.localeRouting` (T10) consumed by T7/T8/T18/T19/T20; `mayOnFolder(req, permission, siteId, path, locale)` and `visibleTreeItems(req, siteId, locale, items)` (T4) consumed by T6; `movePage` third arg `{ path, title, locale }` (T8) consumed by T11's sync call site (wired in T8 Step 6). Verified consistent.


