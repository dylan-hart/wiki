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
  guard is in `load()`, so `onMounted`/the watcher need no `if`); and the raw
  `'An unexpected error occured.'` fallback is gone from every page this task touched
  (`t('common.error.unexpected')` instead — 14 files carried the literal, now 10).
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
