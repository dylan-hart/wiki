# Wiki.js 3.x

Next-generation open source wiki. This is the **3.x development branch** — incomplete, unstable, and
with no upgrade path from 2.x. AGPL-3.0.

**Nothing here has to stay compatible with an existing installation.** Nobody is expected to be
running an earlier state of this branch, so do not write migration shims, legacy-value fallbacks,
deprecated aliases or "old data may still contain X" handling. Change the shape, change the callers,
and delete the old path — a fallback for a case that cannot occur is dead code that still has to be
read, tested and reasoned about. This applies to db columns, API payloads, stored settings and
config keys alike; only real migrations under `backend/db/migrations/` are exempt, because Drizzle
needs the history to get a live dev database to the current schema.

Four independently-installed workspaces (each has its own `package.json` / `node_modules`, there is
no root package or monorepo tooling):

| Path        | What it is                                                                                |
| ----------- | ------------------------------------------------------------------------------------------ |
| `backend/`  | Fastify REST API server + job scheduler, Drizzle on PostgreSQL                            |
| `frontend/` | Vue 3 / Vite SPA, Tailwind CSS + an in-repo component library                             |
| `blocks/`   | Lit web components users embed into wiki pages                                           |
| `e2e/`      | Playwright end-to-end suite, driving the built stack — see [Testing (e2e)](#testing-e2e) |

Requires Node.js **26+** and PostgreSQL **16+**. All four workspaces are ESM (`"type": "module"`).

The backend is **TypeScript 7**; `frontend/`, `blocks/` and `e2e/` are JavaScript. See
[TypeScript (backend)](#typescript-backend).

## Layout

### Root

- `config.yml` — instance config (copy of `config.sample.yml`). Read by the backend at boot *and* by
  `frontend/vite.config.js` in dev mode to learn the proxy target port.
- `assets/` — **build output** of the frontend (`vite build` writes here), plus static assets under
  `assets/_assets/`. Served by the backend. Don't hand-edit.
- `dev/` — deployment/packaging artifacts: `dev/build/Dockerfile` (production image),
  `dev/noto-emoji-build/`. The 2.x-era Helm chart and Packer image builder were deleted (see
  `docs/variances.md`) — there is no 3.x release yet for either to deploy.
- `.devcontainer/` — VS Code dev container (app + postgres + pgAdmin via docker-compose).
- `localazy.json` — translation sync config; locale strings live in `backend/locales/`.

### `backend/`

Entry point is `backend/index.ts`, and it must be run **from the repo root** (`node backend`), not
from inside `backend/`. It boots in three phases: `preBoot()` (config → db → models → cache →
scheduler → event emitters), `initHTTPServer()` (Fastify plugins, auth, routes), `postBoot()`
(refresh locales/strategies/sites from disk & db, start scheduler).

- `api/` — REST route plugins, one file per resource (`sites.ts`, `users.ts`, `pages.ts`,
  `system.ts`, `locales.ts`, `authentication.ts`), registered by `api/index.ts` under the `/_api`
  prefix.
  - `api/schemas/` — shared JSON Schemas registered via `app.addSchema()` and referenced from route
    schemas as `{ $ref: 'Site#' }`. Register new shared schemas in `api/index.ts` *before* the routes.
- `controllers/` — non-API HTTP routes: `site.ts` serves per-site resources (logo, favicon, login
  background) under `/_site`; `icons.ts` serves icons under `/_icons`, implementing the part of the
  Iconify API protocol the frontend speaks (`/_icons/<prefix>.json?icons=a,b` and
  `/_icons/<prefix>/<name>.svg`), public and cached hard — see [Icons](#icons); `blocks.ts` serves a
  custom block's compiled JS under `/_blocks/custom/:siteId/:blockId.js`; `files.ts` serves stored
  assets; `render.ts` serves a rendered page; `thumb.ts` serves page/asset thumbnails; `collab.ts` is
  the Yjs collaborative-editing WebSocket upgrade; `metrics.ts` exposes Prometheus metrics;
  `seo.ts` serves `robots.txt`/`sitemap.xml`; `terminal.ts` and `user.ts` round out the set.
- `core/` — long-lived singletons: `config.ts` (yml + db-backed settings), `db.ts` (pg pool, Drizzle
  instance, migrations, LISTEN/NOTIFY pubsub), `logger.ts`, `scheduler.ts` (poolifier thread pool +
  postgres-backed job queue).
- `db/` — `schema.ts` (all Drizzle table definitions), `relations.ts`, `migrations/` (generated).
- `models/` — data-access classes over Drizzle, aggregated by `models/index.ts` and exposed as
  `WIKI.models.*`. Business logic belongs here, not in route handlers. `types.ts` holds the shared
  `SystemIds` passed to each model's `init()` during first-run seeding.
- `modules/` — pluggable extensions, discovered from disk. Each module is a directory with a
  `definition.yml` (key, title, props/config schema) plus its implementation — e.g.
  `modules/authentication/local/`. Six kinds exist: `authentication/`, `storage/` (7 modules —
  `disk`, `s3`, `azure`, `gcs`, `sftp`, `git`, `db` — each shipping a real `storage.ts`; see
  `models/storage.ts`), `search/`, `analytics/`, `comments/`, `extensions/`.
- `mcp/` — the in-process Model Context Protocol server (`bootstrap.ts`, `auth.ts`, `http.ts`),
  exposing wiki content/actions to an MCP-speaking client over the instance's own HTTP surface.
- `migration/` — the 2.5.x-to-3.0 import CLI: `cli.ts` and `orchestrator.ts` drive a source
  `connector.ts`/`connectors/` implementation through staged `phases/`, `importers/` per record class,
  and `mappers/` for field translation, recording provenance and a dry-run report along the way. See
  `docs/migration/` for the source-schema and field-mapping specs this reads against.
- `tasks/simple/` — jobs run in-process by the scheduler; each exports `task()`. File name is
  kebab-case, the task key is its camelCase form.
- `tasks/workers/` — CPU-bound jobs run in a worker thread via `worker.ts`, which boots a minimal
  `WIKI` global (config + logger + lazy `ensureDb()`) and dynamically imports the task.
- `base.yml` — system defaults for every config key. Do not edit as a user-facing config; it defines
  the shape merged with `config.yml` and the db `settings` table.
- `helpers/` — small pure utilities (`common.ts`, `config.ts`, `pageRules.ts`, `siteRules.ts`, …).
- `types/` — ambient declarations: `global.d.ts` (the `WIKI` global) and `fastify.d.ts` (session +
  route-permission augmentations).
- `locales/` — `en.json` source strings (Localazy-managed) + `metadata.js` language table (the one
  remaining JavaScript file; typed by its sibling `metadata.d.ts`).

### `frontend/`

Vue 3 on plain Vite. `src/main.js` wires it up manually: router → pinia store → `boot/*`
initializers → mount. There is no UI framework: `src/components/shared/` is the component library
(every component is `W*`, used in templates as `<w-btn>`, `<w-input>`, …), registered globally by
`boot/components.js` and styled with Tailwind.

- `src/boot/` — one-time app initializers: `api.js` (creates the `ky` client, exposed
  as the `API_CLIENT` global), `components.js` (global components), `eventbus.js` (`EVENT_BUS` global,
  mitt), `externals.js`, `i18n.js`, `iconify.js` (points Iconify at this instance's `/_icons`),
  `monaco.js`, `temporal.js` (conditionally polyfills `Temporal`, awaited before anything else in
  `main.js`).
- `src/router/` — `index.js` (router factory) and `routes.js` (the full route table; page components
  are lazily imported).
- `src/layouts/` — `MainLayout`, `AdminLayout`, `AuthLayout`, `ProfileLayout`.
- `src/pages/` — route-level views. `Admin*.vue` are the admin area, `Profile*.vue` the user profile.
- `src/components/` — everything else: dialogs (`*Dialog.vue`), full-screen overlays
  (`*Overlay.vue`), editors (`Editor*.vue`), nav/tree components.
- `src/stores/` — Pinia stores (`site`, `user`, `page`, `editor`, `admin`, `common`, `flags`).
  `stores/index.js` creates the pinia instance and injects `router` into every store.
- `src/renderers/` — page content rendering pipeline: `markdown.js` plus `modules/` (katex, kroki,
  plantuml, markdown-it plugins).
- `src/css/` — `tailwind.css` (theme tokens, utilities and the shared component classes) plus SCSS:
  `_theme.scss` (brand colours) and `_palette.scss` (the Material ramp the older stylesheets use).
  Both are injected into every SFC by `css.preprocessorOptions.scss.additionalData` in
  `vite.config.js`, which is why templates can write bare `$primary` / `$grey-4`.
- `src/helpers/`, `src/assets/`, `public/`, `index.html`.

Path alias `@` → `frontend/src` (defined in `vite.config.js`; `jsconfig.json` mirrors it for the IDE).

Dev server runs on **3001** and proxies `/_api`, `/_blocks`, `/_icons`, `/_site`, `/_thumb`, `/_user`
to the backend on **3000**, so the backend must be running too.

### `blocks/`

Self-contained Lit components. Each lives in `blocks/block-<name>/component.js` — the glob in
`rollup.config.mjs` picks up any directory matching `block-*` automatically, so a new block needs no
config change. Output goes to `blocks/compiled/`, which the backend serves statically under
`/_blocks/`. Blocks are loaded dynamically at runtime, which is why `_blocks/**` is excluded from
Vite's `dynamicImportVarsOptions`. A block pulling in a heavy library is fine — nothing is fetched
until its tag turns up in a page — and a library that still ships CommonJS works too, since the
rollup config runs `@rollup/plugin-commonjs` after `resolve()`.

Blocks style themselves off `:host` and read the theme colors via CSS custom properties
(`var(--q-primary)` — the `--q-` prefix is historical; the properties are declared in
`css/tailwind.css` and rewritten at runtime for per-site theming).

**Dark mode goes through `blocks/shared/theme.js`, never `:host-context()`.** The app's source of
truth is the `body--dark` class on `<body>`, which CSS in a shadow root cannot see; `:host-context()`
is the selector for exactly that and is what every block used to use, but only Chromium ever shipped
it — MDN has it deprecated, Firefox and Safari never implemented it, and there it silently never
matches, so the block stayed light on a dark page. Instead construct a `DarkMode` controller
(`this._darkMode = new DarkMode(this)`) in the block's constructor and write `:host([dark])`; the
controller keeps that attribute in step, sharing one MutationObserver across every block on the page.
A block that must *act* on the change rather than restyle for it passes `onChange`, or reads
`.isDark` — `block-diagram` redraws mermaid in its own dark theme, `block-map` resolves a per-block
`theme` prop that can pin a map light on a dark page.

## Commands

Run backend commands from `backend/`, frontend from `frontend/`, blocks from `blocks/`.

```sh
# backend
npm run dev              # nodemon, restarts on any backend file change
npm run start            # plain node
npm run typecheck        # tsc — type check only, never emits
npm run typecheck:watch
npm run test             # node --test — see Testing (backend) below
npm run db-generate      # drizzle-kit generate — after editing db/schema.ts
npm run db-up            # drizzle-kit up

# frontend
npm run dev            # vite dev server on :3001 (needs backend running on :3000)
npm run build          # builds into ../assets — required before the backend can serve the UI

# blocks
npm run build          # rollup → blocks/compiled/
```

`npx ncu -i` (`npm run ncu`) for interactive dependency updates.

The API is browsable via Swagger UI at `http://localhost:3000/_api` in a running instance. Default
admin login is `admin@example.com` / `12345678`.

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

`scheduler.ts` reads `tasks/simple/` filenames with `/\.[jt]s$/`, so task files are extension-agnostic.

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
- **Pre-existing bugs are preserved, not fixed** was the rule during the initial TypeScript
  conversion: where the type checker exposed already-broken code, it was left behaving identically
  behind a narrow cast plus a `FIXME:` comment explaining the real fix, so the migration itself
  wouldn't silently change runtime behavior. All four bugs that convention originally flagged
  (`sites.ts`'s `req.querystring.strict`, `config.ts`'s `Promise.trim()`, and two in
  `scheduler.ts`'s `addScheduled()`/`addJob()`) have since been fixed, and their `FIXME:` comments
  removed with them. One `FIXME:` remains, unrelated to the TS conversion — `index.ts`'s note by the
  session/cookie plugin registration, on `WIKI.config.auth.secret` being captured by value instead of
  re-read per request, so a live secret rotation (`models/sessions.ts#rotateSecret()`) does not
  actually stop a still-running instance from signing new cookies with the invalidated secret until
  that instance restarts; echoed at `models/apiKeys.ts:236` and `models/sessions.ts:93`. If a future
  migration or refactor turns up another pre-existing bug outside its scope, follow the same
  pattern: preserve behavior, cast narrowly, and leave a `FIXME:` comment explaining the real fix
  rather than changing runtime behavior inline.

## Conventions

### Style, linting, formatting

**oxlint** for linting, **oxfmt** for formatting — not ESLint or Prettier (ESLint is explicitly
disabled in `.vscode/settings.json`). oxlint is a devDependency of `backend/`, `frontend/` and
`blocks/`; oxfmt only of `backend/` (its install is treated as the canonical one for the repo-root
format check — see `.github/workflows/quality.yml`'s "Format Check" step comment).

```sh
npx oxlint            # from backend/, frontend/ or blocks/ — uses that dir's .oxlintrc.json
npx oxfmt <paths>     # config is the repo-root .oxfmtrc.json
```

Format settings (root `.oxfmtrc.json`): no semicolons, single quotes, no trailing commas,
`bracketSameLine`, LF, final newline. 2-space indent, per `.editorconfig`.

Otherwise follow **standard JS** rules. Note that much of `frontend/` predates oxfmt and still uses
the standard-style space before parens (`function initializeRouter ()`); new and touched code should
be oxfmt-formatted, but don't reformat untouched files as drive-by changes.

Each of the three workspaces has its own `.oxlintrc.json` — the backend declares the `WIKI` global
and node env; the frontend adds the `vue` plugin and the `API_CLIENT` / `EVENT_BUS` / `Temporal`
globals; blocks declares a browser env, with no globals of its own to add. Only the `correctness`
category is an error, everywhere.

Both tools handle `.ts` with no extra configuration, and the backend's oxlint config already enables
the `typescript` plugin. oxlint does not type-check — run `npm run typecheck` for that.

**Never put two statements in a Vue template attribute.** `@click="doOne(); doTwo()"` builds today
and is a build error the moment the file is formatted, because `semi: false` and Vue disagree about
the same character. Vue's `transformOn` decides whether an inline handler is a statement block or an
expression from `exp.content.includes(';')` — with the semicolon it emits `$event => { … }`,
without it `$event => ( … )`. oxfmt breaks the handler across lines and drops the semicolon, so Vue
parenthesises two statements and the template fails to compile (`Error parsing JavaScript
expression: Unexpected token`). Write a named handler instead — `@click="closeAndRefresh"` — as
`EditorMarkdown.vue` and `PageRelationDialog.vue` do.

Neither side of that is worth reconfiguring, so don't try: the `includes(';')` check has no compiler
option behind it, and the parse error is raised by the built-in `transformExpression`, which
`baseCompile` runs *before* any `nodeTransforms` you could add — and Volar runs the same compiler,
so a build-time workaround would still leave the editor showing errors. On the formatter side,
`embeddedLanguageFormatting: "off"` does leave attribute expressions alone but also stops formatting
every `<script>` and `<style>` block in every SFC. This is not an oxfmt quirk either: Prettier with
`--no-semi` produces identical output. For a one-off where the inline form genuinely reads better,
`<!-- prettier-ignore -->` on the preceding line works (oxfmt honors Prettier's marker; there is no
`oxfmt-ignore`).

### Utilities and dates

These apply to **every workspace**, `frontend/` included — not just the backend.

- **Use `es-toolkit`, not `lodash-es`.** Installed in both `backend/` and `frontend/`.
- **Use the native `Temporal` API, not luxon.** See [Backend patterns](#backend-patterns) for the
  Temporal gotchas worth knowing; they apply on the frontend too.
- **luxon and lodash-es have been removed entirely** — zero imports and zero manifest entries left in
  either `backend/` or `frontend/`. Do not reintroduce either: use `es-toolkit`/`Temporal` in any new
  code, including a file that once imported one of them.
- Prefer real es-toolkit subpath exports (`es-toolkit/object`, `es-toolkit/array`,
  `es-toolkit/predicate`) over `es-toolkit/compat`. Two lodash helpers are compat-only and have direct
  equivalents: `defaultsDeep(source, defaults)` → `toMerged(defaults, source)` (note the argument
  order flips) and `toSafeInteger(x)` → `Number.parseInt(x, 10)`.
- On the frontend `Temporal` is a global, declared in `.oxlintrc.json`. `src/boot/temporal.js`
  dynamically imports `temporal-polyfill` for browsers without native support (Safari, as of
  mid-2026) and is awaited first in `main.js`. The polyfill is a lazy chunk (~21 kB gzipped) that
  browsers with native `Temporal` never download.

### Permissions

There are **three kinds of permission**, granted separately and checked in different places. Which
kind a name belongs to decides how it may be enforced, so it is the first thing to establish about
any permission you touch.

**Global permissions** are held site-wide, bound to no path: `access:admin`, `read:users`,
`manage:users`, `read:groups`, `manage:groups`, `manage:navigation`, `manage:theme`, `manage:sites`,
`manage:glossary`, `manage:system`. That list is the whole of it — the one offered by the group
editor (`GroupEditOverlay.vue`). They live on a group's `permissions` column, are flattened onto
`req.session.permissions` at login (`models/users.ts` → `updateSession`), and are what the per-route
`config.permissions` hook checks. `manage:system` bypasses every check everywhere.

**Page rule permissions** are bound to paths, and to locales and sites: `read:pages`, `write:pages`,
`review:pages`, `manage:pages`, `delete:pages`, `write:styles`, `write:scripts`, `read:source`,
`read:history`, `read:assets`, `write:assets`, `manage:assets`, `read:comments`, `write:comments`,
`manage:comments` (`PAGE_PERMISSIONS` in `api/pages.ts`). A group grants them through **rules**:
each rule names some of them (`roles`) plus how it addresses pages (`match` + `path`, or tags) and
what it does with them (`mode`: ALLOW / DENY / FORCEALLOW). Nothing is granted by default, and when
several rules match, the most specific one wins — `helpers/pageRules.ts` documents the ordering.
Ask `WIKI.models.groups.checkAccess(actor, permission, page)`, or `mayOnPage(req, permission, page)`
in `api/pages.ts`.

**Site-scoped delegation permissions** are bound to a site (not a path): `site:general`,
`site:theme`, `site:navigation`, `site:blocks`, `site:approvals`, `site:login`, `site:locale`,
`site:editors` (`SITE_PERMISSIONS` in `helpers/siteRules.ts`) — one per delegable admin settings
surface, for handing a non-`manage:sites` user control of specific sites without making them a full
site administrator. A group grants them through the **same rule rows** page permissions use
(`GroupRule.roles` is one shared vocabulary space across both kinds — see
`docs/decisions/delegated-per-site-administration.md`), just addressed by `sites` alone instead of
`path`/`match`/`locales`: an empty `sites` array means every site, a populated one means only those
ids. Nothing is granted by default; `helpers/siteRules.ts#resolveSiteRule` documents the ALLOW <
DENY < FORCEALLOW tie-break, the same ordering `helpers/pageRules.ts` uses. Ask
`WIKI.models.groups.checkSiteAccess(actor, permission, siteId)`.

Consequences worth knowing:

- **A page or site-scoped permission cannot be enforced by `config.permissions`.** That hook reads
  the group-wide list only, so `permissions: ['write:pages']` refuses everybody. A route that turns
  on one of these declares no route permission and checks in the handler instead — say so with a
  `No route-level permissions:` comment, as `api/pages.ts`, `api/assets.ts`, `api/blocks.ts` and
  `api/sites.ts`'s site-scoped routes do.
- **Names are not interchangeable across or within kinds.** `manage:pages` does not imply
  `write:pages`, and `manage:sites` does not imply any `site:*` permission: a rule grants the exact
  strings in its `roles`.
- **On the frontend**, `userStore.permissions` is the global list (from `users/whoami`),
  `userStore.pagePermissions` is what the session holds AT THE CURRENT PATH (from
  `pages/userPermissions`, refreshed per route in `App.vue`), and `userStore.sitePermissions` is what
  it holds for one specific site (from `sites/:siteId/userPermissions`, fetched by
  `fetchSitePermissions(siteId)` — see `composables/siteAdminAccess.js`, the admin area's nine
  site-scoped pages). `userStore.can()` ORs the global and page lists and treats `manage:system` as a
  wildcard, so it answers "may do this somewhere"; `userStore.canOnSite(permission, siteId)` is the
  site-scoped counterpart, answering only for the site it was last fetched for — a stale or
  mismatched `siteId` is refused, not answered with the wrong site's grant. Gate a control over the
  page (or site) in front of the reader on `pagePermissions` (or `canOnSite`) — that is what the
  endpoint behind the button will actually check.
- **An anonymous request is the guests group**, not an absence of groups: that is how a wiki opens
  reading, and suggesting edits, to the public. Deny guests explicitly where an account is genuinely
  required (`reviewerFor` in `api/approvals.ts` is the worked example).
- **Never invent a permission name.** All three lists above are closed; `can('browse:fileman')` and
  friends matched nothing and silently hid the controls they guarded.

### Backend patterns

- **The `WIKI` global.** Set up in `index.ts`, typed in `types/global.d.ts`, available everywhere
  without importing:
  `WIKI.db` (Drizzle), `WIKI.models.*`, `WIKI.config`, `WIKI.logger`, `WIKI.cache`, `WIKI.scheduler`,
  `WIKI.events.{inbound,outbound}` (Emittery), `WIKI.sites` / `WIKI.sitesMappings` (cached site
  configs), `WIKI.ROOTPATH`, `WIKI.SERVERPATH`, `WIKI.INSTANCE_ID`.
- **Routes** are Fastify plugins: `async function routes(app) { ... }` with a default export.
- **Permissions** are declared per-route in `config.permissions`, and enforced by a single
  `preHandler` hook in `index.ts`. The array is OR-ed; a nested array is AND-ed
  (`permissions: ['read:sites', ['manage:users', 'manage:groups']]`). `manage:system` bypasses every
  check. `@fastify/swagger`'s `transform` folds these into the OpenAPI description automatically —
  so declaring them is also how they get documented. Only **global** permissions belong here; see
  [Permissions](#permissions) for the other kind and how they are checked.
- **Every route needs a `schema`** with `summary`, `tags`, and response schemas. `hideUntagged` is on,
  so an untagged route is invisible in the API docs. Reuse `$ref` schemas from `api/schemas/`.
- **Errors** via `@fastify/sensible` helpers (`reply.notFound()`, `reply.badRequest()`,
  `reply.unauthorized()`, `reply.forbidden()`). The `setErrorHandler` in `index.ts` shapes `/_api/`
  failures into `{ ok, error, statusCode, message }` JSON.
- **Schema changes**: edit `db/schema.ts`, then `npm run db-generate` and commit the generated
  migration. Never hand-edit an existing migration.
- **Dates use the native `Temporal` API**, not luxon (no longer a backend dependency). `Temporal` is a
  global in Node 26 and is typed by the TS 7 lib, so it needs no import. Four things to know:
  - `Temporal.Instant` accepts **exact time units only** — `add({ days: 1 })` throws. Since these are
    all UTC instants, use `{ hours: 24 }`.
  - Temporal types have no `valueOf`, so `a < b` **throws**. Compare with
    `Temporal.Instant.compare(a, b)`.
  - `Instant.toString()` defaults to nanosecond precision; pass
    `{ smallestUnit: 'millisecond' }` for values written to postgres or compared as strings, which is
    what the rest of the codebase emits.
  - Converting: `date.toTemporalInstant()` from a `Date` (what drizzle returns for `timestamp`
    columns), `Temporal.Instant.from(str)` for postgres-format strings (what raw `db.execute()`
    returns), and `new Date(instant.epochMilliseconds)` going back the other way.

### Testing (backend)

`backend/`'s test runner is Node's built-in **`node:test`**, run via `npm run test` (→ `node --test
'**/*.test.ts'`). No extra framework — this follows the same no-build-step, native-TS-stripping
approach as everything else in `backend/`: `node --test` type-strips `.ts` test files exactly like
`node backend` does, so a test file is written and run the same way as the code it tests, with no
separate transpile or worker config.

- **File convention: co-located `*.test.ts`.** A test lives next to the file it covers —
  `helpers/pageRules.ts` → `helpers/pageRules.test.ts` — not in a mirrored `test/` tree. `tsconfig.json`
  already includes all of `**/*.ts`, so test files are type-checked for free by `npm run typecheck`;
  oxlint and oxfmt cover them the same way. `test/` holds shared fixture code that is not itself a
  `*.test.ts` (`db.ts`, `mocks.ts`, …), plus two narrow categories of test that genuinely have no
  single co-located home: a DB-backed round trip spanning more than one source file rather than
  unit-testing either in isolation (`blockUploadServing.test.ts` — `api/blocks.ts`'s upload route and
  `controllers/blocks.ts`'s serve route each already have their own unit-level `*.test.ts` sibling;
  this one is the real round trip between them), and a structural/self-consistency check against a
  repo-root doc or CI config with no backend-workspace file to sit next to at all
  (`changelog.test.ts` against `cliff.toml`, `release-checklist-doc.test.ts` against
  `docs/release-checklist.md`, `release-workflow.test.ts` against `.github/workflows/build.yml` AND
  `release.yml` together, `releasing-doc.test.ts` against `docs/versioning.md` — none of those
  subjects live under `backend/`, and `npm run test`'s `'**/*.test.ts'` glob only runs from inside
  this workspace). A test file that genuinely does have one specific co-located sibling belongs next
  to it, not here — three such near-namesake pairs (`test/api/sites.test.ts` vs. `api/sites.test.ts`,
  `test/core/config.test.ts` vs. `core/config.test.ts`, `test/core/scheduler.test.ts` vs.
  `core/scheduler.test.ts`) existed as discovery hazards until this pass confirmed each co-located
  file already fully superseded its `test/` namesake and deleted the redundant copy.
- **Prefer pure unit tests with no `WIKI` global and no database.** Plenty of `helpers/` and `models/`
  logic is testable as plain functions or methods with no I/O — `helpers/pageRules.test.ts` and
  `models/users.test.ts` (`updateSession`, pure session/permission flattening — no `WIKI`, no
  database) are the reference examples. Reach for a real Postgres instance when the thing under test
  *is* SQL orchestration that a mock of the query builder would mostly just be re-describing rather
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
  / `createEventsStub()` build the smallest object satisfying the methods a code path under test
  actually calls (`node:test`'s `mock.fn()`, so a test that DOES care can assert
  `cache.set.mock.calls` directly), rather than reaching for the real `NodeCache`/`Emittery` instances
  the app boots with. `setupTestDb()` installs both onto its `WIKI` unconditionally, since building
  them costs nothing and a model gaining a `WIKI.cache`/`WIKI.events` touch later should not need this
  fixture rewritten to cope. Follow the same pattern for any other `WIKI` member a future model test
  needs present but does not care about.
- **Use `node:assert/strict`**, not a third-party assertion library. `describe`/`test` (or `it`) both
  come from `node:test` itself.
- Keep the pure-unit majority of the suite fast: it's meant to run on every change, not just in CI. A
  DB-backed test is slower by nature — gate it behind `DATABASE_URL` as above rather than letting the
  default `npm run test` require Postgres to pass at all.

### Frontend patterns

- **Templates are plain HTML.** A handful of pre-3.x leftovers are still `<template lang="pug">` —
  check the file you're editing rather than assuming.
- **UI components come from `components/shared/`**, registered globally, so `<w-btn>` / `<w-input>` /
  `<w-icon>` need no import. Each one is scoped to how this app actually uses it rather than to the
  full API of the framework component it replaced; the header comment in each file says where they
  differ. Add a prop there rather than reaching around it.
- HTTP calls go through the `ky` client, reachable as the `API_CLIENT` global (declared in the oxlint
  config, so no import needed) — e.g. `await API_CLIENT.get('sites').json()`. It handles the `/_api`
  prefix; authentication is the session cookie, sent with every request.
- Cross-component messaging uses the `EVENT_BUS` global (mitt).
- State lives in Pinia option stores. For utilities and dates use `es-toolkit` and `Temporal` — see
  [Utilities and dates](#utilities-and-dates); `lodash-es` and `luxon` have both been fully removed.

### Testing (frontend)

`frontend/`'s test runner is **Vitest** + **`@vue/test-utils`**, run via `npm run test` (→ `vitest
run`). Config is `vitest.config.js`, deliberately separate from `vite.config.js` — that file also
wires up the twemoji-assets plugin (does a real filesystem copy in `writeBundle` and throws unless
the `twemoji-assets` tarball dependency is resolvable) and `vite-plugin-vue-devtools`, and reads
`../config.yml` at import time for the dev proxy port, none of which a unit test needs or wants
paying the cost of on every run.

What IS mirrored from `vite.config.js`, because component code has to resolve exactly the way it
does in the real build, not because it was convenient to share:

- the **`@` alias**, `vue()`'s `isCustomElement` rule for `<iconify-icon>`, and
  `transformAssetUrls` — every component compiles the same way under test as it does in the app;
- the **Tailwind plugin** — component markup is full of Tailwind utility classes;
- the **SCSS `additionalData` injection** (`css.preprocessorOptions.scss`) — several SFCs' `<style
  lang="scss">` blocks reach for a bare `$primary` / `$grey-9` / ... (`PageToc.vue` is the test
  suite's proof case), which only resolves under test if the same `@use '@/css/_theme.scss' as *;
  @use '@/css/_palette.scss' as *;` runs here. Miss this and such a component doesn't fail its
  assertion — it fails to even *compile* with a Sass "undefined variable" error, which wastes time
  chasing the wrong problem. `test.css: true` in the Vitest `test` block is required alongside it:
  Vitest stubs out CSS processing by default (a `<style>` import resolves to `{}` and nothing is
  actually run through Sass), which would silently skip the very thing being verified.
- **`vue()`'s template `compilerOptions.comments: false`** — deliberately *not* mirrored from
  `vite.config.js`, and load-bearing rather than optional. `@vitejs/plugin-vue` preserves
  template-level comments in dev mode (matching vue-loader's old behaviour) but strips them for
  `vite build`. Several SFCs — `WCheckbox.vue` among them — open with an explanatory HTML comment as
  a template-level *sibling* of their root element, not a child of it: left in, the component
  compiles to a two-node Fragment root instead of a single element. Vue itself handles that fine at
  runtime, but `@vue/test-utils` resolves `wrapper.element` (and therefore `.attributes()`,
  `.classes()`, `.find()` off the wrapper root, ...) from the component's single root node, and
  falls back to the test's own mount container when there isn't one — silently, with no error — so
  every one of those reads the wrong element. Forcing `comments: false` reproduces the single-root
  shape these components actually ship with in production, which is what a test should be verifying
  against.

- **File convention: co-located `*.test.js`**, matching the backend's `*.test.ts` convention — a test
  lives next to the file it covers (`components/shared/WBtn.vue` → `components/shared/WBtn.test.js`),
  not in a mirrored `test/` tree. `test/` itself is reserved for the harness's own shared fixture code
  (`test/setup.js`, `test/mocks.js`), matching what `backend/test/` reserves `test/` for.
- **The two ambient globals, `API_CLIENT` and `EVENT_BUS`** (see [Frontend
  patterns](#frontend-patterns)), exist nowhere outside `boot/*` — a component or store reading either
  as a bare global would throw `ReferenceError` under test without a stand-in. `test/setup.js`
  rebuilds both **before every test**: `EVENT_BUS` is a real `mitt()` instance (cheap, and a test can
  subscribe to it directly to assert an emit), while `API_CLIENT` is `test/mocks.js`'s
  `createApiClientStub()` — a `vi.fn()` per HTTP method shaped after `ky`'s chainable
  `.get(url).json()` surface, so store code needs no test-only branch to call it. A test overrides a
  call directly: `API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(payload) })`, or
  `API_CLIENT.post.mockImplementationOnce(() => { throw new Error('network') })` for the rejection
  path every store call is wrapped in a `try`/`catch` for. Rebuilding per-test rather than per-file
  is deliberate: both would otherwise leak mock call history and event listeners into the next test
  in the same file.
- **The `w-*` shared library is registered globally in `test/setup.js`**, via
  `config.global.components = { ...sharedComponents }` (`components/shared/index.js`'s own exported
  map — the same one `boot/components.js` uses) — so a component under test that uses `<w-icon>` /
  `<w-btn>` / ... resolves them exactly as the real app does, with no per-test import list to keep in
  sync as components are added.
- **`Temporal` polyfill**: loaded eagerly in `test/setup.js` when the global is absent, the same way
  `boot/temporal.js` lazily polyfills it for pre-Temporal Safari — this sandbox's Node 25.9 lacks it
  natively (engines requires >=26), same environment note as the backend's testing section.
- Prefer mounting the real component over shallow-rendering or over-mocking — `WChip.test.js` /
  `WBtn.test.js` / `WCheckbox.test.js` and `stores/user.test.js` (permission checks, guest/profile
  state transitions, `logout()`'s `API_CLIENT`/`EVENT_BUS` round-trip, `Temporal`-backed date
  formatting) are the reference examples of testing real behaviour end-to-end through the harness
  rather than merely asserting Vitest boots.

### Testing (blocks)

`blocks/`'s test runner is **Vitest**, run via `npm run test` (→ `vitest run`). Config is
`blocks/vitest.config.js` — deliberately minimal, no plugin stack to mirror the way frontend's does:
a block has no build-time template compilation (`rollup.config.mjs` bundles plain ESM, it doesn't
transform it) and no app framework around it, so a test loads `component.js` exactly as the browser
would.

- **`environment: 'jsdom'`**, not `happy-dom` (frontend's choice). A block's whole surface under test
  *is* its shadow DOM — attribute reflection, light-DOM content read out of `this.textContent` /
  `querySelector`, Lit's `adoptedStyleSheets`-or-injected-`<style>` fallback — and jsdom's coverage of
  that is the more complete of the two emulators. Verified directly rather than assumed: a
  `MutationObserver`-driven dark-mode toggle (see below) round-trips correctly under jsdom with no
  workarounds. If a future block's test needs something jsdom doesn't emulate, the task spec's
  documented fallback is `@web/test-runner` (runs in a real browser, no DOM emulation at all) — not a
  different DOM emulator.
- **File convention: co-located `component.test.js`**, matching the `*.test.ts` / `*.test.js`
  convention in `backend/` and `frontend/` — `block-gallery/component.js` →
  `block-gallery/component.test.js`. `vitest.config.js`'s `include` is `**/*.test.js`, wide enough to
  also discover a future `shared/theme.test.js` or `shared/url-limit.test.js` (`shared/`'s
  `url-limit.js`, `config.js`, `icons.js`, `theme.js` currently have no test coverage at all) — a
  narrower `*/component.test.js` could only ever match inside a `block-*/` directory.
- **Mounting pattern** — a block reads its content from the *light* DOM (the markdown body becomes its
  children before Lit ever renders), so a test builds that shape directly rather than passing props:
  ```js
  const el = document.createElement('block-gallery')
  el.textContent = '/photos/one.jpg\n/photos/two.jpg'
  document.body.appendChild(el)
  await el.updateComplete
  el.shadowRoot.querySelector('.tile') // → assert against the shadow tree
  ```
  Reactive `@property`-declared fields (`thumbnailSize`, `fit`, `unlockAspectRatio`, ...) can be set
  directly as JS properties (`el.thumbnailSize = 240`) rather than through attribute strings — simpler
  than reconstructing Lit's attribute-name-casing and converter rules, and exercises the same
  reactive-update path `render()` runs against either way.
- **Dark mode**, since every block depends on it (`blocks/shared/theme.js`'s `DarkMode` controller —
  see the file header comment there): toggle `document.body.classList` between `body--dark` and
  nothing, and assert the host's `dark` attribute follows. The controller reacts through a
  `MutationObserver` callback, which runs as a microtask in jsdom same as a real browser — awaiting
  one `queueMicrotask` tick plus the block's own `updateComplete` is enough to observe the change; no
  fake timers or polling needed. `block-gallery/component.test.js`'s `describe('dark mode', ...)`
  block is the reference case — a template worth copying verbatim into the next block's suite, since
  the controller's behavior (not any one block's use of it) is what's actually being locked down.
- **Linted the same way as `backend/` and `frontend/`**: `blocks/` has its own `oxlint` devDependency
  and `.oxlintrc.json`, run the same way (`npx oxlint` from `blocks/`) and wired into
  `.github/workflows/quality.yml`'s "Blocks Lint" step alongside the other two workspaces' — see
  [Style, linting, formatting](#style-linting-formatting).

### Testing (e2e)

`e2e/`'s test runner is **Playwright** (`@playwright/test`), run via `npm test` (→ `playwright
test`). It is its own top-level workspace, not folded into `backend/`, `frontend/` or `blocks/`,
because none of those own it at runtime — a spec drives a real browser against the fully-built,
production-shaped stack (`node backend` from the repo root, serving `frontend/`'s `vite build`
output out of `assets/`), which is a different thing from any one workspace's unit tests, not a
superset of one of them.

- **Boots the real thing, not a dev proxy.** `playwright.config.js`'s `webServer` runs `node
  backend` (`cwd: '..'` — `index.ts` refuses to boot from anywhere else) against `CONFIG_FILE:
  'e2e/config.e2e.yml'` and a `DATABASE_URL` the caller supplies. There is no dev-mode Vite proxy in
  this picture: `assets/` has to already be a real `frontend/`/`vite build` output (`npm run build`
  in `frontend/`, same as CI's own build step), or the specs fail on missing chrome, not a
  Playwright config problem — building it is deliberately left to the caller rather than triggered
  by this config, so a stale build shows up as broken specs against a bundle it wasn't meant to
  test, not a silent pass.
- **`DATABASE_URL` is required, checked before `webServer` ever spawns.** `playwright.config.js`
  throws a one-line, actionable error if it is unset, rather than letting a misconfigured run fail
  as the `webServer` boot timeout it would otherwise surface as — "fails meaningfully, not just a
  timeout" is the task's own bar, and a missing env var is the single most likely way to trip it. A
  throwaway container works the same way `backend/`'s DB-backed tests document (`test/db.ts`):
  `docker run --rm -d --name wiki-e2e-db -p 56002:5432 -e POSTGRES_PASSWORD=postgres -e
  POSTGRES_DB=postgres postgres:18`, then `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56002/postgres
  npm test`. In CI, a fresh `postgres:18` service container per run is what makes "seeded test
  database" true on every invocation, not just the first.
- **The seed IS the app's own first-run path**, not a fixture this suite maintains separately: an
  empty database has no `settings` row, so `core/config.ts`'s `initDbValues()` runs exactly as it
  would for a real fresh install — a default (catch-all `*`) site, the standard groups, and the
  admin account (`ADMIN_EMAIL`/`ADMIN_PASS`, defaulted to `admin@example.com` / `12345678` — the
  same default documented at the top of this file). `playwright.config.js` sets `ADMIN_PASS`
  explicitly (exported as `ADMIN_PASSWORD` alongside `ADMIN_EMAIL`, for specs to import rather than
  re-hardcode) specifically so `mustChangePwd` seeds `false` — left unset, `models/users.ts`'s
  `init()` seeds it `true`, and flow 1's login would land on the change-password screen instead of
  the authenticated shell it exists to prove renders.
- **Port defaults to `:3000`**, matching the task's literal "backend on :3000" boot shape and what a
  clean CI environment has free. `E2E_PORT` overrides it (both the backend's `WIKI_PORT` and the
  config's `baseURL`) purely as a local escape hatch for a developer machine where something else
  already holds :3000 — the override lives in `playwright.config.js`, not `config.e2e.yml`, so the
  on-disk default stays the one the spec describes.
- **Viewport is pinned** (`1280×800`) rather than left to the `chromium` project's device default:
  the markdown editor's preview pane, which `helpers/admin.js`'s `createAndPublishPage` waits on as
  its signal that typed content has synced to the store, only renders above a 1024px-wide viewport
  (`EditorMarkdown.vue`'s `useMinWidth(1024)`).
- **File convention**: specs are `tests/*.spec.js`, one per flow — `auth.spec.js` (flow 1),
  `page-publish.spec.js` (flow 2), `multi-site.spec.js` (flow 3), `rtl.spec.js` (Feature 413's RTL
  support, seeding a synthetic RTL test locale straight into the database under test before its
  suite runs), and `scheduler.spec.js` (the admin Scheduler UI's Upcoming/Active/Failed tabs).
  `helpers/admin.js` holds what more than one spec needs (`loginAsAdmin`, `createAndPublishPage`,
  `expectAuthenticatedShell`/`expectGuestShell`, `uniqueSlug` for collision-free paths/hostnames
  across repeated runs against a database that already has a prior run's data in it).
  `helpers/db.js` is `scheduler.spec.js`'s own direct-Postgres helper (a `pg` devDependency, since
  `e2e/` otherwise never touches the database directly) for the handful of job states nothing in the
  app's own API can plant on demand — an "already picked up by another instance" race, a stuck
  `interrupted` row still owed a retry, a bulk-seeded history page past the UI's display limit.
- **Monaco is a real, asynchronously-mounted editor, not a `<textarea>`.** `createAndPublishPage`
  waits for `.editor-markdown-editor .monaco-editor` before clicking into it — clicking the
  container before Monaco has rendered a focusable surface under it is a click with nothing to
  focus, which was seen landing keystrokes in the wrong field entirely under load. Typed content
  syncs to `pageStore.content` on a 500ms debounce (`EditorMarkdown.vue`'s
  `onDidChangeModelContent`); the helper waits for that content to land in the rendered preview pane
  before saving; clicking "Create Page" any earlier saves an empty page.
- **The page title is a `contenteditable="plaintext-only"` element, not an `<input>`** — but one
  with `aria-label="Title"`, which is what gives a contenteditable region an accessible textbox role
  at all, so `getByLabel('Title', { exact: true })` resolves it like a real form field. Driven with
  real keystrokes (`page.keyboard.type`) followed by an explicit `.blur()`, not `.fill()`: `.fill()`
  sets `textContent` directly and fires one synthetic `input` event, which this non-standard
  contenteditable value was seen handling inconsistently under the full suite's timing; typing (and
  blurring, which is what commits the field's tidied value in `onEditableBlur`) is what an author
  actually does.
- **The save dialog's path field must be explicitly filled**, even when the desired path was already
  in the URL that opened the editor: `TreeBrowserDialog.vue`'s path field auto-slugs from the title
  on every keystroke until the path field itself is focused (`onPathFocus` sets `pathDirty`) — left
  alone, the dialog silently saves under a title-derived path instead of the one the test asked for.
- **Multi-site (flow 3) resolves the second site by hostname, not a UI switcher** — there isn't one
  yet; a Wiki.js 3.x site is addressed by the request's `Host` header
  (`WIKI.sitesMappings[req.hostname]`, `index.ts`), so "switching sites" here means navigating the
  browser to a different hostname. `*.localhost` resolves to the loopback address without any
  `/etc/hosts` entry (RFC 6761, honoured by Chromium and every major OS resolver), which is what
  lets the spec reach a freshly-created site (`e2e-site-<slug>.localhost`) by just navigating to it.
  What "scopes content/permissions correctly" is asserted to mean, absent a 2.5.x spec to port from:
  a page created on one site does not exist on the other (separate page trees), and the login
  session from one site is not honoured on the other's hostname (the session cookie is host-only —
  `index.ts`'s `fastifySession` sets no `domain` — so switching sites really does mean logging in
  again, not carrying a session across them). Asserted together off one page load
  (`${siteBOrigin}/${knownPageFromSiteA}`) rather than off the site's bare root: an unauthenticated
  visitor to a *pageless* site's root gets redirected straight to `/login` by `Index.vue`'s route
  watcher, which is real behavior but would make a root-based guest-shell assertion race that
  client-side redirect instead of asserting on a stable page.
- **CI wiring**: this suite runs as part of `.github/workflows/build.yml`'s `build` job now (task
  762), not only from its own `e2e.yml` — see "Testing (CI)" below for why, and why `e2e.yml`'s own
  `push: branches: [scarlett]` trigger was removed rather than left to run the same suite twice.

### Testing (CI)

Two workflow files split the work: `.github/workflows/quality.yml` (typecheck/lint/format +
backend/frontend/blocks unit tests) and `.github/workflows/build.yml` (version stamping, asset/blocks
building, the Playwright e2e suite, then the Docker publish). `quality.yml` is a `workflow_call:`
target, not folded into `build.yml` directly: a plain `pull_request:` trigger added to `build.yml`
itself would have no way to stop its expensive Docker build/push job from also queuing on every PR,
where `needs:` only works between jobs in the *same* workflow run. `quality.yml`'s own header
comment carries the full reasoning.

- **`quality.yml` runs on every pull request directly, and on every `scarlett` push via
  `build.yml`'s `quality` job (`uses: ./.github/workflows/quality.yml`).** Its steps: backend
  typecheck, then per-workspace lint (`oxlint --deny-warnings`, so a warning fails the step the same
  as an error — not just the `correctness`-category errors `oxlint` fails on by default) and the
  frontend's icon/emoji drift checks, then a `Backend/Frontend/Blocks Tests` step per workspace
  (`npm run test`), then one repo-wide `oxfmt --check`. A `postgres:18` service container backs the
  backend's DB-backed model suites (skipped without one — see [Testing
  (backend)](#testing-backend)); frontend and blocks never touch it. `setup-node`'s `cache: npm` is
  set in every workflow, keyed on each workflow's own actual lockfiles, so a `scarlett` push's two
  jobs (`quality` + `build`) don't each pay for a cold `npm ci`.
- **`build.yml`'s `build` job `needs: quality`, and does not repeat its tests.** Re-running the same
  three `npm run test` invocations in `build` on top of what `quality` already ran on the identical
  commit would pay for them twice with no new coverage — the same "don't run the same suite twice per
  commit" reasoning `e2e.yml`'s own removed push trigger (below) gives. Its own steps, after the
  gate: stamp the alpha version, build `frontend/`'s assets and `blocks/compiled`, run the Playwright
  e2e suite against that build, then log in to GHCR and build/push the Docker image — all **before**
  the Docker steps, so a failing step (GitHub Actions' default `continue-on-error: false`) blocks the
  image the same way a broken `npm run build` already did.
- **The Playwright leg reuses the build that's already there, not a second one.** `e2e/`'s
  `playwright.config.js` boots `node backend` against `frontend/`'s `assets/` output (see "Testing
  (e2e)" above) — both already produced by earlier steps in the same job, so this leg is exactly
  "against a build of the stack" with no extra `npm run build`. The Docker image itself is not built
  at all until every step above — including this one — has already passed, so there is exactly one
  `docker/build-push-action` invocation per run, not one for testing and a rebuild to push.
- **`build`'s own `postgres:18` service container is for the Playwright leg's first-run seeding
  only** — the backend's DB-backed model suites run in `quality`'s own separate service container
  (above), not here.
- **`e2e.yml`'s own `push: branches: [scarlett]` trigger was deleted**, not left in alongside
  `build.yml`'s own Playwright step — that push event already runs the same suite from `build.yml`'s
  `build` job, and gaining nothing back for a second install-browsers-and-run-the-suite pass on the
  same commit contradicts the "CI runtime stays reasonable" bar this split was built against.
  `e2e.yml` still runs standalone on `pull_request` and `workflow_dispatch`, which `build.yml`'s
  push-only trigger doesn't cover.
- **`release.yml`'s tag-push channel runs its own copy of the quality gates** (typecheck, lint,
  drift checks, format — `--deny-warnings` there too) rather than depending on `build.yml`'s run for
  the exact commit a release tag points at, so a release never publishes on a stale, skipped, or
  not-yet-run gate. It does not repeat the unit or e2e suites, for the same already-covered-by-the-
  `scarlett`-push reasoning as above — see its own header comment and `docs/release-checklist.md`.

### Icons

Icons come from **Iconify** and are referenced the way Iconify references them — `<prefix>:<name>`,
e.g. `mdi:account-edit`. That string is all that content, navigation items and page relations ever
store; no SVG is ever written into content.

- **Admin** (`AdminIcons.vue` → `/_api/icons`) manages which sets exist: adding a set stores its
  metadata only, and enabling/disabling one controls whether its icons can be searched and filled in.
- **`models/icons.ts`** resolves a reference through four tiers — memory, disk
  (`<dataPath>/cache/icons/<prefix>/<name>.json`), the `icons` db table, then the Iconify API. **Only
  the db is permanent**; the disk cache is derived and starts empty on a fresh instance, so never treat
  it as storage. The upstream API is consulted only for an icon nobody has used yet, is capped per
  minute (public routes can trigger a fill), and is skipped entirely when `offline` is set.
- **Serving** is `controllers/icons.ts` under `/_icons`, cached for a year and immutable. Rendering a
  page never resolves an icon server-side.
- **Frontend**: render every icon with `<w-icon :name>` (`components/shared/WIcon.vue`).
  Components that take an `icon` prop go through it too, so every form works there.
  - Every Iconify reference written **literally in this repo's source** is inlined at build time by
    `scripts/generate-icons.mjs` into `src/assets/icons.generated.js` (committed) and drawn as an
    inline `<svg>`. Run `npm run icons` after adding or removing one; `npm run icons:check` fails if
    the bundle drifts. This is why the interface needs no icon webfont — and why nothing an
    administrator does to icon sets can blank it, which fetching at runtime could not promise:
    resolution is gated on the set being enabled, and deleting a set drops every icon stored for it.
  - A reference built at runtime — an icon a **user** picked, stored on a page or nav item — is
    invisible to that scan and falls through to `iconify-icon`, resolving against `/_icons` as
    before. A name assembled by concatenation is therefore a bug: make it a literal.
  - `img:…` renders as an `<img>`. Anything else — including a webfont-style class name such as
    `las la-cog` or `mdi-check` — falls through to `kind: 'none'` and draws nothing. No such mapping
    has ever existed here: those names come from `q-icon`, the Quasar component `WIcon.vue` replaced
    (Quasar bundled the underlying webfonts and rendered the class string directly, no Iconify
    translation involved), and nothing in this fork — nor the planned 2.5.x migration importer
    (`Migration & Upgrade Path from 2.5.x` epic, "Importer Engine: Content" feature) — has ever
    produced or plans to carry forward that format into a `w-icon` name. Do not write new ones.
- Picking an icon calls `POST /_api/icons/materialize`, which is what guarantees the wiki can serve it
  afterwards without the Iconify API.
- **Per-action glyphs are settled, not a majority to re-derive.** An add/create action (a button, menu
  item or item-row indicator whose click creates or inserts something) always uses `la:plus` — never
  `la:plus-circle`, which read as a second, semantically-identical glyph purely from organic drift
  (`AdminDashboard.vue`'s "New Site"/"New Group" cards once called the same `newSite()`/`newGroup()`
  as `AdminSites.vue`/`AdminGroups.vue`'s `la:plus` buttons, just drawn differently). A delete action
  always uses `la:trash`, never `la:trash-alt` or `mdi:trash-can-outline`. A settings-page "commit
  these settings" action (the `Admin*.vue` pattern: `icon="mdi:check"` + `t('common.actions.apply')`)
  always uses `mdi:check`, not `la:check` — `la:check` remains correct for the many *other* things it
  already draws (a generic dialog/overlay confirm button, a "done"/"added" state), just not this one.
  Introducing a new call site for any of these three actions means matching the settled glyph, not
  picking whichever one a nearby file happens to use.

### GraphQL is being removed

An earlier iteration of 3.x used GraphQL/Apollo. **All of it is gone from the live surface** — there
is no GraphQL server left in `backend/`, `APOLLO_CLIENT` is not defined as a global so any call
through it would throw, and `blocks/block-index/` no longer imports a `tree.graphql` (its tree comes
from `sites/…/tree/pages`, plain REST).

Four route-*unreachable* pages under `frontend/src/pages/` are the only remnant: `AdminPages.vue`,
`AdminPagesEdit.vue`, `AdminPagesVisualize.vue` and `AdminTags.vue` still call `this.$apollo.mutate`/
`this.$apollo.queries.*` from an Options-API `apollo:` block — a different, older integration than
the `APOLLO_CLIENT` global the paragraph above rules out, and one with nothing installed to back it,
so any of these calls would throw `TypeError: Cannot read properties of undefined (reading
'mutate')` the moment it ran. None of the four is presently linked from `routes.js` (dead code,
not merely deprecated), so nothing exercises the throw today. Porting them to REST — or deleting
them if the feature they back is superseded — is its own, separate work package rather than
something to fix as a drive-by.

Every other former GraphQL consumer has already been ported to REST — `components/AuthLoginPanel.vue`'s
`register()` call included, alongside the passkey login and 2FA paths that were REST from the start.
When touching one of the four remaining files, port it to the REST API (`API_CLIENT` + the matching
`backend/api/` route) rather than extending the `$apollo` code. If the REST endpoint doesn't exist
yet, add it under `backend/api/` following the schema + permissions conventions above —
`sites/:siteId/images/:kind`, which replaced the logo and favicon upload mutations in
`AdminGeneral.vue`, is a recent example of doing exactly that.
