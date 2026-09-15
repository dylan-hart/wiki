# Cardinal.js e2e

Playwright end-to-end suite conventions for `e2e/`. See the root `CLAUDE.md` for what spans the
whole repo.

## Testing (e2e)

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
  same default the root `CLAUDE.md` documents). `playwright.config.js` sets `ADMIN_PASS`
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
  (`CARDINAL.sitesMappings[req.hostname]`, `index.ts`), so "switching sites" here means navigating the
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
  762), not only from its own `e2e.yml` — see the root `CLAUDE.md`'s Testing (CI) section for why,
  and why `e2e.yml`'s own `push: branches: [scarlett]` trigger was removed rather than left to run
  the same suite twice.
