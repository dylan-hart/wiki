repo: dylan-hart/wiki
branch: scarlett

## Last sync

date: 2026-09-05T16:12:00Z

### Updated in this project

- Baseline corrected to the `scarlett` branch (Cardinal.js 3.x, the Wiki.js 3.x fork: Vue 3 + Vite + Tailwind, in-repo `W*` component library) — the earlier screens were grounded on 2.x from `main`
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

| Screen | Repo files (branch scarlett unless noted) |
| --- | --- |
| Cardinal Wiki - Ledger 3x.dc.html (LOCKED — canonical page view) | frontend/src/layouts/MainLayout.vue, frontend/src/components/HeaderNav.vue, frontend/src/components/PageHeader.vue, frontend/src/pages/Index.vue, frontend/src/components/shared/WBreadcrumbs.vue, frontend/src/components/PageActionsCol.vue, frontend/src/components/PageToc.vue, frontend/src/components/PageTags.vue, frontend/src/components/FooterNav.vue, frontend/src/css/_theme.scss, frontend/src/css/_palette.scss |
| Cardinal Wiki - Admin 3x.dc.html (LOCKED) | frontend/src/layouts/AdminLayout.vue, frontend/src/pages/AdminDashboard.vue, frontend/src/components/FooterNav.vue |
| Cardinal Wiki - Editor 3x.dc.html (LOCKED) | frontend/src/components/EditorMarkdown.vue, frontend/src/components/CollabPresence.vue, frontend/src/components/PageHeader.vue, frontend/src/components/PageActionsCol.vue |
| Cardinal Wiki - Primitives Dark 3x.dc.html | dark token set for shared/W* + notify.js (mirrors the light primitives sheet) |
| Cardinal Wiki - Ledger Dark 3x.dc.html | page view in dark: MainLayout, HeaderNav, NavSidebar, PageHeader, PageToc, PageActionsCol, Index.vue |
| Cardinal Wiki - Table Editor 3x.dc.html (LOCKED) | frontend/src/components/TableEditorOverlay.vue |
| Cardinal Wiki - Page Properties 3x.dc.html (LOCKED) | frontend/src/components/SideDialog.vue, frontend/src/components/PagePropertiesDialog.vue, frontend/src/components/PageTags.vue |
| Cardinal Wiki - Primitives 3x.dc.html (LOCKED) | frontend/src/composables/notify.js, plus the patterns established across the locked screens (WBanner/WBtn/WInput/WToggle/WChip/WBadge/StatusLight usage) |
| Cardinal Wiki - Auth Screens 3x.dc.html (LOCKED) | frontend/src/components/AuthRegisterScreen.vue, frontend/src/components/AuthTfaScreens.vue, frontend/src/components/AuthLoginPanel.vue |
| Cardinal Wiki - Profile 3x.dc.html (LOCKED) | frontend/src/components/ProfileOverlay.vue, frontend/src/pages/ProfileInfo.vue |
| Cardinal Wiki - Admin Blocks 3x.dc.html (LOCKED) | frontend/src/pages/AdminBlocks.vue, frontend/src/layouts/AdminLayout.vue |
| Cardinal Wiki - Tags 3x.dc.html (LOCKED) | frontend/src/pages/TagsBrowse.vue, frontend/src/components/PageTags.vue |
| Cardinal Wiki - Login 3x.dc.html (LOCKED) | frontend/src/pages/Login.vue, frontend/src/components/AuthLoginPanel.vue, frontend/src/layouts/AuthLayout.vue, frontend/src/components/FooterNav.vue |
| Cardinal Wiki - Inbox Review 3x.dc.html (LOCKED) | frontend/src/pages/InboxReview.vue, frontend/src/components/InboxOverlay.vue |
| Cardinal Wiki - Inbox 3x.dc.html | frontend/src/components/InboxOverlay.vue, frontend/src/pages/InboxWatching.vue |
| Cardinal Wiki - Graph 3x.dc.html (LOCKED) | frontend/src/pages/Graph.vue, frontend/src/components/GraphClientTypeFilter.vue (palette hexes taken from Graph.vue's CATEGORICAL_PALETTE_LIGHT) |
| Cardinal Wiki - File Manager 3x.dc.html (LOCKED) | frontend/src/components/FileManager.vue, frontend/src/components/TreeNav.vue (referenced), frontend/src/helpers/fileTypes.js (referenced) |
| Cardinal Wiki - History 3x.dc.html (LOCKED) | frontend/src/components/PageHistoryOverlay.vue, frontend/src/components/MainOverlayDialog.vue |
| Cardinal Wiki - Ledger.dc.html (legacy 2.x) | main: client/themes/default/components/page.vue, client/components/common/nav-header.vue, client/themes/default/scss/app.scss |
| Cardinal Wiki - Page View.dc.html (legacy 2.x options board) | main: same as above + nav-sidebar.vue, nav-footer.vue |
| Cardinal Wiki - Admin.dc.html (legacy 2.x) | main: client/components/admin.vue, client/components/admin/admin-dashboard.vue, client/static/svg/icon-*.svg |
| Cardinal Wiki - Editor.dc.html (legacy 2.x) | main: client/components/editor.vue, client/components/editor/editor-markdown.vue |

## Pending re-grounding on scarlett

- Admin icon set → 3.x uses Iconify (`la:` / `mdi:`) via backend/controllers/icons.ts, not the 2.x Icons8 SVGs; the animated set needs re-scoping
- New 3.x surfaces with no 2.x equivalent still to do: profile sections other than Identity (avatar, auth, groups, API keys, notifications); admin settings pages other than dashboard/blocks; search results; block picker
