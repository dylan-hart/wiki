# Cardinal.js 3.x

Next-generation open source wiki.  Cardinal.js is a fork of
[Wiki.js](https://github.com/requarks/wiki), taken from its `scarlett`  branch. Wherever this file
says "Wiki.js" it means **upstream**, not this project — the 2.5.x importer under `backend/migration/`
and `docs/migration/`, an upstream issue reference, or a verbatim string this codebase still emits.
Everything else is Cardinal.js.

Cardinal.js's own history begins at commit `8bb483244494c0314a2fefde9aebc1aaed250188` (2026-08-16) —
the first commit not authored by upstream. Wiki.js's `scarlett` branch is real and independently
maintained; a Wiki.js-authored commit dated after 2026-08-16 is genuine ongoing upstream work, not a
fork artifact — don't infer otherwise from a recent-looking date alone.

Four independently-installed workspaces (each has its own `package.json` / `node_modules`, there is
no root package or monorepo tooling):

| Path        | What it is                                                                               |
| ----------- | ---------------------------------------------------------------------------------------- |
| `backend/`  | Fastify REST API server + job scheduler, Drizzle on PostgreSQL                           |
| `frontend/` | Vue 3 / Vite SPA, Tailwind CSS + an in-repo component library                            |
| `blocks/`   | Lit web components users embed into wiki pages                                           |
| `e2e/`      | Playwright end-to-end suite, driving the built stack — see [Testing (e2e)](#testing-e2e) |

Requires Node.js **26+** and PostgreSQL **16+**. All four workspaces are ESM (`"type": "module"`).

The backend is **TypeScript 7**; `frontend/`, `blocks/` and `e2e/` are JavaScript. See
[TypeScript (backend)](#typescript-backend).

## Layout

### Root

- `config.yml` — instance config (copy of `config.sample.yml`). Read by the backend at boot _and_ by
  `frontend/vite.config.js` in dev mode to learn the proxy target port.
- `assets/` — **build output** of the frontend (`vite build` writes here), plus static assets under
  `assets/_assets/`. Served by the backend. Don't hand-edit.
- `dev/` — deployment/packaging artifacts: `dev/build/Dockerfile` (production image),
  `dev/noto-emoji-build/`.
- `.devcontainer/` — VS Code dev container (app + postgres + pgAdmin via docker-compose).
- `localazy.json` — translation sync config; locale strings live in `backend/locales/`.

### `backend/`

Fastify REST API server and job scheduler: Drizzle on PostgreSQL for data access, a poolifier
thread pool for CPU-bound and scheduled work, and TypeScript 7 throughout with no build step (Node
strips types at load time). `backend/CLAUDE.md` holds its full directory layout, TypeScript
conventions, backend patterns and shared helpers, logging conventions, and testing conventions.

### `frontend/`

Vue 3 on plain Vite. `src/main.js` wires it up manually: router → pinia store → `boot/*`
initializers → mount. There is no UI framework: `src/components/shared/` is the component library
(every component is `W*`, used in templates as `<w-btn>`, `<w-input>`, …), registered globally by
`boot/components.js` and styled with Tailwind.

- `src/boot/` — one-time app initializers: `analytics.js` (injects each enabled analytics provider's
  tracking snippet into `document.head` once the site store has loaded), `api.js` (creates the `ky`
  client, exposed as the `API_CLIENT` global), `components.js` (global components), `eventbus.js`
  (`EVENT_BUS` global, mitt), `externals.js`, `i18n.js`, `iconify.js` (points Iconify at this
  instance's `/_icons`), `monaco.js`, `temporal.js` (conditionally polyfills `Temporal`, awaited
  before anything else in `main.js`).
- `src/router/` — `index.js` (router factory) and `routes.js` (the full route table; page components
  are lazily imported).
- `src/layouts/` — `MainLayout`, `AdminLayout`, `AuthLayout`, `ProfileLayout`.
- `src/pages/` — route-level views. `Admin*.vue` are the admin area, `Profile*.vue` the user profile.
- `src/components/` — everything else: dialogs (`*Dialog.vue`), full-screen overlays
  (`*Overlay.vue`), editors (`Editor*.vue`), nav/tree components.
- `src/stores/` — Pinia stores (`site`, `user`, `page`, `editor`, `admin`, `common`, `flags`,
  `collab` — who else is editing the open page, the reactive face of `composables/collab.js`).
  `stores/index.js` creates the pinia instance and injects `router` into every store.
- `src/composables/` — the reusable behaviour behind more than one component. The load-bearing ones:
  `adminSettings.js` (every admin settings page's load/save skeleton — see
  [Frontend patterns](#frontend-patterns)), `siteAdminAccess.js`, `siteImage.js`,
  `adminOverlayRoute.js`, `fieldFrame.js`, `apiKeyCreateForm.js`, `anchoredFloat.js`,
  `toggleModel.js`, `previewResize.js`, `markdownCollab.js`, `fileUpload.js`,
  `fileManagerActions.js`, `pageSaveFlow.js`, `monacoDiff.js`, `screen.js`, `collab.js`.
- `src/helpers/` — pure utilities: `apiError.js`, `datetime.js`, `pagePaths.js`, `systemIds.js`
  (mirrors `backend/base.yml`'s `systemIds` — never retype the literal), `treeNodes.js`,
  `apiKeyState.js`, `markdownFences.js`, `markdownInsert.js`, `pointerDrag.js`, `blockScan.js`,
  `storageDeliveryGraph.js`, `wysiwygMenuBar.js`, `authValidation.js`, `moduleConfig.js`,
  `passwordStrength.js`, `randomPassword.js`, `injectCss.js`, `accessibility.js`, `siteImages.js`.
- `src/renderers/` — page content rendering pipeline: `markdown.js` plus `modules/` (katex, kroki,
  plantuml, markdown-it plugins).
- `src/css/` — `tailwind.css` (theme tokens, utilities and the shared component classes) plus SCSS:
  `_theme.scss` (brand colours) and `_palette.scss` (the Material ramp the older stylesheets use).
  Both are injected into every SFC by `css.preprocessorOptions.scss.additionalData` in
  `vite.config.js`, which is why templates can write bare `$primary` / `$grey-4`.
- `src/assets/`, `public/`, `index.html`.

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

**`static definition = {…}` must stay a plain object literal inside the block's own
`component.js`.** `rollup.config.mjs`'s manifest builder, `scripts/check-locale-keys.mjs` and
`definitions.test.js` all read it out of the source text rather than by importing the module, so a
definition assembled from a shared object, spread, or computed key is invisible to all three. This
holds through inheritance — a block extending a shared base still declares its own literal. Only
`static styles`, `static properties`, constructors, helpers and `render()` may move into
`blocks/shared/`.

**`blocks/shared/` is a real primitive layer — reach for it rather than copying a sibling.**

- `styles.js` — `errorBox` (make `static styles` an array with it first, then the block's own `css`
  template), `errorBoxInline` (the same declarations as an inline `style` value, for
  `block-include`, the one light-DOM block) and `captionStyles`.
- `render.js` — `renderError(message)`. Assemble the message first and hand it a finished string:
  `errorBox` sets `white-space: pre-wrap`, so a hand-written multi-line `<div class="error">` would
  draw its own indentation.
- `props.js` — `boolean`, the attribute converter that reads `"false"` as false. Spread it:
  `showIcons: { ...boolean, attribute: 'show-icons' }`.
- `body.js` — `readFencedSource(el) → { source, fenced }`, the fence-preferring body read.
- `figure.js` — `explainSourceFailure(clause, err, fenced)` (the first argument is the whole clause
  following "This", not a bare verb), `explainEmptySource(subject, { source, fence })`, and
  `figureStyles`, the `.formula`/`.drawing` shell katex and mathjax share.
- `icons.js` — the Iconify fetch, plus `MDI_PATHS` + `inlineIcon(path)` for chrome glyphs a block
  draws without a request.
- `site.js` — `fetchSite()` is the single cache over `GET /_api/sites/current` (`config.js` imports
  it), and `_resetSiteCache()` is the one test-reset hook.
- `i18n.js` — a reader-facing string a block renders resolves through `I18n` (one locale-strings
  fetch on connect, cached per locale) with the English text as its fallback, not as a bare literal.
  `scripts/check-locale-keys.mjs` deliberately does not police the `errors` namespace, so a key that
  does not exist yet resolves to its fallback rather than failing the build.
- `video-embed.js` — `VideoEmbedElement`, the base class behind `block-youtube`, `block-vimeo`,
  `block-dailymotion` and `block-m365-video`. It owns the seven player props
  (`url`/`width`/`height`/`autoplay`/`controls`/`fs`/`loop`), `_size()`, `_frameStyle()` and the
  lazily-loaded `<iframe>` `render()`; a subclass writes `_parse`, `_embedUrl` and `_providerName`,
  and may override `_source()`, the two message hooks, `_frameTitle()`, `_frameAllow()` and `static
  styles` (spread `VideoEmbedElement.styles` first). It constructs **no** `DarkMode` controller —
  there is nothing in an opaque provider iframe to restyle — so `block-youtube` and
  `block-m365-video` never take a `dark` attribute at all, while `block-vimeo` and
  `block-dailymotion` construct their own for the one border they draw.
- `diagram-image.js` — `DiagramImageElement`, behind `block-kroki` and `block-plantuml` (and
  `diagramStyles`, which `block-drawio` adopts for the sheet alone). It owns
  `server`/`format`/`caption`/`align`, a `DarkMode` controller, the body read, the
  `MAX_DIAGRAM_URL_LENGTH` pre-flight guard, `_measure()`, `_explain()` and `render()`; a subclass
  writes `_url`, `_defaultServer`, `_fenceName` and `_alt`, and may override
  `_explainBody(response)` and `_emptySourceMessage()`.

**Dark mode goes through `blocks/shared/theme.js`, never `:host-context()`.** The app's source of
truth is the `body--dark` class on `<body>`, which CSS in a shadow root cannot see; `:host-context()`
is the selector for exactly that and is what every block used to use, but only Chromium ever shipped
it — MDN has it deprecated, Firefox and Safari never implemented it, and there it silently never
matches, so the block stayed light on a dark page. Instead construct a `DarkMode` controller
(`this._darkMode = new DarkMode(this)`) in the block's constructor and write `:host([dark])`; the
controller keeps that attribute in step, sharing one MutationObserver across every block on the page.
A block that must _act_ on the change rather than restyle for it passes `onChange`, or reads
`.isDark` — `block-diagram` redraws mermaid in its own dark theme, `block-map` resolves a per-block
`theme` prop that can pin a map light on a dark page.

**Reaching the API and learning the site id goes through `blocks/shared/site.js`, never
`globalThis.API_CLIENT` / `globalThis.WIKI_STATE`.** A block sitting in page content has no siteId
of its own and no page store threaded down to it — those SPA globals
(`frontend/src/boot/externals.js`) exist only inside the app shell, so a block reading them cannot
run in a context that mounts blocks without it (page-level pre-rendering is a future task,
concretely). The one convention every block uses instead (OpenProject #1969):

- **Site id**: `getSiteId()`, plus plain `fetch` for the actual request. Both read off the same
  public, hostname-routed `GET /_api/sites/current` `getBlockConfig` (`shared/config.js`) already
  uses, cached per page load the same way. `fetch` carries the session cookie same-origin exactly
  as `API_CLIENT` did, so a signed-in reader's request is still the one they'd get anywhere else —
  the server's own page-rule checks decide what comes back, not anything the client claims.
- **Current page locale/path**: `getCurrentPage()`, read off `location.pathname` against the site's
  active locale codes (`getSiteLocales()`) rather than a page store — the one thing a block CAN know
  about its own page without asking the server, since the reader is looking at it.
- **This reader's own page-rule permissions on the current page** (what `WIKI_STATE.user.can(...)`
  used to answer, e.g. `block-checklist`'s "may I check this off"): `getCurrentPageAccess()`, which
  resolves the page id AND `viewer.permissions` off `GET /_api/sites/:siteId/pages/:hash` — the same
  publicly-readable, per-page-rule-checked route the page view itself loads a page through. There is
  no public, group-wide permission route to call instead; a permission with no page-rule shape at all
  has no convention here yet and needs one written down before landing.

`block-index`, `block-include` and `block-checklist` are the reference conversions (`block-live-data`
and `block-map` were the first two blocks onto the site id half, before the rest of this existed).
No block reads `API_CLIENT` or `WIKI_STATE` any more; a new one that does is a regression.

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

### What "verified" means

**A change is verified when the gate is green _inside the pinned dev container_, not when it is
green on your host.** Run it:

```sh
./scripts/verify-ci.sh            # from anywhere in the repo
npm --prefix backend run verify:ci -- --help    # the same thing, npm-shaped, plus its own docs
```

This is an instruction, not a suggestion. It exists because fixes were repeatedly marked resolved
after passing on a Node 25.9 host and then failing on CI's Node 26 — a whole class of "fixed" work
that was never fixed. `.devcontainer/` (`ARG NODE_VERSION`, the one declaration of the pin) is built
to _be_ what the workflows run on; `scripts/verify-ci.sh` runs, inside it, every command
`.github/workflows/quality.yml`'s gate job runs, in the same order, stopping at the first failure the
way the job does. `backend/test/verifyCi.test.ts` parses that workflow and fails when a gate command
exists there and not in the script, so the two cannot drift apart quietly.

Four things worth knowing before you rely on it:

- **It refuses to run outside the image.** The running Node must equal the Dockerfile's pin, pandoc
  and git-cliff must be on `PATH`, a Playwright browser must exist, and `DATABASE_URL` must be set —
  every one of those, missing, turns real coverage into a silent skip rather than a failure.
  `VERIFY_CI_ALLOW_HOST=1` downgrades the refusal to a banner; a run with it set is not a
  verification and must not be reported as one.
- **Green is not the same as "everything ran."** The command prints the backend suite's skipped
  count beside its verdict for exactly this reason. Read it.
- **The e2e suite is opt-in (`--e2e`)** — it is not part of `quality.yml` at all (it lives in
  `build.yml`'s `build` job), so running it by default would itself be a divergence from the gate
  being mirrored. `--smoke-boot` likewise adds `quality.yml`'s separate production-install boot job,
  opt-in because it swaps `backend/node_modules` for the production tree.
- **The flaky-test quarantine lane runs report-only** and never changes the exit code, matching the
  report-only lane step in `quality.yml`.
- `release.yml` needs no separate command: its gate is a strict subset of `quality.yml`'s.

`./scripts/verify-ci.sh --help` is the authority on the flags and on what each one does and does not
cover.

## Conventions

### Product name

This product is **Cardinal.js**. Upstream, which it forked, is **Wiki.js**. The two are never
interchangeable, and the test for any given occurrence is: *does this sentence remain true after the
rename?* If it describes upstream, it stays "Wiki.js".

```sh
grep -rI "Wiki\.js\|wiki\.js\|wikijs" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=assets .
```

That is expected to keep returning hits, and a reviewer should be able to account for every one of
them under these five categories. This is a **reviewed expectation, not a CI gate** — encoding the
exclusion list somewhere would just fail the moment a legitimate new upstream reference is written.

1. **The 2.5.x importer** — `backend/migration/`, `docs/migration/`. It genuinely reads real Wiki.js
   2.5.x databases; renaming would make the code and its field-mapping specs describe a product that
   does not exist. `ImportPageDialog.vue` and `ImportBatchPageDialog.vue`'s "Wiki.js's own Markdown"
   are the same case.
2. **The AGPL-3.0 copyright and attribution notices**, and `README.md`'s modification notice, which
   has to name what was modified.
3. **Upstream's own URLs, repos, accounts and community** — `requarks/wiki` issue links,
   `requarks/wiki-locales`, `opencollective.com/wikijs`, `js.wiki`, and the inherited
   `.github/CONTRIBUTING.md` / `SECURITY.md` / `ISSUE_TEMPLATE*` / `FUNDING.yml`, each of which
   carries a note saying so at its head.
4. **Comparative and historical writing** that is *about* upstream — `docs/legal/`,
   `docs/logging-reviews/`, `docs/variances.md`, `docs/auth-provider-audit.md`.
5. **Verbatim runtime literals this codebase still emits**, quoted in docs so the doc matches what
   the reader will actually see: the `Wiki.js - <id>` `application_name` on pg connections, the
   `=== Wiki.js 3.0.0 ===` boot banner, `admin.security.trustProxyHint`. A doc quoting one changes
   only in the same commit that changes the literal.

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

**Bumping oxlint or oxfmt's version is a dependency-bump checklist item, not a plain version-string
edit.** A newer formatter release can change what it considers correctly formatted, silently
invalidating files nobody touched. Whenever either tool's version changes, run the reformat (not just
the check) across all three workspaces from the repo root in the **same commit** as the bump, and
commit whatever it touches:

```sh
npx --prefix backend oxfmt backend frontend blocks   # reformats — not --check
npx oxlint                                            # from backend/, frontend/ and blocks/ each
```

Then confirm `npx --prefix backend oxfmt --check backend frontend blocks` exits clean before
pushing. Skipping this step is exactly how a version bump ships a red CI gate with nothing wrong in
the code itself.

**Never put two statements in a Vue template attribute.** `@click="doOne(); doTwo()"` builds today
and is a build error the moment the file is formatted, because `semi: false` and Vue disagree about
the same character. Vue's `transformOn` decides whether an inline handler is a statement block or an
expression from `exp.content.includes(';')` — with the semicolon it emits `$event => { … }`,
without it `$event => ( … )`. oxfmt breaks the handler across lines and drops the semicolon, so Vue
parenthesises two statements and the template fails to compile (`Error parsing JavaScript
expression: Unexpected token`). Write a named handler instead — `@click="closeAndRefresh"` — as
`EditorMarkdown.vue` and `PageRelationDialog.vue` do.

Neither side of that is worth reconfiguring, so don't try — neither the compiler nor the formatter
can be fixed here. For a one-off where the inline form genuinely reads better, `<!-- prettier-ignore -->`
on the preceding line works (oxfmt honors Prettier's marker; there is no `oxfmt-ignore`).

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
`manage:comments`, `manage:classification`, `publish:pages` (`PAGE_PERMISSIONS`, declared in
`helpers/permissions.ts` and imported by `helpers/pageAccess.ts`). A group grants them through **rules**:
each rule names some of them (`roles`) plus how it addresses pages (`match` + `path`, or tags) and
what it does with them (`mode`: ALLOW / DENY / FORCEALLOW). Nothing is granted by default, and when
several rules match, the most specific one wins — `helpers/pageRules.ts` documents the ordering.
Ask `WIKI.models.groups.checkAccess(actor, permission, page)`, or
`mayOnPage(req, permission, siteId, page)` in `helpers/pageAccess.ts`.

**Site-scoped delegation permissions** are bound to a site (not a path): `site:general`,
`site:theme`, `site:navigation`, `site:blocks`, `site:approvals`, `site:login`, `site:locale`,
`site:editors` (`SITE_PERMISSIONS` in `helpers/siteRules.ts`) — one per delegable admin settings
surface, for handing a non-`manage:sites` user control of specific sites without making them a full
site administrator. A group grants them through the **same rule rows** page permissions use
(`GroupRule.roles` is one shared vocabulary space across both kinds), just addressed by `sites`
alone instead of `path`/`match`/`locales`: an empty `sites` array means every site, a populated one
means only those ids. Nothing is granted by default; `helpers/siteRules.ts#resolveSiteRule` documents the ALLOW <
DENY < FORCEALLOW tie-break, the same ordering `helpers/pageRules.ts` uses. Ask
`WIKI.models.groups.checkSiteAccess(actor, permission, siteId)`.

**"Global permission OR `site:*` delegation" has one implementation**:
`WIKI.models.groups.checkSiteAdminAccess(req, globalPermission, sitePermission, siteId)`, with
`helpers/siteRules.ts#maySiteAdmin` as its four-argument call-site shorthand (no logic of its own;
it resolves `WIKI.models.groups` at call time, and exists only so a one-line gate stays one line).
The global half is checked first and is site-blind, so delegation is additive rather than a
migration; the site half is `checkSiteAccess()` unchanged, site pin, API-key scope boundary and
`manage:system` bypass included. Do not write a route-file wrapper around it.

Consequences worth knowing:

- **A page or site-scoped permission cannot be enforced by `config.permissions`.** That hook reads
  the group-wide list only, so `permissions: ['write:pages']` refuses everybody. A route that turns
  on one of these declares no route permission and checks in the handler instead — say so with a
  `No route-level permissions:` comment, as `api/pages/`, `api/assets.ts`, `api/blocks.ts` and
  `api/sites.ts`'s site-scoped routes do.
- **A page-scoped route's 404/403 preamble is `helpers/pageAccess.ts#requireReadablePage`, not
  hand-written**, and its check order is load-bearing: missing-or-unreadable → 404 `'This page does
  not exist.'`, then the route's own second permission → 403 with its own message, then still-locked
  → 403 `'This page is password protected.'`. A route needing a different order calls it without
  `permission` and checks afterwards (`api/checklists.ts`'s check-off route); one that deliberately
  tolerates a locked page passes `allowLocked: true` (`api/pages/read.ts`'s backlinks listing). It
  returns `null` once a reply is sent (`if (!page) { return reply }`), the same convention
  `requireActorId` uses. `actorFrom`, `mayBypassPassword`, `unlockedFor`, `pagePermissionsFor`,
  `mayOnAsset`, `mayOnFolder` and `visibleTreeItems` live beside it.
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
- **`publish:pages` is a standalone grant, not an add-on to `write:pages`.** Holding it alone lets an
  actor toggle a page's `publishState` even on a page they otherwise cannot edit at all, and it is
  the ONLY thing that can change `publishState` — holding `write:pages` (or `manage:pages`) without
  it does not, unlike every other content field (OpenProject #2421/#2466). A request that changes
  `publishState` together with anything else still needs `write:pages` for that anything else.
- **`write:scripts`/`write:styles` gate content sanitization, not a per-page script/style injection
  feature.** A separate `pages.scripts` column (`scriptJsLoad`/`scriptJsUnload`/`scriptCss`) and its
  `PageScriptsDialog.vue` editor once existed but nothing ever executed the stored values; both were
  deleted as dead half-built code. The permission names stay fully live — they gate whether an
  author's raw `<script>`/`<style>` HTML in page content survives sanitization
  (`helpers/htmlSanitizePolicy.ts`'s `RenderPermissions`, shared by `models/rendering.ts` and
  `models/renderQueue.ts`).

### Frontend patterns

- **Templates are plain HTML.** A handful of pre-3.x leftovers are still `<template lang="pug">` —
  check the file you're editing rather than assuming.
- **UI components come from `components/shared/`**, registered globally, so `<w-btn>` / `<w-input>`
  / `<w-icon>` need no import. Each one is scoped to how this app actually uses it rather than to
  the full API of the framework component it replaced; the header comment in each file says where
  they differ. Add a prop there rather than reaching around it. The library has one deliberately
  **unregistered** member: `components/shared/WFieldFrame.vue` draws the shared Material field
  chrome around whichever control its caller renders and is internal to `WInput` and `WSelect`, so
  it is absent from `components/shared/index.js` and there is no `<w-field-frame>` to write in app
  markup. Its sibling is `composables/fieldFrame.js` (`fieldProps` + `useFieldFrame`), which owns
  the twelve props both fields declare, `validate()`, and the frame's computed colours and classes;
  a third field type uses both, and nothing else should reach for either.
- **There is no SSR build.** `import.meta.env.SSR` appears nowhere in `frontend/src` — Vite folds it
  to `false`, so every branch behind it was unreachable. `boot/{api,eventbus,externals}.js` assign
  onto `window` unconditionally and `router/index.js` uses `createWebHistory` only; don't
  reintroduce the pattern.
- **`useScreen()` returns `gte` only** (`gte.sm`/`.md`/`.lg`/`.xl`). The old `gt.*` shorthand
  resolved to the same four refs one breakpoint along and is gone: `gt.md` is `gte.lg`.
- **`userStore` has one date-time formatter**, `formatDateTime(t, date, { seconds, zone })`, plus
  `formatDate(date)` (date alone, no `t`) — not four near-namesakes.
- **"dirty" and "clean" are editor-store actions, not raw timestamp writes.**
  `editorStore.markDirty()` is what a component calls when the reader changed something;
  `markClean(extra?)` equalizes both timestamps and merges `extra` into the same `$patch`;
  `ensureConfigs()` fetches the editor configs unless already loaded. New editor code uses these
  rather than assigning `lastChangeTimestamp` by hand.
- HTTP calls go through the `ky` client, reachable as the `API_CLIENT` global (declared in the oxlint
  config, so no import needed) — e.g. `await API_CLIENT.get('sites').json()`. It handles the `/_api`
  prefix; authentication is the session cookie, sent with every request.
- Cross-component messaging uses the `EVENT_BUS` global (mitt).
- State lives in Pinia option stores. For utilities and dates use `es-toolkit` and `Temporal` — see
  [Utilities and dates](#utilities-and-dates); `lodash-es` and `luxon` have both been fully removed.
- **Where an admin settings control saves from** depends on whether the page it sits on _is_ a
  settings form or merely _contains_ one. A page that is one settings form top to bottom commits
  from a header `unelevated` primary `common.actions.apply` button (`AdminGeneral.vue`,
  `AdminTheme.vue`, and eleven more siblings). A setting embedded in a page whose primary content
  is something else — a list, a viewer, a picker-plus-panel like `AdminSearch.vue` — gets its own
  card-local save control instead (`AdminSearch.vue:105`, `AdminAuditLog.vue:174-180`).
- **An admin settings page's load/save skeleton is `composables/adminSettings.js`, not
  hand-written.** `useAdminSettings({ i18nPrefix, keys, siteScoped, overlay, defaults, extraState,
  fetch, pick, onLoaded, commit, onSaved, onSavedCurrentSite })` returns `{ state, load, save,
  refresh }` and owns the `state.loading` gauge, the full-screen overlay raised and lowered inside
  `load()` (never by the caller's watcher), the
  `<prefix>.loadFailed`/`.saveSuccess`/`.saveFailed`/`.refreshSuccess` toasts, the failed-save
  caption (`t('<prefix>.' + err.data?.error, apiErrorMessage(err, …))` — the page's own wording for
  the server's error code, falling back to the server's message), the `adminStore.currentSiteId`
  watcher and its mounted load, the "no `currentSiteId`, don't fetch" guard, and the "am I editing
  the site I am browsing" gate in front of `onSavedCurrentSite`. A page keeps only what is its own —
  `defaultConfig()`, the requests, the payload mapping, and any action beyond loading and saving;
  page-specific reactive fields go in `extraState` so the template keeps reading `state.x`. `save()`
  answers `true`/`false` so a page can act only on a stored change, and `refresh()` is the
  composable's, not a per-page `await load(); notify(...)` wrapper. Twenty pages use it;
  `AdminComments` and `AdminStorage` are the two deliberate hold-outs (each does more inside its own
  `save()` than the options cover).
- **Six shared surfaces are the only supported way to do these things**, and a new call site reaches
  for them rather than writing its own copy:
  - `components/ModuleConfigForm.vue` + `helpers/moduleConfig.js` (`buildConfigEditor`,
    `buildConfigPayload`) render and serialise EVERY module's config — Analytics, Auth, Comments,
    Search and Storage all go through them, and a `readOnly` prop draws as a hinted `div`.
    Sensitive inputs carry `autocomplete="new-password"` there, so every page inherits it.
  - `composables/siteImage.js#useSiteImage(kind, …)` owns the pick → validate → upload/clear → toast
    → cache-bust cycle for a site's logo, favicon and login background (`helpers/siteImages.js`
    stays the transport).
  - **A "delete this" confirmation is `confirm({ destructive: true, persistent: true })`**, not a
    bespoke `*DeleteDialog.vue`. `Page`/`Site`/`User`DeleteDialog remain only because each does more
    than confirm (a navigation refetch, a type-the-title guard, content reassignment); a fourth
    look-alike dialog is the regression. The shared dialog has no in-dialog loading state and no
    retry-in-place on failure — the toast reports it.
  - `helpers/passwordStrength.js#passwordStrengthBadge(password, t)` is the single score →
    `{ color, label }` mapping, resolving against `common.password.*`.
  - `helpers/randomPassword.js` exports `PASSWORD_CHARSET` / `PASSWORD_CHARSET_UNAMBIGUOUS`; a
    dialog picks one rather than pasting a literal. `helpers/systemIds.js` likewise owns
    `GUESTS_GROUP_ID`.
  - `composables/adminOverlayRoute.js#useAdminOverlayRoute({ overlay, listPath, onClosed })` is the
    `:id`-in-the-route ↔ `adminStore.overlay` plumbing for an admin list page with an edit overlay.
    It registers its own lifecycle hooks, so an adopting page drops its `checkOverlay()`, both
    watchers and its overlay-clearing unmount hook.

### Testing (frontend)

`frontend/`'s test runner is **Vitest** + **`@vue/test-utils`**, run via `npm run test` (→ `vitest
run`). Config is `vitest.config.js`, deliberately separate from `vite.config.js` — that file also
wires up the twemoji-assets plugin (does a real filesystem copy in `writeBundle` and throws unless
the `twemoji-assets` tarball dependency is resolvable) and `vite-plugin-vue-devtools`, and reads
`../config.yml` at import time for the dev proxy port, none of which a unit test needs or wants
paying the cost of on every run.

**The policy for what earns a test and at which layer** follows the same settled reasoning as the
backend's testing section above, from a classification of every suite in this workspace — the
real-Chromium layer, the source-scanning gates and the `describe.each` convention are settled by
it; the mechanics below stand unchanged.

What IS mirrored from `vite.config.js`, because component code has to resolve exactly the way it
does in the real build, not because it was convenient to share:

- the **`@` alias**, `vue()`'s `isCustomElement` rule for `<iconify-icon>`, and
  `transformAssetUrls` — every component compiles the same way under test as it does in the app;
- the **Tailwind plugin** — component markup is full of Tailwind utility classes;
- the **SCSS `additionalData` injection** (`css.preprocessorOptions.scss`) — several SFCs' `<style
lang="scss">` blocks reach for a bare `$primary` / `$grey-9` / ... (`PageToc.vue` is the test
  suite's proof case), which only resolves under test if the same `@use '@/css/_theme.scss' as *;
@use '@/css/_palette.scss' as *;` runs here. Miss this and such a component doesn't fail its
  assertion — it fails to even _compile_ with a Sass "undefined variable" error, which wastes time
  chasing the wrong problem. `test.css: true` in the Vitest `test` block is required alongside it:
  Vitest stubs out CSS processing by default (a `<style>` import resolves to `{}` and nothing is
  actually run through Sass), which would silently skip the very thing being verified.
- **`vue()`'s template `compilerOptions.comments: false`** — deliberately _not_ mirrored from
  `vite.config.js`, and load-bearing rather than optional. `@vitejs/plugin-vue` preserves
  template-level comments in dev mode (matching vue-loader's old behaviour) but strips them for
  `vite build`. Several SFCs — `WCheckbox.vue` among them — open with an explanatory HTML comment as
  a template-level _sibling_ of their root element, not a child of it: left in, the component
  compiles to a two-node Fragment root instead of a single element. Vue itself handles that fine at
  runtime, but `@vue/test-utils` resolves `wrapper.element` (and therefore `.attributes()`,
  `.classes()`, `.find()` off the wrapper root, ...) from the component's single root node, and
  falls back to the test's own mount container when there isn't one — silently, with no error — so
  every one of those reads the wrong element. Forcing `comments: false` reproduces the single-root
  shape these components actually ship with in production, which is what a test should be verifying
  against.

- **File convention: co-located `*.test.js`**, matching the backend's `*.test.ts` convention — a
  test lives next to the file it covers (`components/shared/WBtn.vue` →
  `components/shared/WBtn.test.js`), not in a mirrored `test/` tree. `test/` itself is reserved for
  the harness's own shared fixture code, matching what `backend/test/` reserves `test/` for;
  `vitest.config.js`'s `include` also covers `test/**/*.test.js`, so the harness has its own named
  coverage and a break in it fails as itself rather than as a hundred unrelated component failures.
  - **The suites split by concern, so a filename names what it covers**: `stores/page.{save,load,
    lifecycle,derived}`, `pages/Graph.{rendering,sizing,tooltip,i18n,layout,fallback}`,
    `components/EditorMarkdown.{content,preview,resize,assets,lifecycle}`, and so on.
  - **A cross-component assertion is a `describe.each`, not a copy** —
    `components/editorMarkupShared.test.js` and `components/apiKeyScopeTree.test.js` hold what is
    identical between two components; what genuinely differs stays in each component's own suite.
    `src/docsBaseGate.test.js` is the one `docsBase` gate (fork-invented surfaces that must carry no
    help button), with an existence check so a rename cannot retire a guard silently.
  - **A test-only sibling module is a plain `.js`, never a `*.test.js`** — `pages/graphFixtures.js`,
    `components/editorMarkdownHarness.js`, `components/pageActionsHarness.js`. The include glob
    collects only `*.test.js`, so these are imported and never run as a suite. A `vi.mock(...)` call
    must still live in each test file (it is hoisted per file); the harness exports the factory.
- **A suite does not build its own i18n, router, pinia or mount.** `frontend/test/` is a real
  harness:
  - `test/i18n.js` — `createTestI18n(messages)` (nests under `en`, takes flat-dotted or nested keys,
    missing/fallback warnings off).
  - `test/router.js` — `await createTestRouter(routes, initialPath)` (bare strings become stub
    routes; does the `push` + `isReady()` coda by hand-written sites used to repeat) and the
    synchronous `buildTestRouter(routes)`.
  - `test/mount.js` — `mountWithApp(Component, { props, messages, routes|router, initialPath,
    stores, stubs, components, attachTo, …mountOptions })` → `{ wrapper, router, i18n, siteStore,
    userStore, pageStore, adminStore, editorStore, flagsStore }`. Fresh pinia per call. It writes to
    a store only when `stores` names it, so a suite asserting against an untouched store still can.
  - `test/fixtures.js` — `seedSite`/`seedUser`/`seedPage`/`seedAdmin(overrides)` and `stubRouter`.
  - `test/mocks.js` — `createApiClientStub()` plus `stubApi(routes, { method, fallback })`, a
    URL→payload table (a plain object for exact keys, a `Map` when a route needs a `RegExp`; a
    function value is called per request) returning `{ calls }`.
  - `test/sourceFiles.js` — `listSourceFiles(root, { ext, skip })`, the one recursive walker for the
    source-scanning suites.
  - **`stubs` defaults to `{ teleport: true }`**, and a suite that asserts against `document.body`
    opts out with `stubs: {}` and a one-line reason — `w-dialog`/`w-menu`/`WTooltip` really do
    teleport their body out of the wrapper.
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
  sync as components are added. `BlueprintIcon`, `LoadingGeneric` and `StatusLight` are registered
  there too, from the same imports `boot/components.js` uses; **a suite must not re-register or stub
  them**, or the same component renders two different ways depending on the file.
- **`WInput` puts `aria-label` on the `<input>` itself**, so a test selects it as
  `input[aria-label="X"]` — never the ancestor form `[aria-label="X"] input`, which cannot match.
- **`Temporal` polyfill**: loaded eagerly in `test/setup.js` when the global is absent, the same way
  `boot/temporal.js` lazily polyfills it for pre-Temporal Safari — this sandbox's Node 25.9 lacks it
  natively (engines requires >=26), same environment note as the backend's testing section.
- Prefer mounting the real component over shallow-rendering or over-mocking — `WChip.test.js` /
  `WBtn.test.js` / `WCheckbox.test.js` and `stores/user.test.js` (permission checks, guest/profile
  state transitions, `logout()`'s `API_CLIENT`/`EVENT_BUS` round-trip, `Temporal`-backed date
  formatting) are the reference examples of testing real behaviour end-to-end through the harness
  rather than merely asserting Vitest boots.
- **Two suites drive a real headless Chromium page**, via `test/realGridLayout.js`:
  `ApiKeyCreateDialog.test.js` and `ProfileApiKeyCreateDialog.test.js`'s "real layout" describes.
  Neither `jsdom` nor `happy-dom` runs a layout engine, so a test that needs to know how many
  columns an `auto-fit`/`minmax()` CSS Grid actually renders at a given width launches Playwright's
  bundled Chromium instead. `npm ci` installs the `playwright` library only, not the browser
  binary — run `npm run install-browsers` (mirrors `e2e/`'s own script) once per machine to fetch
  it. `test/realGridLayout.js` probes for a real Chromium at module top level and exports
  `hasChromium()`; both suites pass `{ skip: !hasChromium() }` to their `describe()` so a `npm run
  test` with no Chromium installed reports them skipped and exits zero instead of failing on an
  environment precondition.
- **Any visual/aesthetic change (CSS, theming, layout) gets rendered and looked at, not reasoned
  about from the stylesheet.** Neither `jsdom` nor `happy-dom` runs a layout engine (above), and CSS
  reasoning alone has been directly, repeatedly wrong on this codebase — including a token declared
  only in one theme block that read as correct in the diff and drew ink on ink on screen. The loop:
  a throwaway `postgres:18` container → `npm run build` in `frontend/` → `CONFIG_FILE=…
  DATABASE_URL=… node backend` from the repo root → Playwright's bundled Chromium (already in
  `frontend/node_modules` once `install-browsers` has run) to log in, set the theme via `PUT
  /_api/sites/:id`, and screenshot. Seed content through the REST API with an `origin` header (the
  write routes refuse cross-origin). Screenshot before starting (to see what's actually wrong, not
  what the task description assumes), after each change, and in every relevant mode — light/dark at
  minimum. Fall back to `getComputedStyle` when a screenshot is ambiguous; a downsampled PNG can hide
  a small colour difference a token check would catch instantly.

### Testing (blocks)

`blocks/`'s test runner is **Vitest**, run via `npm run test` (→ `vitest run`). Config is
`blocks/vitest.config.js` — deliberately minimal, no plugin stack to mirror the way frontend's does:
a block has no build-time template compilation (`rollup.config.mjs` bundles plain ESM, it doesn't
transform it) and no app framework around it, so a test loads `component.js` exactly as the browser
would.

**The same settled testing policy governs what earns a test here and at which layer.** `blocks/`
was not separately classified by the #2687/#2688 audits, but the layers and the "what gets no test
at all" rules apply to it unchanged — a block's suite sits at the component layer.

- **`environment: 'jsdom'`**, not `happy-dom` (frontend's choice). A block's whole surface under test
  _is_ its shadow DOM — attribute reflection, light-DOM content read out of `this.textContent` /
  `querySelector`, Lit's `adoptedStyleSheets`-or-injected-`<style>` fallback — and jsdom's coverage of
  that is the more complete of the two emulators. Verified directly rather than assumed: a
  `MutationObserver`-driven dark-mode toggle (see below) round-trips correctly under jsdom with no
  workarounds. If a future block's test needs something jsdom doesn't emulate, the task spec's
  documented fallback is `@web/test-runner` (runs in a real browser, no DOM emulation at all) — not a
  different DOM emulator.
- **File convention: co-located `*.test.js`**, matching the `*.test.ts` / `*.test.js` convention in
  `backend/` and `frontend/` — `block-gallery/component.js` → `block-gallery/component.test.js`, and
  the same rule covers `shared/`, where every module but `compress.js` has a co-located suite.
  `vitest.config.js`'s `include` is `**/*.test.js`, so a helper file under `blocks/test/` **must
  not** end in `.test.js` — the glob would run it as a suite.
- **Mounting goes through `blocks/test/mount.js`.** `mountBlock(tag, { pre, text, html, props,
  attrs, parent, settle })` builds the three body shapes the markdown renderer actually produces —
  `pre` for a fenced body, `text` for an unfenced one, `html` for markup a block reads structure out
  of — since a block reads its content from the _light_ DOM, not from props. `settle` is a number of
  macrotask turns for a block with an async `connectedCallback`, or a function for one that exposes
  its own handle (`settle: (el) => el._ready` for the two diagram blocks). `resetBlockDom()` is the
  universal `afterEach`, and `stubSiteFetch({ site, ok, onRequest })` + `TEST_SITE_ID` cover the
  `GET /_api/sites/current` hop every API-talking block makes first. Reactive `@property` fields can
  still be set directly as JS properties (`el.thumbnailSize = 240`) rather than through attribute
  strings — simpler than reconstructing Lit's casing and converter rules, and the same reactive
  update path either way.
- **Dark mode is `blocks/test/darkMode.js#describeDarkMode(mount, { inverted, attribute })`**, which
  IS the suite: call `describeDarkMode(() => mountX(...))` at the end of a block's `describe` rather
  than writing the toggle by hand. `inverted` is for a block mounted light and then turned dark
  (`block-live-data`); `attribute: false` for one whose controller is constructed with `{ attribute:
  false }` and so has no `dark` attribute to read (`block-map` — the controller's own `isDark` is
  asserted instead). `block-diagram` keeps a bespoke describe, because dark mode there is a real
  second `_draw()` rather than a restyle. The controller reacts through a `MutationObserver`
  callback, which runs as a microtask in jsdom same as a real browser, so no fake timers or polling
  are needed.
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

**The same settled testing policy is deliberately restrictive about this layer:** a flow earns an
e2e spec when its failure mode is *the pieces not fitting together*. Permission matrices, error
taxonomies and accessibility properties belong above it, in the unit and component suites, which is
where they are.

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
- **`helpers/admin.js` is composable, not one all-or-nothing flow.** `createAndPublishPage` is
  nothing but a call to `openMarkdownEditor(page, { path, title, origin, locale })`, then
  `typeBody(page, body, { paste, previewWaitText })`, then `savePage(page, path, { locale })`, in
  order — so a spec that has to do something mid-flow (`assets.spec.js`'s File Manager round trip)
  calls the three directly instead of re-inlining the contenteditable-title, Monaco-mount and
  save-dialog handling below. `submitLogin(page, email, password)` fills and submits the form
  already on screen and asserts nothing, for a login somewhere other than a fresh `/login` visit.
  `expectAuthenticatedShell` resolves through the same `authenticatedShellMarker` `loginAsAdmin`
  uses, so the two agree below the 900px breakpoint.
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
  yet; a Cardinal.js 3.x site is addressed by the request's `Host` header
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
  visitor to a _pageless_ site's root gets redirected straight to `/login` by `Index.vue`'s route
  watcher, which is real behavior but would make a root-based guest-shell assertion race that
  client-side redirect instead of asserting on a stable page.
- **CI wiring**: this suite runs as part of `.github/workflows/build.yml`'s `build` job now (task
  762), not only from its own `e2e.yml` — see "Testing (CI)" below for why, and why `e2e.yml`'s own
  `push: branches: [scarlett]` trigger was removed rather than left to run the same suite twice.

### Testing (CI)

Two workflow files split the work: `.github/workflows/quality.yml` (typecheck/lint/format +
backend/frontend/blocks unit tests) and `.github/workflows/build.yml` (version stamping, asset/blocks
building, the Playwright e2e suite, then the Docker publish). `quality.yml` is a `workflow_call:`
target that `build.yml`'s `build` job `needs:` — this is also why the e2e suite runs from
`build.yml` rather than only from its own `e2e.yml`, and why `release.yml` runs its own copy of the
gate.

- **`quality.yml`** runs on every pull request directly, and on every `scarlett` push via `build.yml`.
  Its steps: backend typecheck, then per-workspace lint (`oxlint --deny-warnings`) and the frontend's
  icon/emoji drift checks, then a `Backend/Frontend/Blocks Tests` step per workspace, then one
  repo-wide `oxfmt --check`. A `postgres:18` service container backs the backend's DB-backed model
  suites (skipped without one — see [Testing (backend)](#testing-backend)); frontend and blocks never
  touch it.
- **`build.yml`'s `build` job** stamps the alpha version, builds `frontend/`'s assets and
  `blocks/compiled`, runs the Playwright e2e suite against that build, then builds/pushes the Docker
  image — each step gating the next, so a failure never reaches the Docker push.
- **`build`'s own `postgres:18` service container** is for the Playwright leg's first-run seeding
  only — the backend's DB-backed model suites run in `quality`'s own separate container.

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
    produced or plans to carry forward that format into a `w-icon` name. `grep -rn "'las'"
    frontend/src` turns up only `helpers/storageDeliveryGraph.js`'s own comment documenting this
    rule — a new `las`/`mdi-`-style name used (not merely mentioned in a comment) anywhere in
    `frontend/src` is a regression, not merely discouraged.
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
