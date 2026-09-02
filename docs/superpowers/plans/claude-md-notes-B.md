# CLAUDE.md notes — Lane B (frontend)

What `CLAUDE.md` must now say because of Lane B's changes. Appended per task; folded into `CLAUDE.md`
in one pass at the end of the consolidation (agents must not edit `CLAUDE.md` mid-flight).

## Task B1 — frontend dead code

- **Icons section.** The paragraph explaining that a webfont-style class name (`las la-cog`,
  `mdi-check`) falls through to `kind: 'none'` and draws nothing should note that the last webfont
  leftover in the tree is gone: `pages/AdminStorage.vue`'s asset-delivery graph built its content-type
  and "missing origin" nodes as `{ icon: 'las', iconText: '&#xf1c5;' }` rendered into a
  `<text class="las">`, which drew as tofu. Those six nodes now carry `/_assets/icons/*.svg` paths
  like the `user` and `pages_wiki` nodes beside them, and the `<text>` branch of the graph's
  `#override-node` template is gone with them. `grep -rn "'las'" frontend/src` is now empty — a new
  `las`/`mdi-`-style name anywhere in `frontend/src` is a regression, not just discouraged.
- **Frontend patterns / `components/shared/`.** The shared library is three components smaller:
  `WRating.vue`, `WTree.vue` and `WTreeNode.vue` were deleted (zero call sites; `WTree.vue`'s own
  header still claimed the page-contents sidebar as its caller, which `PageToc.vue` stopped being).
  Nothing in `CLAUDE.md` names them today, so this is only worth saying if a future edit enumerates
  the library. The lazy id-map tree the app actually uses is `components/TreeNav.vue` /
  `TreeLevel.vue` / `TreeNode.vue`, which are unrelated to the deleted `W*` pair.
- **No SSR build.** `import.meta.env.SSR` no longer appears anywhere in `frontend/src`: there is no
  SSR entry, plugin or script, Vite folds the flag to `false`, and every `global.X = …` /
  `createMemoryHistory()` branch behind it was unreachable. Worth one line under Frontend patterns so
  nobody reintroduces the pattern: `boot/{api,eventbus,externals}.js` assign onto `window`
  unconditionally and `router/index.js` uses `createWebHistory` only.
- **`helpers/accessibility.js` export list.** The Frontend-infra "existing shared utilities" table (if
  one is ever added to `CLAUDE.md`; today it lives in the survey) should list `contrastRatio`,
  `getAccessibleColor`, `WCAG_AA_CONTRAST` — `meetsWcagAA` was deleted, since its only callers were
  two test files. `AdminTheme.vue` compares `contrastRatio(...) < WCAG_AA_CONTRAST` inline and is the
  pattern to follow.

## Task B2 — module-config form, site images, destructive confirm, password badge, guests id, overlay route

- **Frontend patterns.** Six shared surfaces are now the only supported way to do these things, and a
  new call site must reach for them rather than write its own copy:
  - `components/ModuleConfigForm.vue` + `helpers/moduleConfig.js` (`buildConfigEditor`,
    `buildConfigPayload`) render and serialise EVERY module's config. All five pages that edit one —
    `AdminAnalytics`, `AdminAuth`, `AdminComments`, `AdminSearch`, `AdminStorage` — go through them;
    there are no private copies left. The form now draws a `readOnly` prop as a `div` (not a `label`)
    with an orange hint, which used to be `AdminAuth.vue`'s local variant only.
  - `composables/siteImage.js` — `useSiteImage(kind, { siteId, has, i18nPrefix, loading,
    invalidTypeKey })` owns the pick → validate → upload/clear → toast → cache-bust cycle for a site's
    logo, favicon and login background. `helpers/siteImages.js` stays the transport, and now also
    exports `isSharpAvailable()` (returns `true` when the check itself fails, so an unknown answer
    understates the "requires Sharp" warning).
  - **A "delete this" confirmation is `confirm({ destructive: true, persistent: true })`, not a
    bespoke `*DeleteDialog.vue`.** `Group`/`Webhook`/`Asset`/`Folder`DeleteDialog are deleted;
    `Page`/`Site`/`User`DeleteDialog remain because each does more than confirm (navigation refetch,
    a type-the-title guard, content reassignment). A fourth look-alike dialog is the regression.
  - `helpers/passwordStrength.js` — `passwordStrengthBadge(password, t)` is the single score →
    `{ color, label }` mapping, resolving against `common.password.*`. The parallel
    `admin.users.pwdStrength*` key set is deleted from `backend/locales/en.json` (its five
    translations remain in the other locale files until the next Localazy sync prunes them).
  - `helpers/randomPassword.js` exports `PASSWORD_CHARSET` and `PASSWORD_CHARSET_UNAMBIGUOUS`; a
    dialog picks one rather than pasting a literal.
  - `helpers/systemIds.js` exports `GUESTS_GROUP_ID`, mirroring `backend/base.yml`'s
    `systemIds.guestsGroupId`. The literal must not be retyped.
  - `composables/adminOverlayRoute.js` — `useAdminOverlayRoute({ overlay, listPath, onClosed })` is
    the `:id`-in-the-route ↔ `adminStore.overlay` plumbing for an admin list page with an edit
    overlay (`AdminUsers`, `AdminGroups`). It registers its own `onMounted`/`onBeforeUnmount`, so a
    page adopting it drops its `checkOverlay()`, both watchers and its overlay-clearing unmount hook.
- **Behaviour deltas worth one line each** (none is in the design's D1–D10 table, all are inherent to
  the consolidation): the four converted delete confirmations now render in `WConfirmDialog`'s chrome
  (no header bin icon, standard width) and Group/Webhook's "cannot be undone" warning is a bold second
  paragraph rather than red text; the three admin password dialogs now say "Average" (`common.password.
  average`) where they said "Medium"; `AdminGeneral`'s logo and favicon previews carry their own
  cache-busting timestamps instead of one shared `state.assetTimestamp`.

## Task B3 — `useAdminSettings` for the admin settings pages

- **Frontend patterns — an admin settings page's load/save skeleton is
  `composables/adminSettings.js`, not hand-written.** `useAdminSettings({ i18nPrefix, keys,
  siteScoped, overlay, defaults, extraState, fetch, pick, onLoaded, commit, onSaved,
  onSavedCurrentSite })` returns `{ state, load, save, refresh }` and owns: the `state.loading`
  gauge, the full-screen overlay paired inside `load()`, the `<prefix>.loadFailed` /
  `.saveSuccess` / `.saveFailed` / `.refreshSuccess` toasts, the `t(\`<prefix>.${err.data?.error}\`,
  apiErrorMessage(err, t('common.error.unexpected')))` caption on a failed save, the
  `adminStore.currentSiteId` watcher plus its mounted load, and the "am I editing the site I am
  browsing" gate (`adminStore.currentSiteId === siteStore.id`) in front of `onSavedCurrentSite`.
  A page keeps only what is its own: `defaultConfig()`, the requests, the payload mapping, and any
  action beyond loading and saving. `state` is the composable's — page-specific fields go in
  `extraState` so the template keeps reading `state.x`. `save()` answers `true`/`false` so a page
  can do something only on a stored change (`AdminGeneral.vue`'s `loadedHostname`).
  Twenty pages use it: `AdminGeneral`, `AdminTheme`, `AdminLogin`, `AdminEditors`, `AdminAnalytics`,
  `AdminBlocks`, `AdminSearch`, `AdminApprovals`, `AdminGlossary`, `AdminNavigation`,
  `AdminPagesDeleted`, `AdminLocale` (site-scoped), plus `AdminMail`, `AdminSecurity`, `AdminFlags`,
  `AdminSystem`, `AdminApi`, `AdminAuth`, `AdminMetrics`, `AdminPageviews` (`siteScoped: false`).
  `AdminComments` and `AdminStorage` are the two deliberate hold-outs — see the report for why.
- **Drift the composable settles, so a new page copies the settled shape:** a failed `load()`
  always carries `caption: apiErrorMessage(err)`; the overlay is shown and hidden inside `load()`,
  never by the caller's watcher; a site-scoped page never fetches without a `currentSiteId` (the
  guard is in `load()`, so `onMounted`/the watcher need no `if`); the raw
  `'An unexpected error occured.'` fallback is gone from every page this task touched
  (`t('common.error.unexpected')` instead — 14 files carried the literal, now 10); and a failed
  `save()` always captions itself with the page's own message for the server's error code
  (`t(\`<prefix>.${err.data?.error}\`, apiErrorMessage(err, …))`), falling back to the server's
  message where the page has none. That fourth delta is a real behaviour change on
  `AdminAnalytics`, `AdminFlags` and `AdminSecurity`, none of which did that lookup before — a save
  failure there now reads as this page's own wording for that error code where one exists, and is
  unchanged where it does not.
- **One user-visible consequence, not just a wording one:** `overlay` defaults to `true`, so Refresh
  on `AdminBlocks` and `AdminEditors` now raises the full-screen loading overlay, which their
  hand-written `load()` never did. Deliberate — it is what every other settings page already did —
  but it is the one place where adopting the settled shape changed what a reader sees rather than
  only what a failure says.
- **`refresh()` is the composable's**, not a per-page `await load(); notify(refreshSuccess)`
  wrapper: five of the seven copies (`AdminAnalytics`, `AdminAuth`, `AdminMetrics`,
  `AdminPageviews`, `AdminApi`) are now `const { refresh } = useAdminSettings(...)`. The two left
  are `AdminSites` (its refresh re-fetches `adminStore.sites`, there is no `load()`) and
  `ProfileApi` (a profile page, and three independent best-effort fetches).

### Observed but out of scope for B3

- `AdminComments.vue` and `AdminStorage.vue` keep their hand-written skeletons: both give their
  load-failure toast a `timeout: 20000`, `AdminComments.save()` raises the overlay + reloads +
  guards on a selected provider, `AdminStorage.save({ silent })` makes the overlay and the success
  toast conditional, and `AdminStorage`'s site watcher awaits `load()` before rewriting the route.
  Converting either would have meant either changing behaviour or growing three more options onto
  the composable for one caller each.
- The `[aria-label="X"] input` selector defect (B2's note below) is unchanged: the same 7 assertions
  in `AdminAnalytics.test.js` (1), `AdminMail.test.js` (3) and `AdminSearch.test.js` (3) fail before
  and after this task.

### Observed but out of scope for B2

- `pages/AdminGroups.vue`'s `editGroup()` is dead — the row's edit control is a `:to` link, and
  nothing calls the function. It is the page's only remaining `useRouter()` consumer. Pre-existing;
  VIEW-F10's bucket, not B2's.
- Three source-scanner suites fail at base and still do: `i18nSourceGate.test.js` (12 pre-existing
  English literals, `AdminAnalytics.vue`'s `'An unexpected error occured.'` among them — F3/B3
  territory), `AdminAnalytics.test.js` and `AdminSearch.test.js` (four assertions using a
  `[aria-label="X"] input` selector that cannot match, since `WInput` puts `aria-label` ON the
  `<input>`). None was made worse; the `WInput` selector bug is a real, separate test defect.

### Observed but out of scope for B1 (for whoever folds these in)

- `CLAUDE.md`'s "GraphQL was removed" section says `frontend/src/pages/` "now has only
  `AdminPagesDeleted.vue`" of that family and that `AdminPages.vue` was "deleted outright". That is no
  longer true — `pages/AdminPages.vue` exists again (commit `c47b73ed`) and is REST-based. Someone
  should re-check that paragraph against the tree.
- `backend/models/mail.ts`'s header comment still cites `MailTemplateEditorOverlay.vue` and the
  `admin.mail.templates` admin section as the unwired UI for an unbuilt template system. Both are now
  deleted (D6), so that sentence needs trimming — but `backend/` is Lane A's workspace, so B1 left it
  alone.

## B4 (tree loader, API-key surfaces, W* library composables, stores)

### CLAUDE.md must now say

- **"Frontend patterns" / "UI components come from `components/shared/`"**: the library now has one
  *unregistered* member. `components/shared/WFieldFrame.vue` is internal to `WInput` and `WSelect` —
  it draws the shared Material field chrome (label above / notched outline / floated label /
  hint-error line) around whichever control its caller renders, and is deliberately absent from
  `components/shared/index.js`, so there is no `<w-field-frame>` to write in app markup. Its sibling
  is `composables/fieldFrame.js` (`fieldProps` + `useFieldFrame`), which owns the twelve props both
  fields declare, `validate()`, and the frame's computed colours/classes. A third field type uses
  both; nothing else should reach for either.
- **`composables/screen.js` no longer exposes `gt`.** `useScreen()` returns `gte` only (`gte.sm` /
  `.md` / `.lg` / `.xl`); the old `gt.*` shorthand resolved to exactly the same four refs one
  breakpoint along and is gone. `gt.md` is `gte.lg`, and so on.
- **`userStore` has one date-time formatter, not four.** `formatDateTime(t, date, { seconds, zone })`
  — `formatDateTimeWithSeconds`, `formatDateTimeWithZone` and `formatDateTimeSeconds` are deleted.
  `formatDate(date)` (date alone, no `t`) stays.
- **"dirty" and "clean" are editor-store actions, not raw timestamp writes.** `editorStore.markDirty()`
  is what a component calls when the reader changed something (eight call sites used to assign
  `lastChangeTimestamp` by hand); `editorStore.markClean(extra?)` equalizes both timestamps and merges
  `extra` into the same `$patch`; `editorStore.ensureConfigs()` fetches the editor configs unless they
  are already loaded. New editor code should use these rather than touching the two timestamps.

### Notes for whoever writes the section

- New shared frontend utilities worth listing beside `apiError`/`datetime`/`pagePaths`:
  `helpers/treeNodes.js` (`mergeFolderEntries`, `fetchTreeEntries` — the folder tree behind
  `FileManager`, `TreeBrowserDialog` and `LinkPickerDialog`), `helpers/apiKeyState.js` (what a key's
  row says about itself, shared by `AdminApi` and `ProfileApi`), `helpers/markdownFences.js`
  (`linesOutsideFences`), `helpers/pointerDrag.js` (`trackPointerDrag`),
  `composables/apiKeyCreateForm.js`, `composables/anchoredFloat.js` (`useAnchoredFloat`, over the
  existing `anchoredPosition`), `composables/toggleModel.js`, `components/shared/metrics.js`
  (`NAMED_SIZES`/`resolveSize`/`CELL_ALIGN`), and `helpers/injectCss.js`'s new `replaceHeadStyle`
  plus `helpers/datetime.js`'s new `isPast(iso)`.
- **`wComponentAttributeDrift.test.js`'s parser now follows a `...spread` in `defineProps`**, resolving
  it against the prop objects exported from `composables/fieldFrame.js`. A future shared prop object
  that a `W*` component spreads has to live there too, or its props will read as undeclared at every
  call site.

### Observed but out of scope for B4

- Pre-existing red in `frontend/`, unchanged by B4 and confirmed by an old-vs-new probe of `WInput`:
  `AdminMail.test.js` (3), `AdminAnalytics.test.js` (1) and `AdminSearch.test.js` (3) all fail on the
  `[aria-label="X"] input` selector B1 already flagged above — the label is on the `<input>` itself,
  so no ancestor carries it; `pageTitles.test.js` (2) and `pageTitleHeadings.test.js` (1) fail on
  `pages/AdminPages.vue`, which is also the source of four of the seven standing
  `wComponentAttributeDrift` violations; and `stores/flags.test.js` (1) fails on `i18n.global` being
  undefined under test. None is in B4's file list.
- `components/shared/WDate.test.js`'s `toLocaleString(undefined` source-scan guard WAS failing at base
  (it expected `stores/user.js:29`; the one legitimate site had moved to `formatTimePart`, and
  `stores/user.test.js` had grown two deliberate uses). B4 fixed it, since it scans files B4 rewrites:
  it now asserts by file rather than `file:line` and skips `*.test.js`.

## B6 — the shared frontend test harness

### CLAUDE.md must now say (Testing (frontend))

- **A suite does not build its own i18n, router, pinia or mount.** `frontend/test/` is now a real
  harness, not just `setup.js` + `mocks.js`:
  - `test/i18n.js` — `createTestI18n(messages)` (nests under `en`, takes flat-dotted or nested keys,
    `missingWarn`/`fallbackWarn` off). Replaces the hand-written `createI18n({ legacy: false, locale:
    'en', … })` call sites.
  - `test/router.js` — `await createTestRouter(routes, initialPath)` (bare strings become stub routes,
    route objects pass through; does the `push` + `isReady()` coda ~90 sites wrote by hand) and
    `buildTestRouter(routes)` for the synchronous case.
  - `test/mount.js` — `mountWithApp(Component, { props, messages, routes|router, initialPath, stores,
    stubs, components, attachTo, …mountOptions })` → `{ wrapper, router, i18n, siteStore, userStore,
    pageStore, adminStore, editorStore, flagsStore }`. Fresh pinia per call, `stubs: { teleport: true }`
    by default. Replaces the per-file `mountDialog`/`mountPage`/`mountOverlay`/`mountEditor` helpers.
  - `test/fixtures.js` — `seedSite/seedUser/seedPage/seedAdmin(overrides)` and `stubRouter(overrides)`
    (carries both `push` and `replace`).
  - `test/mocks.js` — `stubApi(routes, { method, fallback })`, a URL→payload table (plain object for
    exact keys, a `Map` when a route needs a `RegExp`; a function value is called per request) that
    returns `{ calls }`. Replaces the hand-rolled `API_CLIENT.get.mockImplementation((url) => …)`
    switches.
  - `test/sourceFiles.js` — `listSourceFiles(root, { ext, skip })`, the one recursive walker for the
    source-scanning suites (seven copies before).
- **Store seeding stays opt-in at the mount call.** `test/setup.js` still seeds nothing, and
  `mountWithApp` writes to a store only when `stores` names it — several suites (`ProfileInfo.test.js`
  among them) assert against an untouched store.
- **`vitest.config.js`'s `include` now also covers `test/**/*.test.js`** — the harness has its own
  co-located coverage, so a break in it fails as its own named test rather than as a hundred unrelated
  component failures.
- **`test/setup.js` registers `BlueprintIcon`, `LoadingGeneric` and `StatusLight` globally**, from the
  same imports `boot/components.js` uses, alongside the `w-*` library. A suite must not re-register or
  stub them: 12 files used to register `BlueprintIcon` by hand and 7 replaced it with
  `stubs: { BlueprintIcon: true }`, so the same component rendered two different ways depending on the
  file. Consequence: a `.w-item-section` index inside a list row now counts the icon's own avatar
  section first (`AdminGlossary.test.js` is the one assertion that had to shift).
- **`WInput` puts `aria-label` on the `<input>` itself**, so a test selects it as
  `input[aria-label="X"]`, never `[aria-label="X"] input`. The seven assertions using the ancestor form
  (`AdminAnalytics` 1, `AdminMail` 3, `AdminSearch` 3, flagged as pre-existing red by B1–B4) are fixed.
- **`stubs` defaults to `{ teleport: true }`, and a suite that asserts against `document.body` opts
  out with `stubs: {}`.** `w-dialog`/`w-menu`/`WTooltip` really teleport their body out of the
  wrapper, so the seven suites that look for it there (`ApiKeyCreateDialog`,
  `ProfileApiKeyCreateDialog`, `ImportPageDialog`, `TreeBrowserDialog`, `WebhookHistoryDialog`,
  `InboxWatching`, `AdminTheme`) each carry that opt-out with a one-line reason.
- **A test-only sibling module is a plain `.js`, never a `*.test.js`.** `pages/graphFixtures.js`,
  `components/editorMarkdownHarness.js` and `components/pageActionsHarness.js` join
  `frontend/test/`'s helpers as the accepted shape for per-component shared fixtures:
  `vitest.config.js` collects only `*.test.js`, so these are imported and never run as a suite. A
  `vi.mock(...)` call must still live in each test file (it is hoisted per file) — the harness
  exports the factory (`monacoMock()`) it is handed.
- **The suites split by concern**, so a filename now names what it covers: `stores/page.{save,load,
  lifecycle,derived}`, `pages/Graph.{rendering,sizing,tooltip,i18n,layout,fallback}`,
  `components/EditorMarkdown.{content,preview,resize,assets,lifecycle}`, `pages/Index.{view,blocks,
  routing,missingPage}`, `App.{theme,locale,prefetch,navGuard,logout,beforeunload}`,
  `components/PageActionsCol.{buttons,export,assets,menu}`,
  `components/HeaderSearch.{entry,preview,suggest}`. No `frontend/src` test file is over ~530 lines.
- **A cross-component assertion is a `describe.each`, not a copy.**
  `components/editorMarkupShared.test.js` (EditorAsciidoc ≡ EditorCode) and
  `components/apiKeyScopeTree.test.js` (the two key-create dialogs) hold what is byte-identical
  between two components; what genuinely differs stays in each component's own suite.
- **One `docsBase` gate, not seven.** `src/docsBaseGate.test.js` lists the fork-invented surfaces that
  must carry no `docsBase` help button and checks each with `describe.each`, plus an existence check
  so a rename cannot retire a guard silently. `pages/{AdminFlags,AdminApprovals,AdminTerminal}.test.js`
  held nothing else and are gone.

### Follow-ups this task surfaced but did not close

- **The frontend's `.oxlintrc.json` sets `no-unused-vars: "off"`, so nothing in CI catches a dead
  import.** That is what let B6's own suite splits ship ~130 unused imports and 5 dead helpers past a
  green `oxlint --deny-warnings` (found in review, fixed in a follow-up commit). The backend's config
  leaves the rule on and catches exactly this. Worth turning on for `frontend/` — at minimum
  `"no-unused-vars": ["error", { "args": "none", "varsIgnorePattern": "^_" }]` — and fixing whatever
  it turns up in one pass; until then a reviewer has to spot dead imports by eye. (The `import` plugin
  is separately off for a documented reason — the Vite `?worker` specifiers in `boot/monaco.js` — but
  `no-unused-vars` is an `eslint`-plugin rule and is unaffected by that.)
- **The two `admin.storage.destroyConfirm` / `destroyConfirmInfo` keys were deleted from
  `backend/locales/en.json` only.** Their translations still exist in the other locale files, which
  are Localazy-managed output — the next sync prunes them. Same situation B2 recorded for the
  `admin.users.pwdStrength*` set; no manual edit to the translated files is wanted.
- **`frontend/src/assets/{emoji,icons}.generated.js` are deliberately unformatted and must stay that
  way.** Both are in `.oxfmtrc.json`'s `ignorePatterns`, and both are byte-compared against their
  generator's own output by `npm run icons:check` / `emoji:check` (a `quality.yml` step) — running
  `oxfmt` on either would change the bytes and turn that gate red while fixing nothing.
