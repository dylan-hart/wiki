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

Three independently-installed workspaces (each has its own `package.json` / `node_modules`, there is
no root package or monorepo tooling):

| Path        | What it is                                                    |
| ----------- | ------------------------------------------------------------- |
| `backend/`  | Fastify REST API server + job scheduler, Drizzle on PostgreSQL |
| `frontend/` | Vue 3 / Vite SPA, Tailwind CSS + an in-repo component library  |
| `blocks/`   | Lit web components users embed into wiki pages                 |

Requires Node.js **26+** and PostgreSQL **16+**. All three workspaces are ESM (`"type": "module"`).

The backend is **TypeScript 7**; `frontend/` and `blocks/` are JavaScript. See
[TypeScript (backend)](#typescript-backend).

## Layout

### Root

- `config.yml` — instance config (copy of `config.sample.yml`). Read by the backend at boot *and* by
  `frontend/vite.config.js` in dev mode to learn the proxy target port.
- `assets/` — **build output** of the frontend (`vite build` writes here), plus static assets under
  `assets/_assets/`. Served by the backend. Don't hand-edit.
- `dev/` — deployment/packaging artifacts: `dev/build/Dockerfile` (production image), `dev/helm/`,
  `dev/packer/`, `dev/noto-emoji-build/`.
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
- `controllers/` — non-API HTTP routes. `site.ts` serves per-site resources (logo, favicon, login
  background) under `/_site`; `icons.ts` serves icons under `/_icons`, implementing the part of the
  Iconify API protocol the frontend speaks (`/_icons/<prefix>.json?icons=a,b` and
  `/_icons/<prefix>/<name>.svg`). Public and cached hard — see [Icons](#icons).
- `core/` — long-lived singletons: `config.ts` (yml + db-backed settings), `db.ts` (pg pool, Drizzle
  instance, migrations, LISTEN/NOTIFY pubsub), `logger.ts`, `scheduler.ts` (poolifier thread pool +
  postgres-backed job queue).
- `db/` — `schema.ts` (all Drizzle table definitions), `relations.ts`, `migrations/` (generated).
- `models/` — data-access classes over Drizzle, aggregated by `models/index.ts` and exposed as
  `WIKI.models.*`. Business logic belongs here, not in route handlers. `types.ts` holds the shared
  `SystemIds` passed to each model's `init()` during first-run seeding.
- `modules/` — pluggable extensions, discovered from disk. Each module is a directory with a
  `definition.yml` (key, title, props/config schema) plus its implementation — e.g.
  `modules/authentication/local/`. `modules/storage/*` is definition-only so far: the admin area
  stores a configuration per site and module, but no `storage.ts` exists yet and nothing reads or
  writes content through a target — pages and assets go straight to the database.
- `tasks/simple/` — jobs run in-process by the scheduler; each exports `task()`. File name is
  kebab-case, the task key is its camelCase form.
- `tasks/workers/` — CPU-bound jobs run in a worker thread via `worker.ts`, which boots a minimal
  `WIKI` global (config + logger + lazy `ensureDb()`) and dynamically imports the task.
- `base.yml` — system defaults for every config key. Do not edit as a user-facing config; it defines
  the shape merged with `config.yml` and the db `settings` table.
- `helpers/` — small pure utilities (`common.ts`, `config.ts`).
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
  removed with them — `backend/` currently carries none (`grep -rn 'FIXME:' backend/` comes back
  empty; see `docs/variances.md`'s "TODO/FIXME audit" section for the full account). If a future
  migration or refactor turns up another pre-existing bug outside its scope, follow the same
  pattern: preserve behavior, cast narrowly, and leave a `FIXME:` comment explaining the real fix
  rather than changing runtime behavior inline.

## Conventions

### Style, linting, formatting

**oxlint** for linting, **oxfmt** for formatting — not ESLint or Prettier (ESLint is explicitly
disabled in `.vscode/settings.json`). Both are devDependencies of `backend/` and `frontend/`.

```sh
npx oxlint            # from backend/ or frontend/ — uses that dir's .oxlintrc.json
npx oxfmt <paths>     # config is the repo-root .oxfmtrc.json
```

Format settings (root `.oxfmtrc.json`): no semicolons, single quotes, no trailing commas,
`bracketSameLine`, LF, final newline. 2-space indent, per `.editorconfig`.

Otherwise follow **standard JS** rules. Note that much of `frontend/` predates oxfmt and still uses
the standard-style space before parens (`function initializeRouter ()`); new and touched code should
be oxfmt-formatted, but don't reformat untouched files as drive-by changes.

Each workspace has its own `.oxlintrc.json` — the backend declares the `WIKI` global and node env;
the frontend adds the `vue` plugin and the `API_CLIENT` / `EVENT_BUS` / `Temporal` globals. Only the
`correctness` category is an error.

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
- **luxon and lodash-es are being removed entirely.** The migration is gradual: when you touch a file
  that imports either one, convert that file's usages as part of the same change — but don't sweep
  through untouched files as a drive-by. Once the last usage is gone, both dependencies get dropped.
- Prefer real es-toolkit subpath exports (`es-toolkit/object`, `es-toolkit/array`,
  `es-toolkit/predicate`) over `es-toolkit/compat`. Two lodash helpers are compat-only and have direct
  equivalents: `defaultsDeep(source, defaults)` → `toMerged(defaults, source)` (note the argument
  order flips) and `toSafeInteger(x)` → `Number.parseInt(x, 10)`.
- On the frontend `Temporal` is a global, declared in `.oxlintrc.json`. `src/boot/temporal.js`
  dynamically imports `temporal-polyfill` for browsers without native support (Safari, as of
  mid-2026) and is awaited first in `main.js`. The polyfill is a lazy chunk (~21 kB gzipped) that
  browsers with native `Temporal` never download.

### Permissions

There are **two kinds of permission**, granted separately and checked in different places. Which
kind a name belongs to decides how it may be enforced, so it is the first thing to establish about
any permission you touch.

**Global permissions** are held site-wide, bound to no path: `access:admin`, `manage:users`,
`manage:groups`, `manage:navigation`, `manage:theme`, `manage:sites`, `manage:system`. That list is
the whole of it — the one offered by the group editor (`GroupEditOverlay.vue`). They live on a
group's `permissions` column, are flattened onto `req.session.permissions` at login
(`models/users.ts` → `updateSession`), and are what the per-route `config.permissions` hook
checks. `manage:system` bypasses every check everywhere.

**Page rule permissions** are bound to paths, and to locales and sites: `read:pages`, `write:pages`,
`review:pages`, `manage:pages`, `delete:pages`, `write:styles`, `write:scripts`, `read:source`,
`read:history`, `read:assets`, `write:assets`, `manage:assets`, `read:comments`, `write:comments`,
`manage:comments` (`PAGE_PERMISSIONS` in `api/pages.ts`). A group grants them through **rules**:
each rule names some of them (`roles`) plus how it addresses pages (`match` + `path`, or tags) and
what it does with them (`mode`: ALLOW / DENY / FORCEALLOW). Nothing is granted by default, and when
several rules match, the most specific one wins — `helpers/pageRules.ts` documents the ordering.
Ask `WIKI.models.groups.checkAccess(actor, permission, page)`, or `mayOnPage(req, permission, page)`
in `api/pages.ts`.

Consequences worth knowing:

- **A page permission cannot be enforced by `config.permissions`.** That hook reads the group-wide
  list only, so `permissions: ['write:pages']` refuses everybody. A route that turns on a page
  permission declares no route permission and checks in the handler instead — say so with a
  `No route-level permissions:` comment, as `api/pages.ts`, `api/assets.ts` and `api/blocks.ts` do.
- **The two names are not interchangeable.** `manage:pages` does not imply `write:pages`: a rule
  grants the exact strings in its `roles`.
- **On the frontend**, `userStore.permissions` is the global list (from `users/whoami`) and
  `userStore.pagePermissions` is what the session holds AT THE CURRENT PATH (from
  `pages/userPermissions`, refreshed per route in `App.vue`). `userStore.can()` ORs the two and
  treats `manage:system` as a wildcard, so it answers "may do this somewhere". Gate a control over
  the page in front of the reader on `pagePermissions` — that is what the endpoint behind the
  button will check.
- **An anonymous request is the guests group**, not an absence of groups: that is how a wiki opens
  reading, and suggesting edits, to the public. Deny guests explicitly where an account is genuinely
  required (`reviewerFor` in `api/approvals.ts` is the worked example).
- **Never invent a permission name.** Both lists above are closed; `can('browse:fileman')` and
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
  oxlint and oxfmt cover them the same way. `test/` itself is the one exception, reserved for shared
  fixture code that is not itself a `*.test.ts` — see below.
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
  [Utilities and dates](#utilities-and-dates); the `lodash-es` and `luxon` still present in older
  files are on their way out.

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
  `block-gallery/component.test.js`. `vitest.config.js`'s `include` is `*/component.test.js`
  accordingly.
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
- **Not (yet) linted**: unlike `backend/` and `frontend/`, `blocks/` carries no `oxlint` devDependency
  or `.oxlintrc.json` of its own — out of scope for this task, which is about test infrastructure, not
  introducing linting to a workspace that has never had it. `npx oxlint` was run once here anyway (ad
  hoc, no persistent config) purely to confirm the new test file itself is clean; it downloaded a
  fresh `oxlint` binary and reported zero findings against the default ruleset.

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
  `page-publish.spec.js` (flow 2), `multi-site.spec.js` (flow 3) — and `helpers/admin.js` holds what
  more than one of them needs (`loginAsAdmin`, `createAndPublishPage`,
  `expectAuthenticatedShell`/`expectGuestShell`, `uniqueSlug` for collision-free paths/hostnames
  across repeated runs against a database that already has a prior run's data in it).
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

`.github/workflows/build.yml`'s single `build` job runs every workspace's test suite — `backend/`,
`frontend/`, `blocks/`, then the Playwright suite documented above — as ordinary steps, all placed
**before** the Docker login/build/push steps at the bottom of the job. A failing step fails the job
outright (GitHub Actions' default `continue-on-error: false`), so a broken test blocks the image
from ever being built or pushed the same way a broken `npm run build` already did — there was no
dedicated "test job" to add this to, so the steps went into the existing one, per the task's own
either/or.

- **One job, not two-plus-`needs:`.** Splitting build/test into separate jobs would mean either
  re-installing everything in the test job (paying `npm ci`/`vite build` twice) or shuttling the
  built `assets/`/`blocks/compiled`/`backend/node_modules` between jobs via `actions/upload-artifact`
  — both slower and more moving parts than steps that already share one runner's filesystem and one
  `npm ci` per workspace.
- **The Playwright leg reuses the build that's already there, not a second one.** `e2e/`'s
  `playwright.config.js` boots `node backend` against `frontend/`'s `assets/` output (see "Testing
  (e2e)" above) — both already produced by the "Build Assets" and "Install Backend Dependencies"
  steps earlier in the same job, so this leg is exactly the "against a build of the stack" the task
  asked for without an extra `npm run build`. The Docker image itself is never rebuilt for this
  leg's sake: it is not built at all until every test step above — including this one — has already
  passed, so there is exactly one `docker/build-push-action` invocation per run, staged and pushed
  once, not staged once for testing and rebuilt again to push.
- **One `postgres:18` service container, shared by every leg that needs a real database.** Declared
  at the job level (not per-step), with `DATABASE_URL` set as a job-level `env:` so it's visible to
  the backend test step (turning on task 756's DB-backed model suites, skipped locally without a
  database) and the Playwright step (its own required `DATABASE_URL`, per "Testing (e2e)" above)
  alike, without redeclaring it twice. The two don't collide: the model tests carve out their own
  randomly-named schema per file (`backend/test/db.ts`) while Playwright seeds the default schema
  through the app's real first-run path, and by the time Playwright's `webServer` starts, every
  backend test file that touched the database has already finished and been cleaned up (sequential
  steps in one job).
- **`e2e.yml`'s own `push: branches: [scarlett]` trigger was deleted**, not left in alongside this —
  that push event now runs the Playwright suite from *this* job already, and gaining nothing back
  for a second install-browsers-and-run-the-suite pass on the same commit contradicts the "CI runtime
  stays reasonable" bar the task set for itself. `e2e.yml` still runs standalone on `pull_request`
  and `workflow_dispatch`, which `build.yml`'s push-only trigger doesn't cover.

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
    inline `<svg>`. Run `npm run icons` after adding or removing one; `check-icons.mjs` fails if the
    bundle drifts. This is why the interface needs no icon webfont — and why nothing an
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

### GraphQL is being removed

An earlier iteration of 3.x used GraphQL/Apollo. **All of it is deprecated** — there is no GraphQL
server left in `backend/`, and `APOLLO_CLIENT` is not defined as a global, so any call still going
through it throws. `blocks/block-index/` also still imports a `tree.graphql`.

Three files under `frontend/src/` make live `APOLLO_CLIENT` calls, and each needs a REST endpoint
that does not exist yet, so the feature behind it is currently broken:

| File | Feature |
| ---- | ------- |
| `components/AuthLoginPanel.vue` | self-registration (the `register()` call only — passkey login and 2FA are REST now) |
| `pages/AdminNavigation.vue`, `pages/AdminUtilities.vue` | assorted admin actions |

When touching such a file, port it to the REST API (`API_CLIENT` + the matching `backend/api/` route)
rather than extending the GraphQL code. If the REST endpoint doesn't exist yet, add it under
`backend/api/` following the schema + permissions conventions above — `sites/:siteId/images/:kind`,
which replaced the logo and favicon upload mutations in `AdminGeneral.vue`, is a recent example of
doing exactly that.
