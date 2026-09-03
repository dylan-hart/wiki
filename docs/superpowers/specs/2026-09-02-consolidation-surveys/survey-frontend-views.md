# Frontend views survey (`frontend/src/pages/`, `components/` minus `shared/`, `layouts/`, `App.vue`)

All paths below are relative to the worktree root
`/Users/dylangles/git/dylan.hart/requarks-wiki-fork/.claude/worktrees/consolidation/`.

## Summary

- 167 SFCs, 64,494 lines. **Zero `lang="pug"` templates and zero Options-API components remain** — every file is `<script setup>`, so the "pug / Options-API mix" concern in the brief is already resolved.
- No component has zero importers (scripted grep over every filename, quoted-import form), and every `pages/*.vue` is in `router/routes.js`. Dead code here is *reachable-but-hollow*: two stub pages/overlays and four no-op functions (F8–F10, ~370 lines).
- The biggest verified copy-paste is the **module-config editor**: `helpers/moduleConfig.js` + `ModuleConfigForm.vue` were extracted for Storage/Search, but `AdminAnalytics`, `AdminAuth` and `AdminComments` still carry byte-identical private copies of both the template block and the three helper functions (F1, ~−230).
- The 16 `Admin*.vue` settings pages share an identical load/save/watch/onMounted skeleton (F3); a `useAdminSettings()` composable removes ~250 lines and the per-page divergence in error handling (some `load()`s have no `caption`, two `save()`s still fall back to a raw English string).
- Seven `*DeleteDialog.vue` files are the same 100-line confirmation; `WConfirmDialog`'s `destructive` prop was written for exactly this and is unused by them (F4, −330).
- Six near-identical site-image upload/clear functions (F2), four password-strength badge computeds against two parallel i18n key sets (F5), three folder-tree loaders (F7), and the duplicated admin-overlay route plumbing (F12).
- Long files: `EditorMarkdown.vue` (2509, one 388-line `onMounted`), `FileManager.vue` (2085), `Index.vue` (1431, one 263-line route watcher), `GroupEditOverlay.vue` (1344) and `AuthLoginPanel.vue` (1175, eight screens in one template) are the ones where a responsibility-based split is clear (F13).
- Test coverage is strong: 125 of 167 components/pages have a co-located `*.test.js`; the 42 without are listed at the end. Every file named in F1–F3 and F13 has a test.

## Existing shared utilities worth knowing (this area's code should reuse, not re-create)

| Utility | What it does | Currently bypassed by |
| --- | --- | --- |
| `helpers/moduleConfig.js` — `buildConfigEditor()`, `buildConfigPayload()` | ModuleProp map → editable config; config → API payload (skips readOnly) | AdminAnalytics, AdminAuth, AdminComments (private copies) |
| `components/ModuleConfigForm.vue` | Renders one field per module prop (boolean/enum/enumDisplay=buttons/sensitive/readOnly/`if`) | AdminAnalytics, AdminAuth, AdminComments (inline template copies) |
| `composables/dialog.js` — `confirm({ destructive: true, message: '**bold**', caption })` | Generic confirm; `destructive` = negative colour + Delete label + forced cancel | the 7 `*DeleteDialog.vue` |
| `composables/dialog.js` — `useDialogComponent({ autofocus })` | Dialog lifecycle; used by 55 of 57 dialogs | (good) |
| `composables/notify.js`, `composables/loading.js` | Toast queue; full-screen loading with 500 ms delay | (good) |
| `helpers/apiError.js` — `apiErrorMessage(err, fallback)` | Reads ky error body | AdminAuth.vue:717 / AdminWebhooks.vue:205 / ApiKeyCreateDialog.vue:303,320 still use raw `err.message` |
| `helpers/siteImages.js` — `pickSiteImage/isAcceptedSiteImage/uploadSiteImage/clearSiteImage` | Site logo/favicon/loginBg transport | fine; the *orchestration* around it is what is duplicated (F2) |
| `helpers/passwordStrength.js` — `passwordStrengthScore()` | zxcvbn score 0–4 | the score→{color,label} mapping is copied 4× (F5) |
| `helpers/randomPassword.js` | random string from a charset | charset literal copied 3× (F5) |
| `composables/siteAdminAccess.js` — `useSiteAdminAccess(perm)` | site-scoped page gate | used by 9 pages (good) |
| `helpers/datetime.js` — `humanizeDate/relativeDate` | | (good) |
| `stores/user.js` guests id `'10000000-0000-4000-8000-000000000001'` | | literal repeated in 5 components (F6) |

## Findings

### F1. Module-config editor copied into three admin pages — utility extraction | net LOC −230 | risk low | effort S

- Locations (all three are byte-identical to each other; compare against the shared originals):
  - `helpers/moduleConfig.js:12-27` (`buildConfigEditor`) ≡ `pages/AdminAnalytics.vue:228-243` ≡ `pages/AdminAuth.vue:662-677` ≡ `pages/AdminComments.vue:468-483`
  - `components/ModuleConfigForm.vue:98-106` (`inputTypeFor`) ≡ `AdminAnalytics.vue:245-253` ≡ `AdminAuth.vue:679-687` ≡ `AdminComments.vue:485-493`
  - `ModuleConfigForm.vue:108-113` (`ifCheck`) ≡ `AdminAnalytics.vue:255-260`, `AdminAuth.vue:733-738`, `AdminComments.vue:495-500` (each closes over its own selected object instead of the prop — same logic), plus **`pages/AdminStorage.vue:1013-1018` `configIfCheck` which is defined and never referenced** (Storage already renders through `ModuleConfigForm`; grep for `configIfCheck` in that file hits only the definition).
  - `helpers/moduleConfig.js:39-48` (`buildConfigPayload`) ≡ the config loop inside `AdminAuth.vue:744-751` (`payloadFor`) and `AdminAnalytics.vue:312-315` (`save`, minus the readOnly skip), and `AdminComments.vue:539` (`payloadFor`).
  - Template block: `ModuleConfigForm.vue:2-57` ≡ `AdminAnalytics.vue:101-141`, `AdminComments.vue:156-198`, `AdminAuth.vue:338-~400`.
- What differs: `AdminAnalytics`'s template omits the `readOnly`/`enumDisplay=buttons`/`autocomplete` branches (a strict subset — the shared form's extra branches are no-ops when the prop lacks those flags). `AdminAuth`'s template has two extras the shared form lacks: `:tag="cfg.readOnly ? 'div' : 'label'"` and a `text-orange` caption class on readOnly rows (`AdminAuth.vue:344,356`). `AdminAnalytics.save()` does not skip `readOnly` props (analytics modules declare none, so behaviour is identical).
- Proposed target shape: import `buildConfigEditor`/`buildConfigPayload` and mount `<module-config-form :config="provider.config" />` in all three pages; add an optional `read-only-hint` (or just adopt the `text-orange` caption + `div` tag unconditionally) to `ModuleConfigForm.vue` so Auth loses nothing. Delete `AdminStorage.vue:1013-1018`.
- Test coverage: `helpers/moduleConfig.test.js` (66 lines), `components/ModuleConfigForm.test.js` (114), `pages/AdminAnalytics.test.js`, `AdminAuth.test.js`, `AdminComments.test.js`, `AdminStorage.test.js` all exist.

### F2. Site-image upload/clear orchestration ×6 and `checkSharpAvailability` ×2 — utility extraction | net LOC −120 | risk low | effort S

- Locations: `pages/AdminGeneral.vue:837-867` (`uploadLogo`), `869-887` (`clearLogo`), `889-919` (`uploadFavicon`), `921-939` (`clearFavicon`); `pages/AdminLogin.vue:410-440` (`uploadBg`), `442-460` (`clearBg`). `checkSharpAvailability`: `AdminGeneral.vue:734-742` ≡ `AdminLogin.vue:395-403` (identical).
- What's duplicated: each upload is the same 30 lines — `pickSiteImage()` → `isAcceptedSiteImage()` guard with an invalid-type toast → `state.loading++` → `uploadSiteImage(siteId, kind, file)` → success toast → `state.hasX = true` + `assetTimestamp` bump → error toast → `state.loading--`. Only `kind`, the `hasX` flag and four i18n keys vary. Clear is the same shape minus the picker.
- Proposed target shape: `composables/siteImage.js` — `useSiteImage(kind, { has: ref, i18nPrefix, loading })` returning `{ upload, clear, timestamp }`; `AdminGeneral` instantiates it twice, `AdminLogin` once. Move `checkSharpAvailability` into `helpers/siteImages.js` as `isSharpAvailable()` (one fetch, returns boolean).
- Test coverage: `AdminGeneral.test.js`, `AdminLogin.test.js` exist; no test for `helpers/siteImages.js`.

### F3. Admin settings-page skeleton — utility extraction (`useAdminSettings()`) | net LOC −250 | risk med | effort M

- Locations (the identical scaffold): watcher `watch(() => adminStore.currentSiteId, () => load())` at `AdminGeneral.vue:692-697`, `AdminTheme.vue:720-725`, `AdminLogin.vue:319-324`, `AdminLocale.vue:226-231`, `AdminEditors.vue:190-196`, `AdminAnalytics.vue:215-220`, `AdminBlocks.vue:353`, `AdminComments.vue:419`, `AdminSearch.vue:226`, `AdminStorage.vue:914-921`, `AdminApprovals`, `AdminGlossary`, `AdminNavigation`, `AdminPagesDeleted` (14 files); mounted guard `onMounted(() => { if (adminStore.currentSiteId) load() })` at `AdminGeneral.vue:943-948`, `AdminTheme.vue:854-858`, `AdminLogin.vue:464-469`, `AdminLocale.vue:386-390`, `AdminEditors.vue:284-289`, `AdminAnalytics.vue:342-346`, `AdminBlocks.vue:594`, `AdminSearch.vue:410`; `load()` wrapper `state.loading++; loading.show(); try { GET sites/:id?strict=true …} catch { notify negative } loading.hide(); state.loading--` at `AdminGeneral.vue:701-727`, `AdminTheme.vue:784-801`, `AdminLogin.vue:328-350`, `AdminLocale.vue:264-290`, `AdminEditors.vue:200-217`, `AdminAnalytics.vue:262-297`; `save()` wrapper `state.loading++; try { PUT sites/:id {json} ; notify positive } catch { notify negative, caption: t(\`admin.X.${err.data?.error}\`, apiErrorMessage(err, …)) } state.loading--` at `AdminGeneral.vue:754-835`, `AdminTheme.vue:803-850`, `AdminLogin.vue:352-388`, `AdminLocale.vue:292-333`, `AdminEditors.vue:219-258`, `AdminAnalytics.vue:307-338`, `AdminMail.vue:444-484`, `AdminSecurity.vue:715-750`, `AdminFlags.vue:192-217`; post-save "am I editing the site I'm browsing" sync at `AdminGeneral.vue:812-822`, `AdminLocale.vue:320-322` (`siteStore.loadSite(window.location.hostname)`), `AdminTheme.vue:829-834`, `AdminEditors.vue:233-242` (`siteStore.$patch`).
- What differs (and is worth normalising, because the differences are drift, not design): `AdminTheme.load()` and `AdminEditors.load()` omit the `caption: apiErrorMessage(err)` the others carry; `AdminEditors` calls `loading.show()` in the watcher/mount and `hide()` inside `load()` while everyone else pairs them inside `load()`; `AdminLocale.save()` and `AdminMail.save()` still fall back to the literal `'An unexpected error occured.'` (`AdminLocale.vue:328`, `AdminMail.vue:479`; 11 such literals remain across the area even after `i18nUnexpectedErrorLiteral.test.js` — that test allows them because the grep it runs only covers the default-slot idiom it was written for); `AdminLocale.save()`/`AdminMail.save()` guard on `state.loading > 0`, the rest don't. `refresh()` = `await load(); notify(refreshSuccess)` is repeated verbatim in `AdminAnalytics.vue:299`, `AdminAuth.vue:725`, `AdminMetrics.vue:155`, `AdminPageviews.vue:199`, `AdminApi.vue:356`, `AdminSites.vue:174`, `ProfileApi.vue:255` (and as a bare `await load()` in `AdminEditors.vue:260`, `AdminBlocks.vue:521`).
- Proposed target shape: `composables/adminSettings.js`:
  ```js
  const { state, load, save, refresh } = useAdminSettings({
    i18nPrefix: 'admin.general',      // loadFailed / saveSuccess / saveFailed / refreshSuccess
    siteScoped: true,                 // wires the currentSiteId watcher + mounted guard
    defaults: defaultConfig,          // toMerged(defaults(), fetched)
    fetch: async (siteId) => (await API_CLIENT.get(`sites/${siteId}?strict=true`).json()),
    pick: (site) => site.theme,       // optional sub-object
    commit: (siteId, config) => API_CLIENT.put(`sites/${siteId}`, { json: { theme: … } }),
    onSavedCurrentSite: (config) => { siteStore.$patch({ theme }); EVENT_BUS.emit('applyTheme') }
  })
  ```
  Pages keep their `defaultConfig()`, payload mapping and any extra actions; the composable owns `state.loading`, the loading overlay pairing, the three toasts, the `err.data?.error` translation fallback and the site-switch watcher. Non-site pages (`AdminMail`, `AdminSecurity`, `AdminFlags`, `AdminSystem`) pass `siteScoped: false`.
- Test coverage: every page named has a co-located `Admin*.test.js`; several of them assert the toast/`loading` behaviour directly (`AdminGeneral.test.js`, `AdminLogin.test.js`), so the composable can be introduced page-by-page with the existing tests as the regression net.

### F4. Seven `*DeleteDialog.vue` are one confirmation dialog — utility extraction | net LOC −330 | risk low | effort S

- Locations: `components/GroupDeleteDialog.vue` (91), `WebhookDeleteDialog.vue` (100), `AssetDeleteDialog.vue` (110), `FolderDeleteDialog.vue` (109), `PageDeleteDialog.vue` (123), `SiteDeleteDialog.vue` (126), `UserDeleteDialog.vue` (158). Template lines 1-43 of Group/Webhook/Asset/Folder/Page are identical apart from `max-width`, the i18n key and the slot name; scripts are identical apart from the endpoint and success key (e.g. `WebhookDeleteDialog.vue:82-99` vs `AssetDeleteDialog.vue:92-109` vs `FolderDeleteDialog.vue:91-108`).
- What differs: `SiteDeleteDialog` adds a type-the-title guard (`:96`) and patches `adminStore.sites` (`:111`); `UserDeleteDialog` adds content reassignment (`:110-136`); `PageDeleteDialog` force-refetches navigation after delete (`:112`). `GroupDeleteDialog` alone has no `isLoading` flag on the button.
- Proposed target shape: delete Group/Webhook/Asset/Folder dialogs and call `confirm({ title, message: t(key, { name: `**${name}**` }), caption, destructive: true, persistent: true }).onOk(async () => { await API_CLIENT.delete(...); notify(...); reload() })` at the 4 call sites (`pages/AdminGroups.vue:273-282`, `pages/AdminWebhooks.vue:271-280`, `components/FileManager.vue:1104-1128` `delFolder`, `:1297-1310` `delAsset`). `WConfirmDialog.vue:132-140`'s `destructive` prop comment literally describes this ("the combination every 'delete this' dialog in the app otherwise has to spell out"). `PageDeleteDialog` can follow the same route (its navigation refetch moves into the two callers' `onOk`, `PageActionsCol.vue:615` and `FileManager.vue:1255`) or stay; Site and User stay bespoke.
- Test coverage: `PageDeleteDialog.test.js`, `SiteDeleteDialog.test.js`, `UserDeleteDialog.test.js` exist; Group/Webhook/Asset/Folder have none (so nothing to port). `AdminGroups.vue` has no test; `AdminWebhooks.test.js` and `FileManager.test.js` exist.

### F5. Password-strength badge ×4 + random-password charset ×3 + two parallel i18n key sets — utility extraction | net LOC −110 | risk low | effort S

- Locations: `passwordStrength` computed — `components/UserCreateDialog.vue:226-260`, `ChangePwdDialog.vue:144-179`, `UserChangePwdDialog.vue:125-160`, `AuthLoginPanel.vue:538-573`. All four are the same `length < 8 → weak; switch(score) 1..4` block. `randomizePassword`: `ChangePwdDialog.vue:195-200` ≡ `UserChangePwdDialog.vue:171-174` (same charset literal); `UserCreateDialog.vue:305` uses a different charset (no symbols, no `l`/`I`/`o` — the comment there says why).
- What's wrong beyond duplication: the same five labels exist twice in `backend/locales/en.json` — `admin.users.pwdStrengthWeak/Poor/Medium/Good/Strong` (`:1488`) used by three dialogs, and `common.password.weak/poor/average/good/strong` (`:2284-2288`) used by `AuthLoginPanel`.
- Proposed target shape: `helpers/passwordStrength.js` gains `passwordStrengthBadge(password, t)` returning `{ color, label }` against `common.password.*`; the three dialogs switch to it (drop the `admin.users.pwdStrength*` keys after Localazy sync). Move the two charsets into `helpers/randomPassword.js` as named exports (`PASSWORD_CHARSET`, `PASSWORD_CHARSET_UNAMBIGUOUS`) so the deliberate difference is visible in one place.
- Test coverage: `helpers/passwordStrength.test.js`, `helpers/randomPassword.test.js`, `UserCreateDialog.test.js`, `AuthLoginPanel.test.js` exist; `ChangePwdDialog`/`UserChangePwdDialog` have none.

### F6. Guests group id literal repeated — utility extraction | net LOC −6 | risk low | effort S

- Locations: `components/ApiKeyCreateDialog.vue:244`, `pages/AdminAuth.vue:571` (both `const GUESTS_GROUP_ID = '10000000-…0001'`), `components/UserCreateDialog.vue:292`, `components/UserEditOverlay.vue:821`, `components/GroupEditOverlay.vue:849` (inline literal), `stores/user.js:117,211`.
- Proposed target shape: `helpers/systemIds.js` exporting `GUESTS_GROUP_ID` (mirrors `backend/base.yml`'s `systemIds.guestsGroupId`); seven call sites import it. Cheap, and it removes the one class of typo that silently un-filters the guests group.
- Test coverage: `stores/user.test.js`, `ApiKeyCreateDialog.test.js`, `UserCreateDialog.test.js`, `UserEditOverlay.test.js`, `GroupEditOverlay.test.js`, `AdminAuth.test.js`.

### F7. Folder-tree loader ×3 — utility extraction | net LOC −70 | risk med | effort M

- Locations: `components/FileManager.vue:900-1025` (`loadTree`), `components/TreeBrowserDialog.vue:428-~545`, `components/LinkPickerDialog.vue:263-345`; `treeLazyLoad` at `FileManager.vue:895`, `TreeBrowserDialog.vue:416`, `LinkPickerDialog.vue:332`.
- What's identical: the folder-node merge — `FileManager.vue:928-958` is byte-for-byte `TreeBrowserDialog.vue:456-486` (create/refresh `state.treeNodes[id]`, resolve the parent by splitting `folderPath` and searching the same response, push into `children`, collect roots). `LinkPickerDialog.vue:285-303` is the same algorithm rewritten with a `findFolderIdByPath` helper. The `GET sites/:id/tree` request with `parentId/parentPath/types/locale/includeAncestors/includeRootFolders` is the same in all three.
- What differs: what each pushes into its *list* (FileManager: folders+assets+pages with sizes/dates; TreeBrowser: folders+pages; LinkPicker: sorted folders+pages with icons), the locale source (`state.locale` / `props.locale` / `pageStore.locale`), and the `isFetching` guard placement.
- Proposed target shape: `helpers/treeNodes.js` — `mergeFolderEntries(treeNodes, entries, parentId) → { roots }` (pure, testable) and `fetchTreeEntries(siteId, { parentId, parentPath, types, locale, initLoad })`; each component keeps its own list projection.
- Test coverage: `FileManager.test.js`, `TreeBrowserDialog.test.js` exist; `LinkPickerDialog` has none. A pure `treeNodes.test.js` would cover the shared part directly.

### F8. `MailTemplateEditorOverlay.vue` is unreachable scaffolding importing an uninstalled package — dead code | net LOC −225 | risk low | effort S

- Locations: `components/MailTemplateEditorOverlay.vue` (177 lines; its own header comment at `:2-8` says the feature was never built). It imports `@vue/repl` (`:76-78`) — `grep "vue/repl" frontend/package.json` → no match, `ls frontend/node_modules/@vue/repl` → does not exist. It is never registered: `layouts/AdminLayout.vue:531` has the `overlays` entry commented out and `ADMIN_OVERLAY_TITLES` (`:600-604`) has no entry, so `pages/AdminMail.vue:486-491` `editTemplate()` sets `adminStore.overlay = 'MailTemplateEditorOverlay'`, which resolves to `<component :is="undefined">` and renders an empty full-screen dialog. Reachable only behind `flagStore.experimental` (`AdminMail.vue:293`).
- Proposed target shape: delete the file, the commented line in `AdminLayout.vue:531`, the experimental "templates" card `AdminMail.vue:289-330`, `editTemplate()`, and the `admin.mail.templateEditor`/template-card i18n keys. If mail-template editing is ever built it will not start from a `@vue/repl` playground.
- Test coverage: `AdminMail.test.js`, `AdminLayout.test.js` exist (neither exercises the overlay).

### F9. `AdminRendering.vue` is a stub page — dead code | net LOC −135 | risk low | effort S

- Locations: `pages/AdminRendering.vue` (124 lines) — `load()` and `save()` are empty (`:120-122`), `state.renderers` is a hard-coded fake entry (`:105-113`), the right-hand panel is an empty grid (`:72`). Routed at `router/routes.js:105`; linked from `layouts/AdminLayout.vue:383-389` behind `flagsStore.experimental`. No test file.
- Proposed target shape: delete page, route, nav item and `admin.rendering.*` keys. The backend has no renderer-module admin API for it to ever call (`backend/api/` has no `rendering` route file).

### F10. No-op handlers and commented-out template leftovers — dead code | net LOC −45 | risk low | effort S

- `components/UserEditOverlay.vue:1034` `async function deleteUser() {}` — wired to a **live** button (`:680-687`, gated only on `canManage`), so clicking "Delete user → Proceed" does nothing. `:1012` `sendWelcomeEmail() {}` — its button is `disabled` (`:608`) with an "unavailable" caption, so the stub is pure dead weight. Proposal: drop `sendWelcomeEmail` + its button/card row; for `deleteUser`, either remove the card or open the existing `UserDeleteDialog` (the latter is a one-line behaviour fix, flagged for the owner to decide — out of this pass's "same functionality" remit).
- `components/EditorWysiwyg.vue:980-985` `insertTable() {}` / `snapshot() {}` — both bodies are commented-out Quill-era code; the toolbar's table action already runs the TipTap chain inline (`:580`), and `snapshot` is referenced only from a commented-out `@click` (`:70`).
- Commented-out pug-era template blocks: `pages/AdminStorage.vue:675-~705` (19 lines of `<!-- .overline… -->`/`<!-- v-radio(… -->`), `pages/Search.vue` (4), `components/EditorWysiwyg.vue` (3), `components/GroupEditOverlay.vue` (2), `components/UserSearchDialog.vue` (1). Grep: `^\s*<!-- (\.|v-|q-)[a-z-]+[.( ]`.
- Also in this bucket: `pages/AdminStorage.vue:1235-1253,1269,1391` build delivery-graph nodes with `icon: 'las', iconText: '&#xf1c5;'` rendered as `<text class="las">` (`:662-669`). No Line Awesome webfont is loaded anywhere (`grep -rn "line-awesome" frontend/package.json frontend/src/css frontend/index.html` → nothing), so those glyphs draw as blank/tofu — the exact webfont-class leftover `CLAUDE.md`'s Icons section says never worked. Replace with the `img:` SVG path form the same function already uses for `user`/`pages_wiki`, or drop `iconText`.

### F11. Admin vs profile API-key surfaces — utility extraction | net LOC −150 | risk med | effort M

- Locations: `components/ApiKeyCreateDialog.vue` (389) vs `components/ProfileApiKeyCreateDialog.vue` (318): identical `expirations` (`:246-252` / `:199-205`), `siteOptions` (`:266-268` / `:215-217`), `allowedClassifications` (`:276-280` / `:225-229`), `keyNameValidation` (`:284-287` / `:233-236`), `loadSites` (`:310-325` / `:240-255`, profile swallows errors), `create()` + copy-dialog hand-off (`:327-367` / `:257-299`), `onMounted` (`:371-388` / `:303-317`). `pages/AdminApi.vue:241-316` vs `pages/ProfileApi.vue:161-217`: `isExpired`, `keyState`, `stateHint`, `isUsable`, `siteName`, `classificationLevelName(s)` duplicated (Admin adds `groupNames`, `ownerName`).
- What differs: the admin dialog has a groups picker + `loadGroups`; endpoints (`api-keys` vs `users/profile/api-keys`); i18n prefix (`admin.api` vs `profile.api`, passed to `ApiKeyCopyDialog` as `labelPrefix` already); the profile dialog's 2-column grid and a smaller checkbox floor (documented at `:102-111`).
- Proposed target shape: `helpers/apiKeyState.js` for the six pure key-state functions (both pages import); `composables/apiKeyCreateForm.js` owning `state`, `expirations`, `siteOptions`, `allowedClassifications`, `loadSites`, the classification bootstrap and `create({ endpoint, extraJson })`, leaving each dialog with its template and the groups delta. Merging the two SFCs into one with a `mode` prop is possible but the real-layout tests pin distinct grid widths per dialog, so the composable is the lower-risk cut.
- Test coverage: both dialogs (`ApiKeyCreateDialog.test.js`, `ProfileApiKeyCreateDialog.test.js`, incl. headless-Chromium grid tests), `AdminApi.test.js`, `ProfileApi.test.js`, `helpers/apiKeyScopes.test.js`.

### F12. Admin list-page overlay/route plumbing — utility extraction | net LOC −50 | risk low | effort S

- Locations: `pages/AdminUsers.vue` — overlay-closed watcher `:269-277`, route-param watcher `:279`, `checkOverlay()` `:336-347`, `onBeforeUnmount` `:375-379`; `pages/AdminGroups.vue` — `:218-226`, `:228`, `:248-259`, `:293-297`. Identical modulo overlay name (`UserEditOverlay`/`GroupEditOverlay`) and list route (`/_admin/users`/`/_admin/groups`).
- Proposed target shape: `composables/adminOverlayRoute.js` — `useAdminOverlayRoute({ overlay: 'UserEditOverlay', listPath: '/_admin/users', onClosed: load })`. The remaining list-page shape (search debounce → page reset → `load({ page })`, `AdminUsers.vue:289-308`) exists only in `AdminUsers` (Groups/Sites/Webhooks lists aren't paginated; `AdminPages.vue:446-503` and `AdminComments.vue:587-618` paginate by offset with their own filter objects), so a generic "list page" composable would be speculative — reject beyond the overlay plumbing.
- Test coverage: `AdminUsers.test.js` exists; `AdminGroups.vue` has no test.

### F13. Long-file splits by responsibility — long-file splitting | net LOC ≈ 0 (moves) | risk med | effort M–L each

Ordered by how cleanly the seam already exists in the file:

1. **`pages/Index.vue` (1431)** — the `route.path` watcher `:682-945` is a single 263-line callback with three independent branches: `/_create` (`:692-721`), `/_edit` (`:724-756`), plain load (`:763-942`). Extract `pages/index/pageRouting.js` with `enterCreateMode(route)`, `enterEditMode(route)`, `loadPageForRoute(route, generation)`; move the not-yet-defined-block scan `:828-873` to `helpers/blockScan.js` (`collectBlocksToLoad(root, blocksIndex)` — pure over a DOM subtree, mirrors but is not identical to `EditorMarkdown.vue:1420-1459`'s author-side version).
2. **`components/EditorMarkdown.vue` (2509)** — `onMounted` `:1767-2154` is 388 lines (Monaco boot + lens providers + collab binding + paste/drop listeners). Seams already labelled by comments: toolbar insert commands `:669-1236` → `helpers/markdownInsert.js` (pure functions over `(editor, monaco)`); preview divider drag `:1237-1346` → `composables/previewResize.js` (owns `isDragging`, the five `drag*` lets, `persistPreviewWidth`); the content pipeline `:1487-1765` stays; the collab half of `onMounted` (`swap to collab editor`, the two stopped watchers `:490-491`) → `composables/markdownCollab.js`, matching `EditorWysiwyg.vue:860` `swapToCollabEditor` which already isolates the same step. `EditorMarkdown.deadcode.test.js` guards source text and would need its path updated if lines move files.
3. **`components/FileManager.vue` (2085)** — labelled sections map directly: `// UPLOAD METHODS` + `// DRAG-AND-DROP UPLOAD` `:1311-1494` → `composables/fileUpload.js` (`dragDepth` counter, `collectDroppedFiles`, progress/cancel); `// FOLDER/PAGE/ASSET METHODS` `:1067-1310` → `composables/fileManagerActions.js`; tree loading → F7.
4. **`components/GroupEditOverlay.vue` (1344)** — template is already sectioned `<!-- OVERVIEW -->` `:64`, `<!-- RULES -->` `:180-452`, `<!-- PERMISSIONS -->` `:452`, `<!-- USERS -->` `:487-610`; script pairs: rules CRUD/import/export `:1006-1099`, users panel `:1101-1187`. Extract `GroupRulesEditor.vue` (v-model on `rules`) and `GroupUsersPanel.vue` (props `groupId`).
5. **`components/AuthLoginPanel.vue` (1175)** — eight `state.screen` branches in one template (`:6,131,167,222,300,318,378,420`) with one `state` bag of 18 fields. Split the self-contained ones: `AuthTfaScreens.vue` (`tfa` + `tfasetup`, script `:1006-1087`) and `AuthRegisterScreen.vue` (`register` + `registerCheckEmail`, `:876-917`); `changePwd` (`:918-958`) largely duplicates `ChangePwdDialog.vue` (same three fields, same validation rules `:603-611` vs `ChangePwdDialog.vue:183-191`) — after F5 the remaining difference is the endpoint.
6. **`pages/AdminStorage.vue` (1437)** — `generateGraph()` `:1230-1404` (175 lines) is a pure function of `state.targets` → `{ nodes, edges, layouts, paths }`; move to `helpers/storageDeliveryGraph.js` (and fix the `las` glyphs, F10). GitHub setup flow `:1164-1228` + `helpers/storageSetup.js` already exists — check what remains inline.
7. **`pages/Graph.vue` (1269)** — `graphFilters.js`/`graphForces.js` are already split out; the remaining seams are canvas drawing `:642-766` (`drawEdges/drawClusterHulls/drawNodes/drawLabels/repaint`, pure over `ctx` + node arrays) → `pages/graphDraw.js`, and simulation/zoom `:840-973` → `pages/graphSimulation.js`.
8. **`components/PageHeader.vue` (1209)** — the save/discard/conflict/undo cluster `:612-880` (`discardChanges`, `saveChanges`, `saveChangesCommit`, `resolveSaveConflict`, `undoDiscard`) → `composables/pageSaveFlow.js`; the header keeps rendering + the in-place editables `:561-611`.
9. **`components/PageHistoryOverlay.vue` (1144)** — Monaco diff mount/dispose `:716-850` → `composables/monacoDiff.js`. Five other files create Monaco editors (`PageSaveConflictDialog`, `GlossaryImportDialog`, `InboxReview`, `EditorCode`, `EditorAsciidoc`) — candidates to share the theme/define + dispose boilerplate, not verified identical here.
10. **`components/EditorWysiwyg.vue` (1270)** — `menuBar` `:203-~720` is ~500 lines of static toolbar definition closing over `editor`; move to `helpers/wysiwygMenuBar.js` as `buildMenuBar(editorRef, { TEXT_COLORS, HIGHLIGHT_COLORS })`.

Leave as-is: `NavItemEditor.vue` (1092; one coherent editor, two importers), `UserEditOverlay.vue` (1047; eleven cards, no logic worth lifting beyond F10), `layouts/AdminLayout.vue` (902; nav + drawer, one concern), `Search.vue`/`HeaderSearch.vue` (no shared functions).

## Files ranked by size with a one-line verdict each

| Lines | File | Verdict |
| --- | --- | --- |
| 2509 | components/EditorMarkdown.vue | split (F13.2): insert commands, divider drag, collab boot |
| 2085 | components/FileManager.vue | split (F13.3) + F7 tree loader |
| 1437 | pages/AdminStorage.vue | split generateGraph out (F13.6); delete dead `configIfCheck` + pug comments + `las` glyphs (F1/F10) |
| 1431 | pages/Index.vue | split the route watcher (F13.1) |
| 1344 | components/GroupEditOverlay.vue | split rules editor + users panel (F13.4) |
| 1270 | components/EditorWysiwyg.vue | move `menuBar` to a helper (F13.10); delete stubs (F10) |
| 1269 | pages/Graph.vue | split draw + simulation (F13.7) |
| 1209 | components/PageHeader.vue | extract save flow composable (F13.8) |
| 1175 | components/AuthLoginPanel.vue | split TFA/register screens (F13.5); F5 |
| 1144 | components/PageHistoryOverlay.vue | extract Monaco diff composable (F13.9) |
| 1092 | components/NavItemEditor.vue | leave |
| 1047 | components/UserEditOverlay.vue | leave; delete no-op handlers (F10), F6 |
| 992 | pages/AdminGeneral.vue | F2 + F3 (−~150 here alone) |
| 902 | layouts/AdminLayout.vue | leave; drop commented overlay line (F8) |
| 894 | pages/Search.vue | leave; 4 pug comment lines (F10) |
| 892 | pages/AdminAuth.vue | F1 + F3 + F6 |
| 871 | pages/AdminTheme.vue | F3 |
| 841 | components/ImportBatchPageDialog.vue | leave (distinct from ImportPageDialog: batch/drop/overwrite flow) |
| 799 | components/PageActionsCol.vue | leave |
| 791 | components/HeaderSearch.vue | leave |
| 776 | pages/AdminScheduler.vue | leave |
| 769 | pages/AdminUtilities.vue | leave — eleven `confirm().onOk(post→notify)` actions are the same shape but each has bespoke copy/side effects; a `runUtility()` wrapper would save ~5 lines each, not worth the indirection |
| 758 | pages/AdminSecurity.vue | F3 |
| 721 | components/TreeBrowserDialog.vue | F7 |
| 662 | pages/AdminComments.vue | F1 + F3 |
| 628 | pages/AdminPages.vue | leave |
| 626 | App.vue | leave |
| 602 | pages/AdminBlocks.vue | F3 |
| 565 | pages/AdminDashboard.vue | leave (`newSite/newUser/newGroup` are 7-line duplicates of the list pages' openers — not worth a helper) |
| 544 | pages/AdminIcons.vue | leave (no test) |
| 539 | components/WebhookEditDialog.vue | leave |
| 523 | pages/AdminMail.vue | F3 + F8 |
| 500 | pages/AdminLogin.vue | F2 + F3 |
| 456 | components/LinkPickerDialog.vue | F7 |
| 417 | pages/AdminSearch.vue | F3 (already on the shared config helpers) |
| 412 / 289 | pages/AdminApi.vue / ProfileApi.vue | F11 |
| 391 | pages/AdminLocale.vue | F3 |
| 389 / 318 | components/ApiKeyCreateDialog.vue / ProfileApiKeyCreateDialog.vue | F11 |
| 382 / 300 | pages/AdminUsers.vue / AdminGroups.vue | F12 |
| 367 | pages/AdminAnalytics.vue | F1 + F3 |
| 367 / 229 / 209 | UserCreateDialog / ChangePwdDialog / UserChangePwdDialog | F5 |
| 292 | pages/AdminEditors.vue | F3 |
| 222 | pages/AdminFlags.vue | F3 |
| 177 | components/MailTemplateEditorOverlay.vue | delete (F8) |
| 124 | pages/AdminRendering.vue | delete (F9) |
| 91–158 | the seven `*DeleteDialog.vue` | delete four, keep Site/User/(Page) (F4) |

## Components without a co-located `*.test.js` (42)

`pages/`: AdminDashboard, AdminGroups, AdminIcons, AdminRendering, Login, ProfileAvatar.
`layouts/`: MainLayout, ProfileLayout.
`components/`: AccountMenu, ApprovalRuleDialog, AssetDeleteDialog, BlockParamsDialog, ChangePwdDialog, CheckUpdateDialog, DevQuickMenu, EditorEmojiMenu, EditorRedirect, FolderDeleteDialog, FolderRenameDialog, GroupCreateDialog, GroupDeleteDialog, HeaderActionsMenu, IconPickerDialog, InboxDeclineDialog, LinkPickerDialog, LoadingGeneric, MailTemplateEditorOverlay, NavSidebarItem, PageReasonForChangeDialog, PageRedirect, PageRelationDialog, PageUnlockDialog, PageVersionSourceDialog, RerenderPageDialog, StatusLight, SuggestionGuestDialog, TreeLevel, TreeNav, TreeNode, UserChangePwdDialog, UserDefaultsMenu, WebhookDeleteDialog.

Everything else (125 files) has at least one; `EditorMarkdown`, `EditorWysiwyg`, `PageHeader`, `AuthLoginPanel`, `App.vue` have two or three.

## Things I checked and rejected (so nobody re-checks them)

- **`lang="pug"` templates**: `grep -rl 'lang="pug"'` over the four areas → none. **Options API**: `grep -L '<script setup'` → none. Both concerns from the brief are already done.
- **Components with zero importers**: scripted grep of every filename in quoted-import/`import()` form across `frontend/src` (tests excluded) → every one of the 167 has ≥1 importer. `DevQuickMenu` (dev-only, `App.vue:52`), `LoadingGeneric`/`StatusLight` (globally registered in `boot/components.js`) are live.
- **Pages not in `routes.js`**: none.
- **`TreeNav`/`TreeLevel`/`TreeNode` vs `shared/WTree`/`WTreeNode`**: not duplicates — `WTree` is a controlled static nested-array tree (its header says it was written for the page-contents sidebar), `TreeNav` is a lazy-loading id-map tree with context menus. *Cross-area note for the `shared/` survey*: `WTree` is registered in `shared/index.js:68,128` but no `<w-tree>` tag or `WTree` import exists anywhere outside `shared/` (`grep -rn "w-tree\b\|WTree\b" frontend/src` → only the registry), so it looks dead there.
- **`HeaderSearch.vue` vs `Search.vue`**: no overlapping functions (`realQueryLength/fetchPreview/…` vs `performSearch/loadMore/…`).
- **`ImportPageDialog` vs `ImportBatchPageDialog`**: different flows (single convert-and-insert vs. multi-file drop/overwrite/save-all); `convert()` bodies differ.
- **`FolderCreateDialog`/`FolderRenameDialog`/`AssetRenameDialog`**: share only two 5-line validation arrays; a shared component would be a props-explosion for 10 lines.
- **`EditorMarkdown.insertAssetClb` vs `EditorWysiwyg.insertAssetClb`**: same event, different target syntax (markdown string vs TipTap chain) — correctly separate.
- **`SideDialog.vue` vs `MainOverlayDialog.vue`**: different containers (page-side panel vs. full overlay), different importers.
- **`useSiteAdminAccess` not on `AdminAnalytics`/`AdminComments`/`AdminStorage`/`AdminSearch`/`AdminPages`**: those surfaces have no `site:*` permission in `SITE_PERMISSIONS` — not drift, and out of scope anyway.
- **A generic "admin list page" composable** (search+paginate+sort+row actions): only `AdminUsers` has the debounce-search + pager shape; `AdminPages`/`AdminComments` paginate by offset with bespoke filters; `AdminGroups`/`AdminWebhooks`/`AdminSites` aren't paginated. Nothing common enough beyond F12.
- **`refresh()` wrappers** (`await load(); notify(refreshSuccess)`, 7×): folded into F3's composable rather than a finding of their own.
- **`AdminUtilities.vue`'s eleven confirm→POST→toast actions**: same shape, but each has distinct copy, `persistent`/`caption` choices and side effects (`window.location.assign`, counts in the message); a wrapper saves ~5 lines each at the cost of hiding those differences.
- **Commented-out `overlays` entry and `ADMIN_OVERLAY_TITLES` in `AdminLayout.vue`**: not a duplication — the titles map exists because the overlay child owns the heading (documented at `:594-599`).
