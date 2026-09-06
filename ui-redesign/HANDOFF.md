# Cardinal wiki — design handoff

Fifteen screens recreating and redesigning the Wiki.js 3.x UI (`dylan-hart/wiki`, branch `scarlett`) in the Cardinal language. Every file is a self-contained HTML document — open it in a browser, no build step.

Read `CLAUDE.md` for the locked design decisions and `github.md` for the screen → source-file map.

## Screens

| File | Implements |
| --- | --- |
| Cardinal Wiki - Ledger 3x.dc.html | page view — MainLayout, HeaderNav, NavSidebar, PageHeader, PageToc, PageTags, PageActionsCol, FooterNav, Index.vue |
| Cardinal Wiki - Editor 3x.dc.html | markdown editor — EditorMarkdown, PageHeader (edit state), CollabPresence, PageActionsCol (edit state) |
| Cardinal Wiki - History 3x.dc.html | PageHistoryOverlay |
| Cardinal Wiki - File Manager 3x.dc.html | FileManager |
| Cardinal Wiki - Graph 3x.dc.html | Graph.vue, GraphClientTypeFilter |
| Cardinal Wiki - Inbox 3x.dc.html | InboxOverlay + InboxWatching |
| Cardinal Wiki - Inbox Review 3x.dc.html | InboxReview |
| Cardinal Wiki - Tags 3x.dc.html | TagsBrowse |
| Cardinal Wiki - Login 3x.dc.html | Login.vue, AuthLoginPanel, AuthLayout |
| Cardinal Wiki - Auth Screens 3x.dc.html | AuthRegisterScreen, AuthTfaScreens |
| Cardinal Wiki - Profile 3x.dc.html | ProfileOverlay + ProfileInfo |
| Cardinal Wiki - Admin 3x.dc.html | AdminLayout + AdminDashboard |
| Cardinal Wiki - Admin Blocks 3x.dc.html | AdminBlocks |
| Cardinal Wiki - Page Properties 3x.dc.html | SideDialog + PagePropertiesDialog |
| Cardinal Wiki - Primitives 3x.dc.html | shared/W* primitives, notify.js — toasts, confirm, loading/empty, banners, buttons, fields, marks |
| Cardinal Wiki - Table Editor 3x.dc.html | TableEditorOverlay |
| Cardinal Wiki - Primitives Dark 3x.dc.html | dark token set for the same primitives |
| Cardinal Wiki - Ledger Dark 3x.dc.html | page view in dark — the chrome proof |

Legacy, reference only (built from 2.x on `main` before the baseline was corrected): `Cardinal Wiki - Page View.dc.html`, `Cardinal Wiki - Ledger.dc.html`, `Cardinal Wiki - Admin.dc.html`, `Cardinal Wiki - Editor.dc.html`.

## Suggested implementation order

1. **Tokens.** `frontend/src/css/_theme.scss` and the `--color-*` properties in `css/tailwind.css`. Slate chrome `#38465f`, ink `#1c2233`, paper `#f5f6f9`, hairline `#dbe1ec`, accent `#e4676b` fills with `#c14a52` for accent text on white/paper and `#a83f45` for links or accent text on the tinted `#eef1f7` / `#f0f2f7` strips. Light text tiers: body `#2f3a4f`, secondary `#4e5d7d`, caption `#57668a` — nothing lighter carries text. Dark: ink `#14171f`, panel `#1b1f2a`, raised `#242b3a`, hairline `#2a3040`, text `#e6eaf2` / `#9aa6bd` / `#8792ab`, accent `#f08287` taking dark ink on fills. Type: Barlow Condensed headings, Barlow body, Roboto Mono metadata. Status fills: positive `#5f9c86`, warning `#d9a441`, negative `#e4676b`; as text use `#3f7a66` / `#a8801f` / `#c14a52`.
2. **`src/components/shared/`** against the primitives sheet — WBtn, WInput, WChip, WBadge, WToggle, WBanner, StatusLight, notifications.
3. **Chrome:** MainLayout, HeaderNav, NavSidebar, PageHeader, PageActionsCol, pages/Index.vue.
4. **Overlays:** MainOverlayDialog, SideDialog, then each overlay's own content.
5. **Admin:** AdminLayout, then the settings pages (all follow the primitives sheet's section-header + settings-row skeleton).

## Behavioural changes, not just visual

- Page actions rail: duplicate, rename/move and delete move into the more (`...`) menu.
- Knowledge graph: the Connect-by control is dropped.
- Profile: the first rail entry is **Identity**, not Profile.
- Overlay sizing: inbox and profile at 50% of the viewport; file manager and page history stay near-full-bleed.

## Not yet designed

Profile sections other than Identity (avatar, auth, groups, API keys, notifications); admin settings pages other than dashboard and blocks; search results; block picker. All are recombinations of the primitives sheet plus an existing screen — the settings-row skeleton covers most of them.
