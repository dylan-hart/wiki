# Cardinal.js 3.x

Next-generation open source wiki. Cardinal.js is a fork of
[Wiki.js](https://github.com/requarks/wiki), taken from its `scarlett` branch. Wherever this file
says "Wiki.js" it means **upstream**, not this project — the 2.5.x importer under `backend/migration/`
and `docs/migration/`, an upstream issue reference, or a verbatim string this codebase still emits.
Everything else is Cardinal.js.

Cardinal.js's own history begins at commit `8bb483244494c0314a2fefde9aebc1aaed250188` (2026-08-16) —
the first commit not authored by upstream. Wiki.js's `scarlett` branch is real and independently
maintained; a Wiki.js-authored commit dated after 2026-08-16 is genuine ongoing upstream work, not a
fork artifact — don't infer otherwise from a recent-looking date alone.

Four independently-installed workspaces (each has its own `package.json` / `node_modules`, there is
no root package or monorepo tooling):

| Path        | What it is                                                                 |
| ----------- | -------------------------------------------------------------------------- |
| `backend/`  | Fastify REST API server + job scheduler, Drizzle on PostgreSQL             |
| `frontend/` | Vue 3 / Vite SPA, Tailwind CSS + an in-repo component library              |
| `blocks/`   | Lit web components users embed into wiki pages                             |
| `e2e/`      | Playwright end-to-end suite, driving the built stack. See `e2e/CLAUDE.md`. |

Requires Node.js **26+** and PostgreSQL **16+**. All four workspaces are ESM (`"type": "module"`).

The backend is **TypeScript 7**; `frontend/`, `blocks/` and `e2e/` are JavaScript. See
`backend/CLAUDE.md`'s TypeScript section.

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

Fastify REST API server and job scheduler: Drizzle on PostgreSQL for data access, a piscina
thread pool for CPU-bound and scheduled work, and TypeScript 7 throughout with no build step (Node
strips types at load time). `backend/CLAUDE.md` holds its full directory layout, TypeScript
conventions, backend patterns and shared helpers, logging conventions, and testing conventions.

### `frontend/`

Vue 3 SPA on plain Vite, styled with Tailwind CSS and an in-repo `w-*` component library
(`components/shared/`), with no other UI framework. `frontend/CLAUDE.md` holds its full directory
layout, frontend patterns and the shared surfaces, and testing conventions.

### `blocks/`

Self-contained Lit web components users embed into wiki pages, one per `blocks/block-<name>/`
directory, compiled to `blocks/compiled/` and served under `/_blocks/`. See `blocks/CLAUDE.md` for
the directory layout, the `blocks/shared/` primitive layer, dark mode, the API/site-id convention,
and testing conventions.

## Commands

Run backend commands from `backend/`, frontend from `frontend/`, blocks from `blocks/`.

```sh
# backend
npm run dev              # nodemon, restarts on any backend file change
npm run start            # plain node
npm run typecheck        # tsc — type check only, never emits
npm run typecheck:watch
npm run test             # node --test — see backend/CLAUDE.md's Testing (backend) section
npm run db-generate      # drizzle-kit generate — after editing db/schema.ts
npm run db-up            # drizzle-kit up

# frontend
npm run dev            # vite dev server on :3001 (needs backend running on :3000)
npm run build          # builds into ../assets — required before the backend can serve the UI

# blocks
npm run build          # rolldown → blocks/compiled/
```

`npm run ncu` (→ `npx npm-check-updates@23 -i`) for interactive dependency updates — no pinned
devDependency; Dependabot covers routine updates.

The API is browsable via Swagger UI at `http://localhost:3000/_api` in a running instance. There is no
fixed default admin password: the admin email defaults to `admin@example.com` (override with
`ADMIN_EMAIL`), and the password is either `ADMIN_PASS` if set before first boot, or a random one
`models/users.ts#init()` generates and prints once to the startup logs otherwise — see README.md's
"First-Run Admin Account" section.

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
interchangeable, and the test for any given occurrence is: _does this sentence remain true after the
rename?_ If it describes upstream, it stays "Wiki.js".

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
4. **Comparative and historical writing** that is _about_ upstream — `docs/legal/`,
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

Each of the three workspaces has its own `.oxlintrc.json` — the backend declares the `CARDINAL` global
and node env; the frontend adds the `vue` plugin and the `API_CLIENT` / `EVENT_BUS` / `Temporal`
globals; blocks declares a browser env, with no globals of its own to add. Only the `correctness`
category is an error, everywhere.

Both tools handle `.ts` with no extra configuration, and the backend's oxlint config already enables
the `typescript` plugin. oxlint does not type-check — run `npm run typecheck` for that.

**Bumping oxlint or oxfmt's version is a dependency-bump checklist item, not a plain version-string
edit** — a newer formatter release can silently reformat files nobody touched. Reformat all three
workspaces in the same commit as the bump:

```sh
npx --prefix backend oxfmt backend frontend blocks   # reformats — not --check
npx oxlint                                            # from backend/, frontend/ and blocks/ each
```

Then confirm `npx --prefix backend oxfmt --check backend frontend blocks` exits clean before
pushing. See `docs/tooling-incidents.md` for the incident that established this.

**Never put two statements in a Vue template attribute** (`@click="doOne(); doTwo()"`) — write a
named handler instead, as `EditorMarkdown.vue` and `PageRelationDialog.vue` do. Neither the compiler
nor the formatter can be reconfigured to make this safe; see `docs/tooling-incidents.md` for why. For a
one-off where the inline form genuinely reads better, `<!-- prettier-ignore -->` on the preceding
line works (oxfmt honors Prettier's marker; there is no `oxfmt-ignore`).

### Utilities and dates

These apply to **every workspace**, `frontend/` included — not just the backend.

- **Use `es-toolkit`, not `lodash-es`.** Installed in both `backend/` and `frontend/`.
- **Use the native `Temporal` API, not luxon.** See `backend/CLAUDE.md`'s Backend patterns section
  for the Temporal gotchas worth knowing; they apply on the frontend too.
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
`manage:comments`, `manage:classification`, `publish:pages`, `write:tags` (`PAGE_PERMISSIONS`, declared in
`helpers/permissions.ts` and imported by `helpers/pageAccess.ts`). A group grants them through **rules**:
each rule names some of them (`roles`) plus how it addresses pages (`match` + `path`, or tags) and
what it does with them (`mode`: ALLOW / DENY / FORCEALLOW). Nothing is granted by default, and when
several rules match, the most specific one wins — `helpers/pageRules.ts` documents the ordering.
Ask `CARDINAL.models.groups.checkAccess(actor, permission, page)`, or
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
`CARDINAL.models.groups.checkSiteAccess(actor, permission, siteId)`.

**"Global permission OR `site:*` delegation" has one implementation**:
`CARDINAL.models.groups.checkSiteAdminAccess(req, globalPermission, sitePermission, siteId)`, with
`helpers/siteRules.ts#maySiteAdmin` as its four-argument call-site shorthand (no logic of its own;
it resolves `CARDINAL.models.groups` at call time, and exists only so a one-line gate stays one line).
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
- **Names are not interchangeable across or within kinds — with one documented exception.**
  `manage:pages` does not imply `write:pages`, and `manage:sites` does not imply any `site:*`
  permission: a rule grants the exact strings in its `roles`. The one exception is `read:source`:
  `write:pages` and `manage:pages` each imply it too, because an editor who cannot read a page's
  source cannot open the editor to begin with (`stores/page.js`'s `pageEdit` loads
  `withContent: true`, which is exactly this check). One helper, one definition —
  `helpers/pageAccess.ts#mayReadSource(req, siteId, page)` — is what every source-reading check site
  calls instead of asking `mayOnPage(req, 'read:source', ...)` directly (OpenProject #3391/#3411,
  upstream's `SOURCE_PERMISSIONS`). The `admin.groups.permissions.read:source.hint` string in
  `backend/locales/en.json` and its caption in `GroupRulesEditor.vue`'s rule editor say so to an
  administrator granting the rule, so the UI does not read as though `read:source` alone is the only
  way to get it.
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
- **Group permissions are not `manage:system`-only.** `PUT /groups/:groupId` needs `manage:groups`
  and refuses only toggling `manage:system` and editing the root administrators group, so
  `manage:groups` is effectively everything short of `manage:system`. To stop `manage:users` from
  reaching it, `POST /users` and `PUT /users/:userId` refuse adding or removing membership of a group
  carrying `manage:users`, `manage:groups` or `manage:system` unless the caller holds `manage:groups`
  or `manage:system` (`Groups.assertMembershipChangeAllowed`;
  `docs/decisions/2026-09-20-elevated-group-membership-guard.md`).
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
- **`write:scripts`/`write:styles` gate two independent things, both real.** One is
  content-sanitization survival: whether an author's raw `<script>`/`<style>` HTML typed directly
  into page content survives sanitization (`helpers/htmlSanitizePolicy.ts`'s `RenderPermissions`,
  shared by `models/rendering.ts` and `models/renderQueue.ts`) — unchanged since this fork's own
  history began. The other is per-page scripts/styles execution — `scriptJsLoad`/`scriptJsUnload`/
  `scriptCss`, stored on the page and run on every visit — which this fork deleted as dead half-built
  code at `a3a6c7994` (nothing executed the stored values then) and has since re-added, CSP-aware
  (Feature #3389, OpenProject #3406's decision record,
  `docs/decisions/2026-09-17-per-page-scripts-execution-reversal.md`, has the full reasoning for the
  reversal). Holding `write:scripts` on a page grants both at once; there is no way to hold one
  without the other.
- **Per-page script/style execution is external-file, never inline — CSP is why.** Wiki.js's own
  `32a656e7b` (2026-09-10) re-added this feature by injecting `scriptCss` as an inline `<style>` and
  running `scriptJsLoad`/`scriptJsUnload` via an inline `<script>` element appended to
  `document.body`. This fork's own mechanism instead is: `backend/controllers/pageScripts.ts` serves
  `GET /_pages/:pageId/script.js`, an ES module wrapping the page's `scriptJsLoad`/`scriptJsUnload`
  as `export function load()`/`export function unload()`; `frontend/src/composables/pageScripts.js`
  `import()`s it and calls `load()`/`unload()` explicitly, injecting `scriptCss` as a `<style>`
  element as upstream does (`style-src` already carries `'unsafe-inline'` under the shipped policy).
  The shipped `script-src 'self'` (no `'unsafe-inline'`, `core/http/security.ts`) allows a
  same-origin file like this one and refuses an inline `<script>` or a `new Function(...)` eval of
  the stored text outright — the property this design exists to keep true, verified live (not by
  static reading) by `e2e/tests/csp.spec.js`'s scripted-page case under `security.enforceCsp`.
  Blanked identically to a locked page's other fields (`models/pages.ts#toPage()`), and additionally
  while a page's own editor is open — an author previewing markup sees the page's base behavior, not
  a script or stylesheet they are mid-edit on and have not saved (upstream instead keeps both live
  over an open editor; this fork does not).
- **Execution has its own site-wide kill switch, default off: `features.pageScripts`** (Task #3403;
  `backend/models/sites.ts`, `AdminGeneral.vue`'s "Allow Page Scripts and Styles" toggle). Checked
  before `write:scripts`/`write:styles` are even consulted (`controllers/pageScripts.ts`), on every
  existing and newly-seeded site. Holding `write:scripts` on a page never by itself makes a script
  run — the same "authoring is not the same as executing" split the sanitization gate above already
  draws, applied to this mechanism too: turning the site switch on does not retroactively grant
  `write:scripts` to anyone, it only stops refusing to execute what an author who already holds it
  wrote.

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
  suites (skipped without one — see `backend/CLAUDE.md`'s Testing (backend) section); frontend and
  blocks never touch it.
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
  always uses `mdi:check`, not `la:check` — `la:check` remains correct for the many _other_ things it
  already draws (a generic dialog/overlay confirm button, a "done"/"added" state), just not this one.
  Introducing a new call site for any of these three actions means matching the settled glyph, not
  picking whichever one a nearby file happens to use.
