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

### Observed but out of scope for B1 (for whoever folds these in)

- `CLAUDE.md`'s "GraphQL was removed" section says `frontend/src/pages/` "now has only
  `AdminPagesDeleted.vue`" of that family and that `AdminPages.vue` was "deleted outright". That is no
  longer true — `pages/AdminPages.vue` exists again (commit `c47b73ed`) and is REST-based. Someone
  should re-check that paragraph against the tree.
- `backend/models/mail.ts`'s header comment still cites `MailTemplateEditorOverlay.vue` and the
  `admin.mail.templates` admin section as the unwired UI for an unbuilt template system. Both are now
  deleted (D6), so that sentence needs trimming — but `backend/` is Lane A's workspace, so B1 left it
  alone.
