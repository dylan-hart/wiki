# Cardinal.js backend

Backend-specific conventions for `backend/`. See the root `CLAUDE.md` for what spans the whole
repo (product naming, permissions, icons, commands, the verify-ci gate).

## Layout

Entry point is `backend/index.ts`, and it must be run **from the repo root** (`node backend`), not
from inside `backend/`. It boots in three phases: `preBoot()` (config → db → models → cache →
scheduler → event emitters), `initHTTPServer()` (Fastify plugins, auth, routes), `postBoot()`
(refresh locales/strategies/sites from disk & db, start scheduler).

- `api/` — REST route plugins, one file **or directory** per resource (`sites.ts`, `locales.ts`,
  `assets.ts`, `tree.ts`, …, plus `pages/`, `users/`, `system/` and `auth/`), registered by
  `api/index.ts` under the `/_api` prefix.
  - **A resource too large for one file is a directory whose `index.ts` is its plugin**, split into
    sub-plugins by responsibility: `pages/{read,write,history,import,export,classification}.ts`,
    `users/{admin,profile}.ts`, `system/{info,settings,maintenance,transfer,extensions}.ts`,
    `auth/{provider,site,strategies}.ts`. The aggregate `index.ts` registers each **unprefixed** — a
    sub-plugin declares whole paths, so a prefix of its own would move every route it owns — and the
    mounted table is identical to the single file it replaced. Two consequences: `register()` is a
    real encapsulation boundary, so a body parser or `@fastify/multipart` registered inside a
    sub-plugin is scoped to that sub-plugin alone (`pages/import.ts` owns the `'*'` buffer parser,
    `system/transfer.ts` the gzip one) and an unmatched `Content-Type` sent to a sibling
    sub-plugin's route answers 415 rather than reaching the parser; and **a route file must never
    import another route file** — shared route logic belongs in `helpers/` (`helpers/pageAccess.ts`
    is what that rule produced), which is also what lets the structural scans in
    `api/routeTags.test.ts`, `api/responseErrors.test.ts` and `api/index.test.ts` treat everything
    under `api/` as a plugin.
  - `api/schemas/` — shared JSON Schemas registered via `app.addSchema()` and referenced from route
    schemas as `{ $ref: 'Site#' }`. Register new shared schemas in `api/index.ts` _before_ the
    routes; `api/index.ts#registerAllSchemas(app)` is the exported whole set, which is what a test
    harness installs rather than re-listing. `api/schemas/params.ts` covers `params:` the same way —
    `SiteIdParams`, `SitePageParams`, `SiteFolderParams`, `SiteTagParams`, `SitePageCommentParams` —
    so a site-scoped route writes `params: { $ref: 'SiteIdParams#' }` rather than a fresh literal. A
    route whose params carry anything else (a `kind`, an `alias`, a one-off `:xId`) keeps its own.
- `controllers/` — non-API HTTP routes: `site.ts` serves per-site resources (logo, favicon, login
  background) under `/_site`; `icons.ts` serves icons under `/_icons`, implementing the part of the
  Iconify API protocol the frontend speaks (`/_icons/<prefix>.json?icons=a,b` and
  `/_icons/<prefix>/<name>.svg`), public and cached hard — see root CLAUDE.md's Icons section;
  `blocks.ts` serves a
  custom block's compiled JS under `/_blocks/custom/:siteId/:blockId.js`; `files.ts` serves stored
  assets; `render.ts` serves a rendered page; `thumb.ts` serves page/asset thumbnails; `collab.ts` is
  the Yjs collaborative-editing WebSocket upgrade; `metrics.ts` exposes Prometheus metrics;
  `seo.ts` serves `robots.txt`/`sitemap.xml`; `terminal.ts` and `user.ts` round out the set.
- `core/` — long-lived singletons: `config.ts` (yml + db-backed settings), `db.ts` (pg pool, Drizzle
  instance, migrations, LISTEN/NOTIFY pubsub), `logger.ts`, `scheduler.ts` (poolifier thread pool +
  postgres-backed job queue), `collab.ts` (the Yjs collaborative-editing sync/awareness protocol,
  driven by `controllers/collab.ts`'s WebSocket upgrade), `maintenance.ts` (the admin utilities view's
  cross-instance actions — clear cache, drop websockets — broadcast over the event bus so every
  instance runs them, not just the one that received the route), `temporal.ts` (`ensureTemporal()`),
  `processGuards.ts` (the one `unhandledRejection` handler).
  - `core/http/` — everything `index.ts` used to do to a Fastify instance: `server.ts`
    (`createHttpApp()` — instance options, gracefulServer, `sensible`/`compress`/`websocket`,
    `WIKI.app`/`WIKI.server`; plus `registerStaticAssets(app)`), `security.ts` (helmet/CSP/CORS),
    `session.ts` (cookie + `@fastify/session` + the cookie-security diagnostic hook), `openapi.ts`
    (swagger + swagger-ui), `authHooks.ts` (API-key bearer, same-origin gate, the two rate limiters,
    the route-permission `preHandler`, the API-key site pin), `siteRouting.ts`
    (`RESERVED_ROOT_FILES` / `SERVER_ROUTE_SEGMENTS` / `isPageUrl`, the SEO redirects, per-request
    site resolution, the app-shell not-found fallback), `errors.ts` and `routes.ts` (every mounted
    prefix). `index.ts` is now only the boot script: the `WIKI` literal, the three phases,
    `app.listen()`. **Registration order is behaviour** — Fastify registers plugins in call order,
    so `registerStaticAssets(app)` staying between `registerSecurity(app)` and
    `registerSession(app)` is a real constraint, not tidiness.
- `db/` — `schema.ts` (all Drizzle table definitions), `relations.ts`, `migrations/` (generated).
- `models/` — data-access classes over Drizzle, aggregated by `models/index.ts` and exposed as
  `WIKI.models.*`. Business logic belongs here, not in route handlers. `types.ts` holds the shared
  `SystemIds` passed to each model's `init()` during first-run seeding. A model too large for one
  file is split by subject into siblings, each its own `WIKI.models` member: **rendering is two
  models** — `rendering.ts` is the post-process pipeline a save runs through, `renderQueue.ts` the
  headless-browser queue (their shared sanitizer policy is `helpers/htmlSanitizePolicy.ts`);
  **`users` no longer holds login** — `login.ts` owns login/register/2FA-login/forgot/reset,
  `userCredentials.ts` owns passwords, 2FA, recovery codes and the `userKeys` token pair (its
  `verifyTfaCode` re-reads the row inside the per-user advisory lock, so a correct code for an
  account deleted mid-verification is refused, not accepted), and
  `users.ts` keeps the account itself (CRUD, profile, avatar, groups, `updateSession`); **approvals
  is three** — `approvals.ts` (submissions and `reviewerScopeFor`), `approvalRules.ts` (rules, their
  cache, `matchesPage`) and `approvalNotifications.ts` (the mail). `assetServing.ts` and
  `pageClassification.ts` are the other two splits.
- `modules/` — pluggable extensions, discovered from disk. Each module is a directory with a
  `definition.yml` (key, title, props/config schema) plus its implementation — e.g.
  `modules/authentication/local/`. Six kinds exist: `authentication/`, `storage/` (7 modules —
  `disk`, `s3`, `azure`, `gcs`, `sftp`, `git`, `db` — each shipping a real `storage.ts`; see
  `models/storage.ts`), `search/`, `analytics/`, `comments/`, `extensions/`. The discovery/config/
  load boilerplate is `helpers/moduleRegistry.ts`, once, for all six module-backed models; a
  module's own `definition.yml` declares props and actions only — **there is no
  `setup`/`setupDestroy` extension point**, so a storage module exports `validateConfig`, the
  content-dispatch handlers and its `definition.yml` action handlers and nothing else.
  - `modules/storage/blobBase.ts` — `s3`, `azure` and `gcs` are **drivers**, not standalone modules:
    each owns its SDK imports, client construction and bucket verification and exports
    `blobStorageModule({ label, build, put, remove, copy, sign })`. The activation cache, the object
    key (`keyFor`), the `Failed to <action>: <message>` wrapping, `DIRECT_ACCESS_TTL_SECONDS` and
    all five lifecycle handlers live in `blobBase.ts` only. A fourth blob target is a driver.
  - `modules/search/{shared,externalBase}.ts` — the five engines share their vocabulary
    (`escapeHtml`, the highlight markers, the scan/indexing caps, `batchBySize`,
    `SearchDocument`/`buildSearchDocument`, `pageStream`, `filterVisible`, `toSearchPagesResult`)
    and the four page-lifecycle forwarders plus the never-throws wrapper (`ExternalSearchModule`). A
    new engine extends `ExternalSearchModule` and imports from `shared.ts`; it does not re-declare
    any of them, and it does not re-derive `totalHits`/`totalHitsApproximate` (only
    `shared.ts#toSearchPagesResult` does, off permission-filtered rows). `db` deliberately stays on
    the bare `SearchModule` interface — its `deleted` is a genuine no-op and its `renamed` only acts
    on a locale change — and imports from `shared.ts` alone. Every engine reads its per-site config
    through `search.getEngineConfig(siteId, key)` and never re-applies a `definition.yml` default by
    hand, which is what makes `index.ts` calling `refreshFromDisk()` before `initActiveEngines()`
    load-bearing.
- `mcp/` — the in-process Model Context Protocol server (`bootstrap.ts`, `auth.ts`, `http.ts`),
  exposing wiki content/actions to an MCP-speaking client over the instance's own HTTP surface.
  `mcp/tools/renderDiagram.ts` delegates to the same `models/diagramRender.render()` that
  `POST /_api/diagrams/render` calls — that REST route stays published (it's Swagger-documented,
  `tags: ['Diagrams']`) rather than being retired for having no first-party caller, since deleting a
  documented public endpoint is a breaking change to a contract an external integrator may already
  depend on.
- `migration/` — the 2.5.x-to-3.0 import CLI: `cli.ts` and `orchestrator.ts` drive a source
  `connector.ts`/`connectors/` implementation through staged `phases/`, `importers/` (every
  importer, one per record class) and `mappers/` for field translation, recording a dry-run report
  along the way. `report.ts` is the one report module (the `PhaseReport`/`UnmappableEntry` shapes,
  the auth classification, the table/JSON rendering). It consolidates exactly **one** 2.5.x source
  into one fresh 3.0 instance — there is no multi-source conflict policy. Three shared helpers new
  code uses rather than re-deriving: `phases/route.ts#routeOutcome` (the only place a phase turns an
  already-attempted per-record import into a `WriteRecorder` call — the write always happens
  *before* routing, never as `recorder.create()`'s callback), `phases/dry-run.ts`
  (`writeUnlessDryRun`, `placeholderRow`) and `mappers/shared.ts` (`isPlainObject`,
  `transformConfig`, `unwrapKnexValue`, and both of `pickDefined` / `pickPresent` — **do not** swap
  these for `es-toolkit`'s, whose `isPlainObject` rejects the class instances a `pg` row is). See
  `docs/migration/` for the source-schema and field-mapping specs this reads against.
- `tasks/simple/` — jobs run in-process by the scheduler; each exports `task()`. File name is
  kebab-case, the task key is its camelCase form.
- `tasks/workers/` — CPU-bound jobs run in a worker thread via `worker.ts`, which boots a minimal
  `WIKI` global (config + logger + lazy `ensureDb()`) and dynamically imports the task.
- `base.yml` — system defaults for every config key. Do not edit as a user-facing config; it defines
  the shape merged with `config.yml` and the db `settings` table.
- `helpers/` — small pure utilities. `common.ts` is the general bag (the tree-path codec,
  `normalizePagePath`, `requestOrigin`, the hash/uuid helpers, `isUniqueViolation`,
  `escapeLikePattern`, `BCRYPT_ROUNDS`, `CustomError`, …); the clusters that outgrew it have their
  own file and there is **no re-export shim**, so importing a moved symbol from `common.ts` is a
  type error on purpose: `siteResolution.ts` (hostname → site, `resolveSiteParam`,
  `guardSiteEnabled`, `siteEnabledPreHandler`), `localeRouting.ts` (`defaultLocale`,
  `assertLocaleActive`, the locale-prefix redirect/strip targets), `moduleProps.ts`
  (`parseModuleProps`, the sensitive-config mask), `pageAccess.ts` (the page/asset/folder access
  questions), `moduleRegistry.ts`, `clusterCache.ts`, `pagination.ts`, `timeout.ts`, `httpCache.ts`,
  `fsPurge.ts`, `htmlSanitizePolicy.ts`, `approvalMatch.ts`, `blobTarget.ts`,
  `pageSerialization.ts`, `pageRules.ts`, `siteRules.ts`, `permissions.ts`, `config.ts`, … See
  [Backend patterns](#backend-patterns) for which question each answers.
- `types/` — ambient declarations: `global.d.ts` (the `WIKI` global) and `fastify.d.ts` (session +
  route-permission augmentations).
- `locales/` — `en.json` source strings (Localazy-managed) + `metadata.js` language table (the one
  remaining JavaScript file; typed by its sibling `metadata.d.ts`).

## TypeScript (backend)

The backend is entirely **TypeScript 7** (the native Go compiler — `tsc` is a platform binary, not a
JS bundle). The only remaining `.js` is `locales/metadata.js`, which is Localazy-generated output and
is typed by a sibling `locales/metadata.d.ts`.

**There is no build step.** Node 26 runs `.ts` files directly by stripping types at load time, so
`node backend` and nodemon keep working unchanged as files are converted. `tsc` is used purely as a
type checker (`noEmit`) — never to produce output. Do not add a build/dist step.

Consequences of type stripping, all enforced by `backend/tsconfig.json`:

- **Relative imports must carry the real extension.** A `.ts` file importing a converted module writes
  `./core/config.ts`, not `./core/config.js` and not extensionless — Node resolves the literal path.
  This means converting a file requires updating the specifier in every file that imports it.
  (`allowImportingTsExtensions`)
- **Only erasable syntax is allowed** — no `enum`, no `namespace`, no constructor parameter
  properties, no `experimentalDecorators`. Use union types or `as const` objects instead of enums.
  (`erasableSyntaxOnly`)
- **Type-only imports must say `import type`**, otherwise the import survives erasure and Node tries
  to load a value that doesn't exist. (`verbatimModuleSyntax`)

`allowJs` is **off** — the backend is fully TypeScript, so a stray `.js` file would silently escape
type checking rather than be quietly tolerated. `locales/metadata.js` is the sole exception and is
resolved through its sibling `metadata.d.ts`.

`backend/types/global.d.ts` declares the ambient `WIKI` global as the `WikiGlobal` interface, wired
to the real module types (`WIKI.db` is the Drizzle instance, `WIKI.models` is `models/index.ts`, and
so on). Only `config` and `data` stay `any` — both are assembled at runtime from YAML plus a JSONB
settings table, so they have no static shape. `index.ts` and `worker.ts` build their own local `WIKI`
literal and assert it to `WikiGlobal`, since each populates the object progressively.

`backend/types/fastify.d.ts` augments Fastify: session fields (`authenticated`, `user`,
`permissions`) and the per-route `config.permissions` used by the `preHandler` permission hook.

**Five dynamic paths are extension-sensitive** and invisible to the type checker — they must be
updated by hand if the files they point at are ever renamed:

- `core/scheduler.ts` → `path.join(WIKI.SERVERPATH, 'worker.ts')` (the poolifier pool entry)
- `worker.ts` → `import('./tasks/workers/${kebabCase(job.task)}.ts')`
- `models/authentication.ts` → `import('../modules/authentication/${stg.module}/authentication.ts')`
- `models/storage.ts` → `import('../modules/storage/${key}/storage.ts')`, plus the `storage.ts`
  presence check in `hasImplementation()` that gates it
- `models/search.ts` → `import('../modules/search/${key}/search.ts')`, plus the `search.ts`
  presence check in `hasImplementation()` that gates it

`scheduler.ts` matches `tasks/simple/` filenames against `/^[^.]+\.[jt]s$/`, so `.ts` and `.js` are
both accepted but any other dotted filename (a stray `.test.ts`, a `.d.ts`) is rejected outright.

`worker.ts` builds its own minimal `WIKI` (config + logger + lazy `ensureDb()`), but the shared
declaration types it as the full object — so worker-only code can reference members that do not
actually exist in a worker thread. Be deliberate about what you touch there.

Conventions established during the conversion, worth following in new code:

- **`catch (err: any)`** at each site rather than globally disabling `useUnknownInCatchVariables`.
  Strict mode types a caught error as `unknown`, and this codebase reads `err.message` everywhere;
  annotating per-site keeps the looseness visible instead of hiding it in tsconfig.
- **Per-route Fastify generics** for request shapes: `app.get<{ Params: { siteId: string } }>(...)`.
  The JSON Schema stays as-is for validation and OpenAPI; the generic is what types `req.params`,
  `req.body` and `req.query`.
- **Pre-existing bugs are preserved, not fixed inline.** Where a migration or refactor exposes
  already-broken code outside its own scope, leave the behavior identical behind a narrow cast plus a
  `FIXME:` comment explaining the real fix, rather than silently changing runtime behavior as a
  drive-by. No `FIXME:` markers remain in `backend/` today — every one raised during the TypeScript
  conversion has since been fixed.

## Backend patterns

- **The `WIKI` global.** Set up in `index.ts`, typed in `types/global.d.ts`, available everywhere
  without importing:
  `WIKI.db` (Drizzle), `WIKI.models.*`, `WIKI.config`, `WIKI.logger` (see
  [Logging](#logging) — every line takes a scope), `WIKI.cache`, `WIKI.scheduler`,
  `WIKI.events.{inbound,outbound}` (Emittery), `WIKI.sites` / `WIKI.sitesMappings` (cached site
  configs), `WIKI.ROOTPATH`, `WIKI.SERVERPATH`, `WIKI.INSTANCE_ID`.
- **Routes** are Fastify plugins: `async function routes(app) { ... }` with a default export.
- **`/_api` is deliberately unversioned.** `info.version` in the Swagger doc is `WIKI.version`, not a
  separate API contract number. Frontend and backend ship as one coupled release (the frontend's
  `assets/` build is served by that same backend commit), so there is no independent-compatibility
  scenario to manage — versioning exists to reconcile a producer and consumer that release
  separately, and here there is only one release train. Revisit only if a genuine external
  integration surface (a published plugin API, a third-party client this project commits to
  supporting) appears; until then a `/_api/v1` prefix would be speculative scaffolding.
- **Permissions** are declared per-route in `config.permissions`, and enforced by a single
  `preHandler` hook — `core/http/authHooks.ts#permissionPreHandler`, registered on the root app. The
  array is OR-ed; a nested array is AND-ed
  (`permissions: ['read:sites', ['manage:users', 'manage:groups']]`). `manage:system` bypasses every
  check. `@fastify/swagger`'s `transform` (`helpers/openapi.ts#swaggerTransform`) folds these into
  the OpenAPI description automatically — so declaring them is also how they get documented. Only
  **global** permissions belong here; see root CLAUDE.md's Permissions section for the other kinds.
- **An unknown `:siteId` answers `404 'This site does not exist.'` from one place**, not from each
  handler: `helpers/siteResolution.ts#siteEnabledPreHandler`, the `preHandler` `api/index.ts`
  registers on its guarded `contentApp` scope. **A route under that scope may assume its `:siteId`
  site exists**, and a new route file inherits it with no call of its own. Two deliberate
  exemptions: `api/sites.ts` (registered outside `contentApp` — `PUT /sites/:siteId` is how a
  disabled site is re-enabled, so it keeps its own 404s) and `api/bootstrap.ts` (resolves by
  hostname, not a param). Hook order is load-bearing: the global permission `preHandler` is on the
  root app and therefore runs first, so an unauthorized caller still gets 401/403 rather than
  learning which site ids exist.
- **Every route needs a `schema`** with `summary`, `tags`, and response schemas. `hideUntagged` is on,
  so an untagged route is invisible in the API docs. Reuse `$ref` schemas from `api/schemas/`.
- **Errors** via `@fastify/sensible` helpers (`reply.notFound()`, `reply.badRequest()`,
  `reply.unauthorized()`, `reply.forbidden()`). `helpers/errorHandler.ts#apiErrorHandler`, installed
  by `core/http/errors.ts`, shapes `/_api/` failures into `{ ok, error, statusCode, message }` JSON.
- **Schema changes**: edit `db/schema.ts`, then `npm run db-generate` and commit the generated
  migration. Never hand-edit an existing migration.
- **`WIKI.db.execute()` returns pg's `QueryResult` envelope, not a bare row array** — read
  `result.rows`. A `result.rows ?? result` probe is dead code (verified against
  `drizzle-orm`'s `node-postgres` driver). This is the same distinction as the raw-`sql`-expression
  note under Temporal below: neither path is a plain column read.
- **Exactly one `unhandledRejection` handler exists**, `core/processGuards.ts`'s, registered by
  `index.ts` immediately after `logger.init()` with `exit: (code) => process.exit(code)`. Do not add
  a second: Node runs listeners in registration order and an exiting one silences everything after it.

### Shared backend helpers — one owner per question

Reach for these rather than re-deriving; each is the single implementation, and a second copy is the
regression the split existed to prevent.

- **Hostname → site id**: `helpers/siteResolution.ts#siteIdForHostname(hostname, { strict })`, never
  a bare `WIKI.sitesMappings[…]` index — it folds the case and applies the `*` catch-all (`strict`
  skips the fallback). Siblings: `siteForHostname(hostname)` and `resolveSiteParam(param, hostname,
  { strict })` for the `current`/uuid/hostname three-way a path parameter can spell.
- **A cacheable response's ETag/`Cache-Control`/304 dance**:
  `helpers/httpCache.ts#notModifiedOrPrepare(req, reply, { etag, cacheControl, nosniff })`, which
  returns `true` once it has sent the 304 and adds `X-Content-Type-Options: nosniff` by default.
- **Racing work against a ceiling**: `helpers/timeout.ts#withTimeout(work, ms, onExpire, { unref
  })`. `onExpire` is a callback so each caller keeps its own error type. Nothing is cancelled — the
  work runs on, the caller stops waiting.
- **Puppeteer availability/refusal/close**: `helpers/puppeteer.ts` (`isPuppeteerAvailable`,
  `assertPuppeteerAvailable(errorName, message)` → 503, `closeQuietly`, `launchPuppeteerBrowser`).
- **Postgres unique violations, `LIKE` escaping and the bcrypt cost**: `helpers/common.ts`'s
  `isUniqueViolation(err)`, `escapeLikePattern(value)` and `BCRYPT_ROUNDS`. Never write
  `bcrypt.hash(x, 12)`, and never hand-roll a prefix filter's escaping.
- **A TTL sweep of a `<dataPath>` directory**: `helpers/fsPurge.ts#purgeFilesOlderThan(dir, ttl)`.
- **"Are these real group ids"**: `WIKI.models.groups.hasUnknownGroupIds(ids)`.
- **Offset pagination**: `helpers/pagination.ts#paginate`. Its `total` thunk takes drizzle's own
  `select({ total: count() })` — and the `total` alias is load-bearing, since `paginate` reads
  `totals[0]?.total` and any other alias silently paginates as `total: 0`.
- **A model's process-local cache of a whole table**: `extends
  helpers/clusterCache.ts#ClusterReloaded`, declaring `protected readonly reloadEvent` and
  implementing `reloadCache()`. Never write your own `broadcastReload()`/`subscribeToEvents()`. Two
  rules the base class encodes: a mutator calls `broadcastReload()`, never `reloadCache()` directly;
  and `reloadCache()` never emits, or the event echoes around the cluster forever. `groups`,
  `sites`, `approvalRules`, `classificationLevels` and `locales` are on it; `glossary` and `navigation`
  are deliberately not (theirs are per-site invalidates, not whole-cache reloads).
- **Telling the outside world about a page or asset write**: `models/hooks.ts#announce` — webhook
  emit then storage dispatch, both awaited, in that order. It is a module function, not a `Hooks`
  method, precisely so a caller's test can stub `WIKI.models.hooks` as a bare `{ emit }`.
- **Page-placement refusals**: `helpers/localeRouting.ts#assertLocaleActive` /
  `#assertPathNotReservedLocale`. `tree.ts`'s reserved-locale check is a deliberately different,
  root-only error and is not these.
- **Large-file thresholds and the kind→category map**: `helpers/blobTarget.ts`, once — 1024-based
  units, and `fileSize >= threshold` files an asset as `large`. A storage module must not
  re-implement either.
- **Page content-type → extension**: `helpers/pageSerialization.ts#CONTENT_TYPE_EXTENSIONS`
  (`DEFAULT_CONTENT_TYPE_EXTENSION = 'txt'`), read through `fileExtensionForContentType` or the
  dotted `extensionForContentType`. `modules/storage/disk` overriding `redirect: 'json'` is the one
  documented divergence.
- **Turning one provider display string into a first and last name**: `helpers/personName.ts` —
  `splitDisplayName(display)` (first whitespace-separated part, whole remainder, two empty strings
  for nothing) and `fillNameHalves(display, known)`, which applies that split ONLY where neither half
  is already known. Deliberately naive and library-free by decision, so a wrong split reads as a
  guess somebody can correct. The five single-string providers (`github`, `discord`, `slack`,
  `twitch`, `cas`) each call it from their own module; it is never placed on `oauth2/authentication.ts`
  or `oidc/preset.ts`, which would pre-empt every preset whose provider reports real name claims.
  Nothing a person typed on this instance goes through it — local registration and the admin user
  forms take both halves outright.
- **`mcp/` shared bits**: `mcp/tools/shared.ts` holds `toResult` plus the shared `siteIdArg`/
  `localeArg` zod fields; a tool file declaring its own `toResult` is a regression.
- **A `Date` column headed into a search index**:
  `.toTemporalInstant().toString({ smallestUnit: 'millisecond' })`, never `.toISOString()` and never
  behind an `instanceof Date` guard.
- **Cross-model reuse is an explicit export, not a re-declaration.** `models/tree.ts` exports
  `holdsVisiblePagesUnder`, `pageIsVisible`, `compareFoldersFirst` and `MAX_DEPTH` for
  `navigation.ts`; `models/users.ts` exports `userSelection` alongside `UserCore`/`UserPage`, so a
  column added to the user list projection is added once. `models/tree.ts#getById` is `private` on
  purpose — it is the only tree lookup taking no `siteId`, and a caller outside the model that needs
  a tree row by id goes through a `siteId`-scoped method instead.
- **Dates use the `Temporal` API**, not luxon (no longer a backend dependency), and it is typed by the
  TS 7 lib so it needs no type import. **It ships natively on every official Node 26 build this
  project targets** — verified directly against `node:26.8.1-slim` and `node:26.7.0-bookworm`
  (production's own image): `typeof Temporal` is `object`, `Date.prototype.toTemporalInstant` exists.
  It is absent only on a build V8 was compiled without Temporal support for
  (`v8_enable_temporal_support=0`) — a prior version of this section claimed Node 26.7.0 itself lacked
  it, verified only against a Homebrew Node 26.8.1 on macOS, which is exactly such a build; official
  binaries (CI's setup-node, the devcontainer's `node:26.8.1`, and production's own image) are
  unaffected. `index.ts` and `worker.ts` both call `core/temporal.ts`'s `ensureTemporal()` as their
  first async step, before anything touches `Temporal`, feature-detected so it is a no-op on every
  official build and only actually installs anything on a Temporal-less build like Homebrew's — the
  fallback is `temporal-polyfill/global` (a real `dependencies` entry, not just a test-only
  devDependency), the same polyfill package `frontend/` and `blocks/` already use for pre-Temporal
  Safari, so there is one polyfill across every workspace rather than a backend-only second one. A new
  backend entry point (a script run outside `index.ts`/`worker.ts`, e.g. under `scripts/` or `tasks/`)
  must call `ensureTemporal()` itself before using `Temporal` — it is not ambiently available on a
  Temporal-less build. Five things to know about the API itself:
  - `Temporal.Instant` accepts **exact time units only** — `add({ days: 1 })` throws. Since these are
    all UTC instants, use `{ hours: 24 }`.
  - Temporal types have no `valueOf`, so `a < b` **throws**. Compare with
    `Temporal.Instant.compare(a, b)`.
  - `Instant.toString()` defaults to nanosecond precision; pass
    `{ smallestUnit: 'millisecond' }` for values written to postgres or compared as strings, which is
    what the rest of the codebase emits.
  - Converting: `date.toTemporalInstant()` from a `Date` (what drizzle returns for a plain `timestamp`
    **column** read), `Temporal.Instant.from(str)` for postgres-format strings (what raw
    `db.execute()` returns, **and what a raw `sql` aggregate/expression substituted into `.select()`
    returns too** — that path is not a plain column read and does not get a `Date` back, a distinction
    `models/pageviews.ts`'s `summary()` got wrong until it was fixed), and
    `new Date(instant.epochMilliseconds)` going back the other way.
  - Test files install the polyfill themselves via `test/temporal.ts`'s `ensureTemporal()` — see
    "Testing (backend)" for the convention; that copy is intentionally separate from
    `core/temporal.ts`'s (test code should not import from the app's own boot path).

## Logging

Everything the backend writes to stdout goes through `WIKI.logger`, in one shape:

```ts
WIKI.logger.info('db', 'connected', { postgres: '18.6', schema, migrations: 0, ms })
WIKI.logger.error('jobs', 'purgeUploads failed, no attempts left', { job: job.id, attempts: 3, error: err })
WIKI.logger.debug('jobs', 'storageSyncTick found nothing due')
```

`(scope, message, fields?)` on each of the four levels — `error`, `warn`, `info`, `debug`. A file
that logs a lot from one subsystem binds a child instead, and every line it emits carries the
standing fields:

```ts
const log = WIKI.logger.scope('storage', { module: 'git', target: target.id })
log.debug('pulling from origin', { branch })
```

- **Every line has a scope, from the closed vocabulary in `core/logScopes.ts`** (re-exported from
  `core/logger.ts`, so either import reads the same values). It is a `LogScope` union, so a string
  outside it is a type error at the call site. **Do not add, rename or reorder one to describe a
  narrower subsystem** — that is a *field* (`{ module: 'git' }`, `{ engine: 'elasticsearch' }`), never
  a new scope. A genuinely new subsystem is a one-line addition there, and `docs/operations.md#logs`
  is the operator-facing table of what each name owns.
- **The level is the status**, in four lines: `error` — broken, and a person has to act. `warn` —
  degraded, self-healing, or a configuration smell. `info` — a state change worth having in the
  record (boot milestones, a job that *did* something, lifecycle events). `debug` — per-item,
  per-request, per-tick (the access log, every job start/finish, the `sql` and `auth` firehoses). A
  scheduled tick that found nothing to do is `debug` or nothing at all, never `info`.
- **Voice: a lowercase fragment, no trailing period.** No `[ OK ]` / `[ COMPLETED ]` / `[ FAILED ]` /
  `[ SKIPPED ]` tags, no `...` announcement suffix, no `successfully` — the level already says
  whether it worked, and nothing is announced before it starts unless it can plausibly take seconds,
  in which case the announcement is `debug`.
- **Facts are fields, not prose.** Counts, ids, durations, paths and hostnames go in `fields`; the
  message stays a sentence. One call site produces both outputs — the `key=value` tail in
  `logFormat: text`, sibling keys in `logFormat: json`.
- **Two field keys are rendered, not printed.** Pass `ms` as a **number** and the renderer humanises
  it (`in 528ms`, `in 3.7s`) and moves it to the end of the tail. Pass `error` as the **`Error`
  itself** — never `err.message`, never `String(err)`, never a pre-formatted string: the renderer
  puts the message inline as `error="…"` and the stack on following lines (always at `error`; at
  `warn` only when `logLevel: debug`), and JSON mode gets `{ name, message, stack }`. One failure is
  **one record**, not a `warn(context)` followed by a `warn(err)`.
- **Identifiers, never identities.** User ids, group ids, site ids — not e-mail addresses, and not a
  hostname where the hostname is a person's. The one deliberate exception is the seeded admin address
  on a first run, which is the only credential the operator has at that point.
- **No bare `console.log` in `backend/`.** The exceptions are the places that genuinely have no
  logger yet, cannot share the stream, or are talking to a person at a terminal rather than writing
  a log: `core/config.ts` (runs before `logger.init()`), `core/logger.ts` itself (it *is* the sink),
  `mcp/stdio.ts` (stdout is JSON-RPC there), every script under `scripts/`, and the CLI entry points
  `tasks/migrate.ts`, `tasks/verify-migration.ts` and `tasks/promote-admin.ts`. Each carries a
  file-level disable and a one-line reason. `index.ts` gets three *inline* disables instead — the
  Node-version and cwd refusals, and the `IS_DEBUG` process-warning dump, all of which run before
  `WIKI.logger` exists — since the rest of the file logs normally. A new `console.*` anywhere else
  goes through `WIKI.logger`.

`logLevel` (`error|warn|info|debug`), `logFormat` (`text|json`) and `logScopes` (a map of scope to
level) are validated at boot case-sensitively: an unrecognised value — including an unknown scope
name in `logScopes` — is a one-line refusal and `exit(1)`, not a value that quietly logs everything.

**A line's threshold is per scope, resolved per call**, in `core/logger.ts#effectiveLevel`: the
`scopeOverrides` thunk `init()` was handed, then `WIKI.config.logScopes`, then `logLevel` as the
default for a scope neither map names. `index.ts` is what supplies the thunk, over
`models/flags.ts#logScopeOverrides()` — which is all the `sqlLog` and `authDebug` system flags are
now: `sqlLog` raises `sql` to `debug`, `authDebug` raises `auth` to `debug`, live, no restart.
Neither flag gates a call site any more, and **new code must not add a second gate of its own**:
`core/db.ts`'s query logger emits every query at `debug sql` unconditionally and lets the threshold
decide, and `models/flags.ts#authDebug()` is a bare `WIKI.logger.debug('auth', message)`. A line
worth emitting only sometimes is a line at the right level in the right scope, not a line behind an
`if`.

`logScopes` is declared in `base.yml` as an explicit null rather than `{}`, deliberately:
`core/config.ts#warnUnknownConfigKeys` descends into any key that is a plain object on both sides,
so `{}` would make every real entry warn as an unknown config key on every boot.

**`(scope, message, fields?)` is the only call shape there is.** The legacy `(msg, context?)`
overload that carried the un-swept call sites through the sweep — filed under a sentinel `legacy`
scope so a grep over the output said how much was left — was deleted with the sweep's last task
(#2668), and deleting it is what makes `npm run typecheck` the gate: a call that forgot its scope
has no overload to land on. Do not reintroduce one.

**Three gates enforce the rules above, and they cover different things:**

- **`npm run typecheck`** — the scope vocabulary (`LogScope` is a union, so a name outside
  `core/logScopes.ts` is a compile error, at a `scope()` declaration as much as at a direct call)
  and the call shape itself.
- **`no-console: error` in `backend/.oxlintrc.json`** — the other direction: a line that never
  reached the logger at all. The exceptions listed above each carry a file-level (or, in `index.ts`,
  an inline) disable with a one-line reason; a new `console.*` anywhere else fails the lint step.
- **`test/logging-conventions.test.ts`** — what neither can see: it walks the source tree (skipping
  `*.test.ts`, `test/`, `scripts/` and `db/migrations/`) and fails on an `[ OK ]`-style status tag,
  a message ending in `.` or `...`, a message opening with a capital that is not a known acronym, a
  `logger.x(err)` / `logger.x(err.message)` one-liner, a first argument outside the vocabulary, and
  any `verbose`/`silly` call. It reads comments and string contents as such, so a doc comment
  quoting a bad line is not itself a finding.

A line that genuinely needs an exception carries `// log-conventions: allow <reason>` on the
preceding line. That is the escape hatch for a correct line a text heuristic refuses — not a way to
opt out of the conventions, and the test caps how many may exist at once.

## Testing (backend)

`backend/`'s test runner is Node's built-in **`node:test`**, run via `npm run test` (→ `node --test
--test-concurrency=4 --test-timeout=600000 --test-force-exit '**/!(*.flaky).test.ts'`). No extra
framework — this follows the same no-build-step, native-TS-stripping approach as everything else in
`backend/`: `node --test` type-strips `.ts` test files exactly like `node backend` does, so a test
file is written and run the same way as the code it tests, with no separate transpile or worker
config. The three flags are decisions, not tuning: the concurrency bound and the two hang ceilings
are deliberately bounded, and `package.test.ts` guards the ceilings. Bare `node --test` has no
per-test timeout and waits forever on a child kept alive by a leaked handle — which is how
OpenProject #2927's 27-minute silent hang reached the job's 30-minute kill with no test named.

**What earns a test, at which layer, and what deliberately gets none** follows the settled policy
below, written from the #2687/#2688 test-value audits.

- **File convention: co-located `*.test.ts`.** A test lives next to the file it covers —
  `helpers/pageRules.ts` → `helpers/pageRules.test.ts` — not in a mirrored `test/` tree. `tsconfig.json`
  already includes all of `**/*.ts`, so test files are type-checked for free by `npm run typecheck`;
  oxlint and oxfmt cover them the same way. One source file's tests may be several sibling files
  split by subject — `models/users.test.ts` (pure), `models/users.crud.test.ts`,
  `models/users.profile.test.ts`. Eleven files carry a **`*.db.test.ts`** suffix
  (`core/scheduler.reaping.db.test.ts`, `models/storage.db.test.ts`, …), but **it is not the pure/DB
  boundary and must not be read as one** — 81 suites open a real Postgres schema and only those
  eleven are so named. The real boundary is `hasTestDatabase()`, which every one of them carries;
  running the pure half alone is `DATABASE_URL` unset. The suffix is not required of a new DB-backed
  file and carries no claim if used.
  A DB-backed file opens **one** `setupTestDb()` for the whole file, shared by its describes, rather
  than one per describe. `test/` holds the shared harness and fixture code that is not itself a
  `*.test.ts` (`db.ts`, `mocks.ts`, …) — plus, since a harness module is a source file like any
  other, its own co-located coverage (`test/fastify.ts` → `test/fastify.test.ts`) — plus two narrow
  categories of test that genuinely have no single co-located home: a DB-backed round trip spanning
  more than one source file rather than unit-testing either in isolation (`blockUploadServing.test.ts`
  — `api/blocks.ts`'s upload route and `controllers/blocks.ts`'s serve route each already have their
  own unit-level `*.test.ts` sibling; this one is the real round trip between them), and a
  structural/self-consistency check against a repo-root doc or CI config with no backend-workspace
  file to sit next to at all. This is the rule to apply, not a fixed list of examples. `base.test.ts`
  is the one file in this category that stays at the `backend/` root rather than moving into `test/`:
  it is co-located with `backend/base.yml`, resolving it as
  `path.join(path.dirname(fileURLToPath(import.meta.url)), 'base.yml')`, so it belongs with the file
  it guards the same way any other co-located test does. A test file that genuinely does have one
  specific co-located sibling belongs next to it, not here.
- **Prefer pure unit tests with no `WIKI` global and no database.** Plenty of `helpers/` and `models/`
  logic is testable as plain functions or methods with no I/O — `helpers/pageRules.test.ts` and
  `models/users.test.ts` (`updateSession`, pure session/permission flattening — no `WIKI`, no
  database) are the reference examples. Reach for a real Postgres instance when the thing under test
  _is_ SQL orchestration that a mock of the query builder would mostly just be re-describing rather
  than verifying — a `models/` write path that inserts, checks a constraint, and coordinates a couple
  of tables (`models/pages.test.ts`'s create/update/move/delete is the example: path-collision checks,
  a locale-scoped uniqueness constraint, the page/tree/history tables staying in step) is squarely
  this case, not the rare exception the join/upsert framing might suggest.
- **DB-backed fixture: `test/db.ts`.** `hasTestDatabase()` gates a suite on `DATABASE_URL` being set —
  wrap the whole `describe` in `{ skip: !hasTestDatabase() }` rather than asserting inside each test,
  so an unset `DATABASE_URL` reports as skipped and CI/local runs without one still pass with nothing
  DB-backed even attempted. `setupTestDb()` (call from `before()`) connects, creates a fresh,
  randomly-named schema, runs the real migrations from `db/migrations/` into it, installs a minimal
  `WIKI` global scoped to just what a model needs (`db`, a silent `logger`, `sites`, `config`,
  `models`, plus the `cache`/`events` stubs below), and seeds one site/user/group — returned as
  `{ db, siteId, userId, groupId }`. `teardownTestDb()` (call from `after()`) drops that schema and
  closes the pool.
  - **A schema per call, not `public`.** `node --test` runs matched files concurrently by default, and
    every DB-backed suite points at the same `DATABASE_URL` — sharing one schema means two suites'
    setup racing each other. A fresh schema per `setupTestDb()` call is what makes "no leaking state
    between runs" hold even when another suite is running against the same physical database at the
    same time, and dropping it in `teardownTestDb()` is what keeps a long-lived shared instance (the
    `.devcontainer` postgres, or a container reused across several local invocations) from
    accumulating one abandoned schema per run.
  - A throwaway instance to point `DATABASE_URL` at: `docker run --rm -d --name wiki-test-db -p
56001:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:18`, then
    `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56001/postgres npm run test`. Nothing under
    `npm run test` spins up its own database — pointing `DATABASE_URL` at one, ephemeral or
    `.devcontainer`'s, is always the caller's choice to make.
- **Mocking convention: `test/mocks.ts`.** `WIKI.cache` and `WIKI.events` exist for cross-request and
  cross-instance concerns that almost no model-layer test is actually exercising — `createCacheStub()`
  / `createEventsStub()` (and `createSchedulerStub()`, `createSiteAdminAccessStub()`,
  `createSilentLogger()`) build the smallest object satisfying the methods a code path under test
  actually calls (`node:test`'s `mock.fn()`, so a test that DOES care can assert
  `cache.set.mock.calls` directly), rather than reaching for the real `NodeCache`/`Emittery` instances
  the app boots with. Follow the same pattern for any other `WIKI` member a future model test
  needs present but does not care about.
  - **`createSilentLogger()` swallows both call shapes and answers `scope()` with itself**, so a
    suite asserting on a log line spies the level method it cares about (`WIKI.logger.warn =
    mock.fn()`) rather than building its own logger. Assert on the **scope and the fields** a call
    passed, not on the rendered string: the renderer is `core/logger.ts`'s business, and a test that
    matches formatted text breaks the moment a column widens. **Never assert against
    `WIKI.logger.backlog()` or subscribe to `WIKI.logger.ws`** — both carry structured frames whose
    shape belongs to the logger, not to the code under test.
  - **A new test never writes a `WIKI = {…}` literal.** `installTestWiki(overrides)` installs
    `createWikiStub(overrides)` as the global and returns a `{ restore() }` to call in
    `after()`/`afterEach()` — `node --test` isolates each matched FILE into its own process but not
    each suite within one, so a file that installs a global and walks away leaves it standing.
    `setupTestDb()` is a caller of the same builder. The pre-harness `models/*.test.ts` suites (30
    files as of this writing, `assetServing.test.ts` among them) still write their own `WIKI = {…}`
    literal directly — they predate `installTestWiki` and are converted as each is next touched, not
    as a standalone sweep.
  - **`createWikiStub` defaults `models` to `{}` on purpose**: an absent member throwing is coverage
    (`modules/storage/disk/storage.test.ts` relies on it to prove the module never reaches for a
    model it should not), so a suite names exactly the methods its code path calls. `data.systemIds`
    defaults to `{}` so a read answers `undefined` rather than throwing. Overrides are
    **deep-merged** — a nested `{ events: {…} }` merges into the default rather than replacing it,
    so assert against `WIKI.events`, not the literal you passed — while arrays, class instances and
    `mock.fn()`s replace wholesale. The merge copies property DESCRIPTORS, so a stub may declare a
    **getter** to steer what a route sees from a module-level variable per test.
- **A route test boots through `test/fastify.ts#buildTestApp({ routes, wiki, schemas, session,
  permissions, apiKeySitePin, ajv, swagger, prefix })`**, closed with `closeTestApp(app)`. It
  installs the REAL production pieces — `helpers/errorHandler.ts#apiErrorHandler`,
  `core/http/authHooks.ts#permissionPreHandler` (API-key branch included) and, for `schemas: 'all'`,
  `api/index.ts#registerAllSchemas` — so a suite is testing the app's own gate rather than a replica
  of it. `makeRequestStub`/`makeReplyStub`/`makeDoneStub` are there for a hook driven with no server
  around it.
  - **Session seeding is the harness's concern, not production's** — there is no
    `testSessionOnRequest` in `backend/`; a running server gets its session from a signed cookie.
    `session: 'header'` is the one convention: `x-test-session` (a whole session as JSON),
    `x-test-permissions` (a JSON array or comma-separated list) and `x-test-api-key` (a whole
    `req.apiKey` as JSON). `session` also takes a fixed object, or a **function** — which is how a
    suite keeps a per-test identity, builds a fresh mutable session per request, or does a
    per-request side effect and stays anonymous by returning `undefined`.
  - **A hook a suite needs registered before its own routes is a one-line plugin wrapper**
    (`async (instance) => { instance.addHook(…); await instance.register(routes) }`), not an
    `app.addHook` after `buildTestApp` returns: `onRoute` fires only for routes registered into the
    same encapsulation or below, and a `preHandler` added after `ready()` is too late.
- **The rest of `test/`**: `builders.ts` (`makeGroupRule`, `makeActor`, `makeSite`,
  `makeStorageTarget`, `makeIndexablePage`, `stubSelect`, …), `routeRecorder.ts`
  (`createRecordingApp`, `listApiRouteFiles`, `recordRoutesFrom`, … for the structural scans over
  `api/` — its recording stub **replays** a registered sub-plugin, since a no-op `register` would
  make every route in a split resource invisible while the scans still passed, and
  `listApiRouteFiles` is recursive and treats a directory with an `index.ts` as one resource, so a
  scanner must use it rather than its own `readdirSync` filter), `sourceFiles.ts`
  (`listSourceFiles`, the one recursive source-tree walker), `migrationFixtures.ts`,
  `collabHarness.ts`, `permissionScenario.ts`, `sftpServer.ts`, `temporal.ts`.
  **`test/collabWorker.ts` is a worker-thread entry point and must not be imported by a test** — it
  destructures `workerData` and calls `boot()` at import time, which is why the shared collab
  helpers live in `collabHarness.ts`.
- **A new search engine or blob storage module is wired to its contract runner, not re-described.**
  `test/searchModuleContract.ts#runSearchModuleContract(name, { makeModule, config, siteConfig })`
  emits the claims every `modules/search/*` engine owes `models/search.ts`;
  `test/storageModuleContract.ts#runStorageModuleContract(name, { makeTarget, stubSdk })` does the
  same for the asset lifecycle every blob storage module owes `models/storage.ts`. Each module's own
  test file supplies a harness translating the claims into its vendor shapes and keeps only what is
  genuinely vendor-specific. The `db` search engine is deliberately outside the runner, for the same
  reason it does not extend `ExternalSearchModule`.
- **A read-back oracle belongs in the test file, not on the model.** A model method whose only
  caller is its own test is dead code: express the read-back as a local fixture helper over the
  table (or, for a private method, through an `as any` cast) instead of widening the model's
  surface.
- **Use `node:assert/strict`**, not a third-party assertion library. `describe`/`test` (or `it`) both
  come from `node:test` itself.
- Keep the pure-unit majority of the suite fast: it's meant to run on every change, not just in CI. A
  DB-backed test is slower by nature — gate it behind `DATABASE_URL` as above rather than letting the
  default `npm run test` require Postgres to pass at all.
