repo: dylan-hart/wiki
branch: scarlett

## Last sync

date: 2026-09-08T22:12:00Z

### Updated in this project

- Block boards for every block with UI of its own: Infobox, Spoiler, Checklist, Index, Countdown, Live Data, Gallery, and a shared Figures/embeds/error board covering the other eighteen (Ledger + Cobalt, light + dark, with spec paragraphs)
- Tabset block board (`Cardinal Wiki - Tabset Block 3x.dc.html`) + `handoff-5/tabset-block.md`: Ledger and Cobalt takes of `blocks/block-tabs`, light and dark, with the `--tabs-*` custom-property table replacing the block's own card/shadow/gradient styling
- Header notifications button is `inbox` (HeaderNav.vue:131), fixed in 8 screens; the page-banner watch toggle keeps `bell` (PageHeader.vue, unquoted `bell`/`bell-filled` pair)
- Icon pass: every glyph in ledger/ and cobalt/ swapped for the exact bundled Tabler body from `frontend/src/assets/icons.generated.js` (stroke 1.5, no round caps), tagged `data-icon="tabler:…"`; rail primary is `tag`, sidebar nav defaults folder/file-text, header graph is `hierarchy`, search trailing button is `tags`
- Back to top locked direction (turn 2): third cell of the sidebar `.sidebar-actions` strip (locale | browse | top), row 40px + hairline, cell always reserved so locale/browse never shift; Ledger and Cobalt takes
- Added the Back to top options board (Ledger, three takes): foot of the actions rail, head of the contents rail, tab on the article's bottom edge — replacing the repo's round corner disc at the sidebar seam
- Added the Edit menu items overlay (Cobalt sibling)
- Added the Edit menu items overlay (Ledger): sortable item list with headers, nested rail, separators and the Mixed generated block; link detail panel with parent/leaf fields, group visibility, nest/un-nest and delete
- Locked Edit navigation as the footer popover (1a) and added its Cobalt sibling
- Added the Edit navigation options board (Ledger, three takes): popover off the sidebar footer, two-decision dialog, sidebar takeover — cascade modes, menu source, hand-off to Edit menu items
- Added the cardinal.wiki public site (7 pages): Home, Import command builder (real migrate/verify-migration flags, sample dry-run report, six-step cutover, honest gaps list), Export (per-page export curl builder, MCP walk, planned exporters with what-carries tables), Compare matrix (8 competitors, column toggles), Get started (compose / from-source), Roadmap, Security
- Added the search results screen (light card on the light ground — the 2.x dark radial band and the gutter Back button both dropped; filter column with sort/path/tags/locale/editor/publish-state, result rows with accent-tinted matched terms, load-more, and the no-results / empty-query states)
- Added the block picker overlay (near-full-bleed; catalog grid at two cards per row, selection drawn as accent hairline plus corner marks instead of the 2.x glow, props panel with the MDC markup it will insert)
- Added the admin General page (12-column settings grid: site info, footer/copyright, features with the reason-for-change segmented control, contents-depth range, logo and favicon with live previews, discovery, uploads, URL handling, SEO)
- Added the menus & pickers sheet: the create menu (PageNewMenu from the header button), the sidebar right-click context menu (PageNewMenu in context-menu mode with New folder), the Browse panel's up-one-level plate in all three states, and the tree-browser Save as… dialog (savePage/duplicatePage/renamePage)
- Baseline corrected to the `scarlett` branch (Wiki.js 3.x: Vue 3 + Vite + Tailwind, in-repo `W*` component library) — the earlier screens were grounded on 2.x from `main`
- Added the 3.x page view in the locked Ledger language (header with inline search, 255px sidebar with locale/Browse strip, page-icon masthead, contents rail, tags, watchers)
- Added the 56px right-hand page actions rail (properties, history, export, more, duplicate, move, delete) from PageActionsCol.vue — history lives there in 3.x, not in the header
- Added the 3.x admin shell + dashboard (300px dark nav with site picker, count badges and status lights; dashboard counter cards and last-logins panel)
- Added the 3.x markdown editor: in-place page header (editable title/description, collab presence, discard/save/save-and-close), vertical insert rail, format toolbar, Monaco source pane, draggable divider, preview pane with scroll-sync lock, and the actions rail in its editing (red) state
- Added the breadcrumb bar (trail + last-modified) as its own bar above the masthead on both the page view and the editor, per pages/Index.vue — it stays while editing
- Added the inbox overlay, Watching tab (notifications list with mark-read, watched pages with per-page notification preferences)
- Added the dark theme: dark primitives sheet (token set, toasts, confirm, buttons, fields, marks) and the dark page view
- Added the table editor overlay (toolbar with add row/column, headerless + compact, styling menu; per-column alignment and delete tools; live markdown preview)
- Added the page properties side panel (right-docked 560px panel with the quick-jump rail outside its leading edge; info, publish state, relations, sidebar, social, tags, classification, visibility)
- Added the shared primitives sheet (toasts, confirm, loading/empty, banners, buttons, fields, marks, section header + settings row) as the handoff reference
- Locked the auth panel states
- Added the remaining auth panel states: register, check-your-email, two-factor entry (with recovery-code alternative), two-factor setup
- Locked the profile overlay at 50% sizing; first rail entry renamed Identity (was Profile > Profile)
- Added the profile overlay, My info section (section rail with logout, info fields, preferences, accessibility, save bar)
- Added the admin blocks page (block list with tag chips, built-in/custom, per-block server field, configure, enable toggles, plus block credentials with allowed domains/rotate)
- Added the tags browse page (selection chips, available tags with usage counts, locale/order filters, results list with per-page tags, load more)
- Added the login screen (strategy picker, credentials form, passkey, redirect providers, register/forgot, site login background as a drop slot)
- Locked the inbox Review tab (icon-only decline/approve, rail as overlay at 50% sizing, stacking diff panes)
- Added the inbox Review tab (open submission: approvals progress, stale banner, editable side-by-side suggestion diff, decline/approve)
- Recorded overlay sizing: inbox at 50% of viewport, file manager and history near-full-bleed (see CLAUDE.md)
- Locked the knowledge graph (site nav sidebar restored; Connect-by control dropped per in-flight work)
- Locked the file manager overlay
- Added the knowledge graph view (canvas force graph with cluster hulls, control rail: group by / connect by / size by / count / edits-by, filter panel with keyword, tags, folder-depth slider, locale, legend, truncation notice, hover tooltip)
- Locked the page history overlay
- Added the file manager overlay (folder tree, toolbar, file list with type rows, details pane with insert, path footer)
- Locked the 3.x markdown editor
- Added the page history overlay (subway timeline with A/B version cursors, per-version menu, side-by-side diff)
- Recorded the standing decision that duplicate/move/delete fold into the actions rail's more menu (see CLAUDE.md)
- Locked the 3.x admin shell + dashboard
- Locked the 3.x Ledger page view as canonical; earlier 2.x-based screens kept for reference only

## Screen map

| Cardinal Wiki - Block Infobox / Spoiler / Checklist / Index / Countdown / Live Data / Gallery 3x.dc.html | blocks/block-<name>/component.js |
| Cardinal Wiki - Block Figures 3x.dc.html | blocks/shared/figure.js, blocks/shared/styles.js, blocks/block-kroki/component.js (DiagramImageElement family), embed blocks |

| Cardinal Wiki - Tabset Block 3x.dc.html | blocks/block-tabs/component.js, blocks/block-tab/component.js |

| (all ledger/ and cobalt/ screens — icon bodies) | frontend/src/assets/icons.generated.js, frontend/src/components/PageActionsCol.vue, HeaderNav.vue, HeaderSearch.vue, NavSidebarItem.vue, MainLayout.vue |

Cobalt theme copies (`… 3x - Cobalt.dc.html`) are derived from the Ledger screen of the same name and share its source files.

| Screen | Repo files (branch scarlett unless noted) |
| --- | --- |
| Cardinal Site - Home.dc.html | README.md, docs/mcp-getting-started.md, backend/api/*.ts (feature list) |
| Cardinal Site - Import.dc.html | docs/migration/migration-runbook.md, backend/migration/cli.ts, backend/migration/source-args.ts, backend/migration/report.ts (referenced) |
| Cardinal Site - Export.dc.html | backend/api/pages/export.ts, docs/mcp-getting-started.md, docs/operations.md (referenced) |
| Cardinal Site - Compare.dc.html | feature rows from backend/api/*.ts, docs/decisions/delegated-per-site-administration.md; competitor columns from public docs |
| Cardinal Site - Get Started.dc.html | README.md (Generic Setup, First-Run Admin Account) |
| Cardinal Site - Roadmap.dc.html | docs/migration/migration-runbook.md (tooling status), docs/cardinal-reskin-second-pass.md (Still to do) |
| Cardinal Site - Security.dc.html | docs/mcp-getting-started.md, docs/tls-termination.md, docs/offline-deployment.md, docs/security/custom-block-upload.md, docs/security-reviews/ |
| ledger/Cardinal Wiki - Back To Top 3x - Ledger.dc.html (options board) | frontend/src/layouts/MainLayout.vue (WPageScroller mount, scrollerAnchorX, .corner-btn), frontend/src/components/PageActionsCol.vue (referenced) |
| ledger/Cardinal Wiki - Edit Menu Items 3x - Ledger.dc.html | frontend/src/components/NavEditOverlay.vue, frontend/src/components/NavItemEditor.vue, backend/locales/en.json (navEdit.* strings) |
| ledger/Cardinal Wiki - Edit Navigation 3x - Ledger.dc.html (LOCKED — 1a; options board) | frontend/src/components/NavEditMenu.vue, frontend/src/components/NavEditOverlay.vue (referenced), frontend/src/components/NavSidebar.vue, backend/locales/en.json (navEdit.* strings) |
| ledger/Cardinal Wiki - Page View 3x - Ledger.dc.html (LOCKED — canonical page view) | frontend/src/layouts/MainLayout.vue, frontend/src/components/HeaderNav.vue, frontend/src/components/PageHeader.vue, frontend/src/pages/Index.vue, frontend/src/components/shared/WBreadcrumbs.vue, frontend/src/components/PageActionsCol.vue, frontend/src/components/PageToc.vue, frontend/src/components/PageTags.vue, frontend/src/components/FooterNav.vue, frontend/src/css/_theme.scss, frontend/src/css/_palette.scss |
| ledger/Cardinal Wiki - Search 3x - Ledger.dc.html | frontend/src/pages/Search.vue, frontend/src/components/HeaderNav.vue, frontend/src/components/FooterNav.vue |
| ledger/Cardinal Wiki - Block Picker 3x - Ledger.dc.html | frontend/src/components/BlockPickerOverlay.vue, frontend/src/components/BlockPropsForm.vue (referenced), frontend/src/helpers/blocks.js (referenced) |
| ledger/Cardinal Wiki - Admin General 3x - Ledger.dc.html | frontend/src/pages/AdminGeneral.vue, frontend/src/components/BlueprintIcon.vue, frontend/src/layouts/AdminLayout.vue |
| ledger/Cardinal Wiki - Menus 3x - Ledger.dc.html | frontend/src/components/PageNewMenu.vue, frontend/src/components/NavBrowseMenu.vue, frontend/src/components/NavSidebarItem.vue, frontend/src/components/TreeBrowserDialog.vue, frontend/src/components/BlueprintIcon.vue |
| ledger/Cardinal Wiki - Admin 3x - Ledger.dc.html (LOCKED) | frontend/src/layouts/AdminLayout.vue, frontend/src/pages/AdminDashboard.vue, frontend/src/components/FooterNav.vue |
| ledger/Cardinal Wiki - Editor 3x - Ledger.dc.html (LOCKED) | frontend/src/components/EditorMarkdown.vue, frontend/src/components/CollabPresence.vue, frontend/src/components/PageHeader.vue, frontend/src/components/PageActionsCol.vue |
| ledger/Cardinal Wiki - Primitives Dark 3x - Ledger.dc.html | dark token set for shared/W* + notify.js (mirrors the light primitives sheet) |
| ledger/Cardinal Wiki - Page View Dark 3x - Ledger.dc.html | page view in dark: MainLayout, HeaderNav, NavSidebar, PageHeader, PageToc, PageActionsCol, Index.vue |
| ledger/Cardinal Wiki - Table Editor 3x - Ledger.dc.html (LOCKED) | frontend/src/components/TableEditorOverlay.vue |
| ledger/Cardinal Wiki - Page Properties 3x - Ledger.dc.html (LOCKED) | frontend/src/components/SideDialog.vue, frontend/src/components/PagePropertiesDialog.vue, frontend/src/components/PageTags.vue |
| ledger/Cardinal Wiki - Primitives 3x - Ledger.dc.html (LOCKED) | frontend/src/composables/notify.js, plus the patterns established across the locked screens (WBanner/WBtn/WInput/WToggle/WChip/WBadge/StatusLight usage) |
| ledger/Cardinal Wiki - Auth Screens 3x - Ledger.dc.html (LOCKED) | frontend/src/components/AuthRegisterScreen.vue, frontend/src/components/AuthTfaScreens.vue, frontend/src/components/AuthLoginPanel.vue |
| ledger/Cardinal Wiki - Profile 3x - Ledger.dc.html (LOCKED) | frontend/src/components/ProfileOverlay.vue, frontend/src/pages/ProfileInfo.vue |
| ledger/Cardinal Wiki - Admin Blocks 3x - Ledger.dc.html (LOCKED) | frontend/src/pages/AdminBlocks.vue, frontend/src/layouts/AdminLayout.vue |
| ledger/Cardinal Wiki - Tags 3x - Ledger.dc.html (LOCKED) | frontend/src/pages/TagsBrowse.vue, frontend/src/components/PageTags.vue |
| ledger/Cardinal Wiki - Login 3x - Ledger.dc.html (LOCKED) | frontend/src/pages/Login.vue, frontend/src/components/AuthLoginPanel.vue, frontend/src/layouts/AuthLayout.vue, frontend/src/components/FooterNav.vue |
| ledger/Cardinal Wiki - Inbox Review 3x - Ledger.dc.html (LOCKED) | frontend/src/pages/InboxReview.vue, frontend/src/components/InboxOverlay.vue |
| ledger/Cardinal Wiki - Inbox 3x - Ledger.dc.html | frontend/src/components/InboxOverlay.vue, frontend/src/pages/InboxWatching.vue |
| ledger/Cardinal Wiki - Graph 3x - Ledger.dc.html (LOCKED) | frontend/src/pages/Graph.vue, frontend/src/components/GraphClientTypeFilter.vue (palette hexes taken from Graph.vue's CATEGORICAL_PALETTE_LIGHT) |
| ledger/Cardinal Wiki - File Manager 3x - Ledger.dc.html (LOCKED) | frontend/src/components/FileManager.vue, frontend/src/components/TreeNav.vue (referenced), frontend/src/helpers/fileTypes.js (referenced) |
| ledger/Cardinal Wiki - History 3x - Ledger.dc.html (LOCKED) | frontend/src/components/PageHistoryOverlay.vue, frontend/src/components/MainOverlayDialog.vue |
| Cardinal Wiki - Ledger.dc.html (legacy 2.x) | main: client/themes/default/components/page.vue, client/components/common/nav-header.vue, client/themes/default/scss/app.scss |
| Cardinal Wiki - Page View.dc.html (legacy 2.x options board) | main: same as above + nav-sidebar.vue, nav-footer.vue |
| Cardinal Wiki - Admin.dc.html (legacy 2.x) | main: client/components/admin.vue, client/components/admin/admin-dashboard.vue, client/static/svg/icon-*.svg |
| Cardinal Wiki - Editor.dc.html (legacy 2.x) | main: client/components/editor.vue, client/components/editor/editor-markdown.vue |

## Pending re-grounding on scarlett

- Admin icon set → 3.x uses Iconify (`la:` / `mdi:`) via backend/controllers/icons.ts, not the 2.x Icons8 SVGs; the animated set needs re-scoping
- New 3.x surfaces still to do: profile sections other than Identity (avatar, auth, groups, API keys, notifications); admin settings pages other than dashboard/blocks/general — the General page is the pattern reference for the rest
