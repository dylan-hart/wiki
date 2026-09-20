# Cardinal.js frontend

Frontend-specific conventions for `frontend/`. See the root `CLAUDE.md` for what spans the whole
repo.

## Layout

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
  `passwordStrength.js`, `randomPassword.js`, `headStyle.js`, `accessibility.js`, `siteImages.js`.
- `src/renderers/` — page content rendering pipeline: `markdown.js` plus `modules/` (katex, kroki,
  plantuml, markdown-it plugins).
- `src/css/` — `tailwind.css` (theme tokens, utilities and the shared component classes) plus a
  handful of plain CSS partials (`app.css`, `_base.css`, `_page-contents.css`, ...), assembled by
  `app.css`'s own `@import`s and loaded once, globally, by `main.js`. There is no preprocessor:
  Sass was removed entirely (OpenProject #1160 / #3172's spike, #3246–#3254), and every `<style>`
  block a component carries is plain CSS with native nesting, resolving against the `var(--color-*)`
  / etc. tokens `tailwind.css` declares.
- `src/assets/`, `public/`, `index.html`.

Path alias `@` → `frontend/src` (defined in `vite.config.js`; `jsconfig.json` mirrors it for the IDE).

Dev server runs on **3001** and proxies `/_api`, `/_blocks`, `/_icons`, `/_site`, `/_thumb`, `/_user`
to the backend on **3000**, so the backend must be running too.

## Frontend patterns

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
  root CLAUDE.md's Utilities and dates section; `lodash-es` and `luxon` have both been fully removed.
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
  watcher and its mounted load, the "no `currentSiteId`, don't fetch" guard, the "am I editing
  the site I am browsing" gate in front of `onSavedCurrentSite`, and (Task #3195) `load()` dropping
  a response rather than applying it once it is stale — superseded by a newer `load()` call, or
  landing after the reader has already edited `state.config`/`extraState` since this fetch started.
  A page keeps only what is its own — `defaultConfig()`, the requests, the payload mapping, and any
  action beyond loading and saving;
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

## Testing (frontend)

`frontend/`'s test runner is **Vitest** + **`@vue/test-utils`**, run via `npm run test` (→ `vitest
run`). Config is `vitest.config.js`, deliberately separate from `vite.config.js` — that file also
wires up the twemoji-assets plugin (does a real filesystem copy in `writeBundle` and throws unless
the `twemoji-assets` tarball dependency is resolvable) and `vite-plugin-vue-devtools`, and reads
`../config.yml` at import time for the dev proxy port, none of which a unit test needs or wants
paying the cost of on every run.

**The policy for what earns a test and at which layer** follows the same settled reasoning as
`backend/CLAUDE.md`'s Testing (backend) section, from a classification of every suite in this
workspace — the real-Chromium layer, the source-scanning gates and the `describe.each` convention
are settled by it; the mechanics below stand unchanged.

What IS mirrored from `vite.config.js`, because component code has to resolve exactly the way it
does in the real build, not because it was convenient to share:

- the **`@` alias**, `vue()`'s `isCustomElement` rule for `<iconify-icon>`, and
  `transformAssetUrls` — every component compiles the same way under test as it does in the app;
- the **Tailwind plugin** — component markup is full of Tailwind utility classes;
- **`test.css: true`** in the Vitest `test` block — Vitest stubs out CSS processing by default (a
  `<style>` import resolves to `{}` and nothing reaches the document), which would silently skip
  the very thing several suites verify: an SFC's own `<style>` block actually applying (`PageToc.vue`
  and its `--page-toc-*` token wiring is one proof case). With it on, each mounted component's style
  block is read and injected into the test document for real, the same way `vite build` ships it.
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
- **`css.transformer: 'lightningcss'`** — deliberately _not_ mirrored from `vite.config.js`, which
  needs no help: real browsers parse native CSS nesting fine. happy-dom does not — a rule containing
  any nested `&` sub-rule resolves `getComputedStyle` to empty for that rule's OWN un-nested
  declarations too, not only the nested ones (verified directly). `lightningcss`'s `targets` (an
  arbitrarily old Chrome, only needing to predate native-nesting support) downlevels every SFC's
  `<style>` block to flat selectors at parse time, transparently to every test. Two side effects
  worth knowing when a test's literal-CSS-text assertion breaks: it also canonicalizes color
  keywords/values (e.g. `transparent` → `#0000`) and coalesces longhands into shorthands where
  legal (`flex-direction` + `flex-wrap` → `flex-flow`, `container-type` + `container-name` →
  `container`, `max-width` media/container conditions → `width <=` range syntax) — all equivalent
  CSS, so fix the assertion's expected text, not the source rule.

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
