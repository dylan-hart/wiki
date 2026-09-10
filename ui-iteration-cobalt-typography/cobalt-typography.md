# Cobalt typography — light and dark

Source of truth: `cobalt/Cardinal Wiki - Page View 3x - Cobalt.dc.html` and its dark sibling, then the Primitives pair, then Editor / Admin / Search. Every value below was read out of those files.

## 0. The two reported defects — fix these first

Both sit in the page view: the rendered article (`.page-contents`, `frontend/src/css/_page-contents.scss`) and the two sidebar cards (`.page-sidebar-card`, `Index.vue` + `PageToc.vue` + `PageTags.vue`). Diagnosed against the current `scarlett` source.

### 0.1 Article type is too large

`_page-contents.scss` sets `.page-contents { font-size: 1rem; line-height: 1.6 }` and scales every heading off it in `em` (h1 `2em` = 32px, h2 `1.5em` = 24px, h3 `1.25em` = 20px…). The mockups (both aesthetics) draw the article at a 15.5px base with a 26px h2. Targets, all absolute:

| Element | Current (computed) | Target | Note |
| --- | --- | --- | --- |
| `.page-contents` base | 16px / 1.6 | **15.5px / 1.72** | Barlow 400, `--color-text-body` |
| `p` | inherits | 15.5px / 1.72 | margin `0 0 1.15em` stays |
| `li` | inherits | **15px / 1.6** | steps and bullets both |
| `h1` (in-content) | 32px | 32px | unchanged; Barlow Condensed 700 |
| `h2` | 24px / 1.15 | **26px / 1.15** | Barlow Condensed 600 |
| `h3` | 20px | 20px | 600 |
| `h4` | 17px | 17px | 600 |
| `h5` | 16px | **15.5px** | = base |
| `h6` | 14px | **13.5px** | uppercase .06em, `--content-ink-muted`, unchanged otherwise |
| inline `code` | 0.875em ≈ 14px | 14px | Roboto Mono 400 |
| `pre code` | — | **13px / 1.75** | Roboto Mono 400 |
| blockquote / callout | inherits | **14.5px / 1.6** | |

Write the base and h2 as px (or `em` re-derived from 15.5: h2 = 1.677em). This is the same in Ledger and Cobalt — the aesthetic blocks must not restate any of it.

### 0.2 Headings all read blue

Cobalt's `--color-ink` is `#10194a` — a saturated navy. `_page-contents.scss` draws `h1` in `--content-h1: var(--color-ink)`, so under Cobalt the in-content h1 goes navy while h2 goes cobalt `#1f4fd6`; the two top levels together read as "all blue". The mockup gives exactly one heading level a colour:

| Level | Cobalt light | Cobalt dark |
| --- | --- | --- |
| h1 (in-content) | **`--color-text-body` #1a2038** — not `--color-ink` | #e8ecff |
| h2 | `--color-heading-h2` #1f4fd6, no rule (locked) | #8fb0ff |
| h3 – h5 | `--color-text-body` #1a2038 (inherit) | #e8ecff |
| h6 | `--content-ink-muted` #4a5580 | #a7b3ea |

Fix: in the `body.body--cobalt &` block of `_page-contents.scss` add `--content-h1: var(--color-text-body);` (dark already resolves to `--color-text-dark`). Do not touch h2 — cobalt h2 is the locked decision (project CLAUDE.md: "h2 in cobalt with no rule"). Ledger is unaffected: its `--color-ink` `#1c2233` is a neutral near-black and stays.

### 0.3 Sidebar cards (Contents / Tags / Revision) are too small

Reported against the live `scarlett` build. The *declared* sizes in `Index.vue` / `PageToc.vue` / `PageTags.vue` read correct (`.page-sidebar-heading` 10px, `.page-toc-item--d0` 0.8125rem, `.page-sidebar-revision` 13px, `.page-tag` 12px), so whatever is shrinking them is winning in the cascade from somewhere else — a scoped rule on an ancestor, a `rem` base that is not 16px, a `WChip`/`WSeparator` inline style, or a utility class landing on the same element. Do not fix by nudging the declared values; find the winning rule first (§7 probe, then DevTools › Computed › `font-size` › expand to see which selector wins) and remove or scope it.

Targets, absolute, from `Page View 3x - Cobalt` (identical in Ledger):

| Element | Target | Colour light / dark |
| --- | --- | --- |
| `.page-sidebar-heading` (Contents / Tags / Revision) | 600 **10px** Roboto Mono, .2em, uppercase, 12px below | `--color-text-caption` #5a6699 / #8b98d6 |
| `.page-toc-item--d0` | 500 **13px** Barlow, line-height 1.4, row padding 5px 10px | #1a2038 / #e8ecff |
| `.page-toc-item--d0.page-toc-item--active` | 600 **13px**, 5px radius plate | `--color-accent` #c8303c on `--color-accent-wash` / #ff8f97 on rgb(255 77 90 / .16) |
| `.page-toc-item--d1` | 400 **12.5px** Barlow | `--color-text-secondary` #4a5580 / #a7b3ea |
| `.page-toc-item--d2` | 400 **12px** Barlow | same as d1 |
| `.page-tag` | 500 **12px** Barlow, pill, padding 4px 10px | `--color-tag-chip-text` #1a3fb0 on #dbe5ff / #a3bbff on rgb(61 109 247 / .22) |
| `.page-tag-hash` | **not rendered** under Cobalt (the pill carries no `#`) | — |
| `.page-sidebar-revision` | 400 **13px / 1.7** Barlow | `--color-text-body` #1a2038 / #e8ecff |
| `.page-sidebar-revision-time` | inherits | `--color-text-caption` #5a6699 / #8b98d6 |
| `.page-watchers-plate` | 600 10px Barlow Condensed | unchanged |
| Card box | padding 18px 20px, 14px gap between cards, 280–300px column | white / #141c4f |

The TOC rows in the mockup are 13px with 5px vertical padding and a 2px gap, so a top-level entry occupies ~28px; if the live rows are visibly shorter than that, the size is the cause, not the padding.

## 1. Faces

Three faces, three jobs. Identical in Ledger and Cobalt.

| Token | Face | Job |
| --- | --- | --- |
| `--font-display` | Barlow Condensed | Headings (h1, h2, page title), the wordmark, avatar initials, dashboard numerals, toolbar B/H glyphs. Weight 600 or 700 only. Never 300–500. |
| `--font-sans` | Barlow | Body copy, nav items, buttons, fields, chips, captions, table cells. Weights 400, 500, 600. `letter-spacing: normal` always. |
| `--font-mono` | Roboto Mono | Eyebrows and kickers, paths, timestamps, counts, badges, code. Numerals in mono take `font-variant-numeric: tabular-nums`. |

Loaded weights: Barlow 400/500/600/700, Barlow Condensed 500/600/700, Roboto Mono 400/500/600. The mockups only request Roboto Mono 400/500 and let the browser synthesise 600 for eyebrows; load the real 600 — it renders slightly lighter than the mockup and that is correct.

## 2. What Cobalt does NOT change

The `body.body--cobalt` and `body.body--cobalt.body--dark` blocks in `tailwind.css` must not restate `--font-*`, and no Cobalt-scoped rule may set `font-size`, `font-weight`, `line-height`, `letter-spacing` or `text-transform` except for the four role swaps in §4. Every other type role keeps Ledger's metrics and moves only its `color`.

Two leaks to check for specifically:

- The Material `--text-h1…h6 / subtitle / body / caption / overline` scale in `@theme static` (6rem, weight 300, `letter-spacing: 0.03125em` on body…). None of those utilities may reach a Cardinal role in either aesthetic. A heading drawn at weight 300 or body copy with positive tracking is this scale leaking.
- The `body { font-size: 14px }` base. It is a fallback, not a role: UI type in both aesthetics sits on a 12 / 12.5 / 13 / 13.5 / 15.5 px ladder (see §3) and each role sets its own size.

## 3. Role table

Font shorthand is `weight size[/line-height] family`. Tracking/case apply only where listed. Colours are the Cobalt light value, then Cobalt dark; where the role has a token, the token is named and the literal is what it must resolve to.

### Header bar (`HeaderNav.vue`, `HeaderSearch.vue`) — solid `#1f4fd6`, same in dark (`#1a43bd`)

| Role | Font | Tracking / case | Light | Dark |
| --- | --- | --- | --- | --- |
| Wordmark "Cardinal" | 700 21px/1 display | .06em, uppercase | #fff | #fff |
| Site eyebrow "Platform wiki" | 500 8.5px/1.2 mono | .22em, uppercase | `--color-header-eyebrow` #dfe6ff | same |
| Search placeholder | 400 13.5px sans | — | #e6ecff | same |
| Search shortcut ⌘K | 500 10px mono | — | #fff | #fff |
| Notification count badge | 600 9.5px/16px mono | — | #fff on `--q-accent` #c8303c | same |
| Avatar initials | 700 11.5px display | .06em | #fff on #c8303c | same |

### Sidebar (`NavSidebar.vue`, `NavSidebarItem.vue`) — `#10194a`, dark `#0e1540`

| Role | Font | Tracking / case | Light | Dark |
| --- | --- | --- | --- | --- |
| Section kicker "Documentation" | 600 10px mono | .2em, uppercase | `--color-sidebar-kicker` #7f8ed1 | #7f8ed1 |
| Nav item | 400 13.5px sans | — | `--color-sidebar-text` #d7deff | #d7deff |
| Nav item, active | 600 13.5px sans | — | #fff on #1f4fd6 | same |
| Nav item secondary line | 400 13px sans | — | `--color-sidebar-text-secondary` #a7b3ea | #a7b3ea |
| Locale / Browse / Edit navigation labels | 500 11.5px sans | — | `--color-sidebar-actions-text` #c5cff5 | #c5cff5 |
| Back-to-top "TOP" | 600 7px/1 mono | .16em | #ff8f97 | #ff8f97 |

### Breadcrumb bar (`WBreadcrumbs.vue`, `Index.vue`)

| Role | Font | Light | Dark |
| --- | --- | --- | --- |
| Trail segments | 400 11.5px mono | `--color-text-caption` #5a6699 | #8b98d6 |
| Separators `/` | inherit | #b6bfe0 | #3a4680 |
| Current segment | 500 11.5px mono | `--color-accent-strong` #1f4fd6 | #7fa0ff |
| Last-modified (right) | 400 11.5px mono | #5a6699 | #8b98d6 |

### Page header banner (`PageHeader.vue`) — flat `#1f4fd6`, same in dark

| Role | Font | Tracking / case | Light | Dark |
| --- | --- | --- | --- | --- |
| h1 title | 700 36px/1.05 display | — | `--page-header-fg` #fff | #fff |
| Description | 400 14.5px/1.45 sans | — | `--page-header-subtitle-fg` #dbe4ff | #dbe4ff |
| Draft / Published badge | 600 9.5px mono | .16em, uppercase | #fff on #c8303c | same |

### Article (`_page-contents.scss`) — white card, dark `#141c4f`

| Role | Font | Light | Dark |
| --- | --- | --- | --- |
| h1 (in-content) | 700 32px/1.1 display, hairline rule | `--color-text-body` #1a2038 (see §0.2) | #e8ecff |
| h2 | 600 26px/1.15 display, no rule | `--color-heading-h2` #1f4fd6 | #8fb0ff |
| h3 / h4 / h5 | 600 20 / 17 / 15.5px display | #1a2038 | #e8ecff |
| h6 | 600 13.5px display, .06em, uppercase | #4a5580 | #a7b3ea |
| Paragraph | 400 15.5px/1.72 sans | `--color-text-body` #1a2038 | #e8ecff |
| Numbered-step numeral (§4) | 600 11px/24px mono, centred in a 24px disc | #fff on #1f4fd6 | #fff on #3d6df7 |
| Numbered-step text | 400 15px/1.6 sans | #1a2038 | #e8ecff |
| Inline code | 400 14px mono | `--color-tag-chip-accent-text` #c8303c on #ffe9eb | #ff8f97 on rgb(255 77 90 / .16) |
| Code block | 400 13px/1.75 mono | #e6eaff on `--color-ink` #10194a | #e6eaff on #070b22 |
| Code block syntax tones | inherit | flags #8fb0ff, strings #ff7a84 | same |
| Code block language label | 500 9.5px mono, .14em, uppercase, top-right | #7f8ed1 | #7f8ed1 |
| Callout / blockquote text | 400 14.5px/1.6 sans | #1a2f7a on #e6edff | #c9d6ff on rgb(61 109 247 / .16) |
| Links in prose | inherit size | `--color-accent-strong` #1f4fd6 | #7fa0ff |

### Contents rail (`PageToc.vue`)

| Role | Font | Light | Dark |
| --- | --- | --- | --- |
| Eyebrow "Contents" / "Tags" / "Revision" | 600 10px mono, .2em, uppercase | `--color-text-caption` #5a6699 | #8b98d6 |
| Entry | 500 13px sans | #1a2038 | #e8ecff |
| Entry, active (§4) | 600 13px sans | #c8303c on #ffe9eb | #ff8f97 on rgb(255 77 90 / .16) |
| Sub-entry | 400 12.5px sans | `--color-text-secondary` #4a5580 | #a7b3ea |

### Tags and revision (`PageTags.vue`, `Index.vue`)

| Role | Font | Light | Dark |
| --- | --- | --- | --- |
| Tag chip (§4) | 500 12px sans, pill | `--color-tag-chip-text` #1a3fb0 on #dbe5ff | #a3bbff on rgb(61 109 247 / .22) |
| Tag chip, accent (on-call etc.) | 500 12px sans | #c8303c on #ffe9eb | #ff8f97 on rgb(255 77 90 / .16) |
| Revision lines | 400 13px/1.7 sans | #1a2038; timestamp #5a6699 | #e8ecff; timestamp #8b98d6 |

### Footer (`FooterNav.vue`) — `#10194a`, dark `#070b22`

| Role | Font | Light | Dark |
| --- | --- | --- | --- |
| Copyright line | 400 11px mono | `--color-footer-text` #a7b3ea | #8b98d6 |
| Footer link | inherit | `--color-footer-link` #ff7a84 | #ff7a84 |

### Shared primitives (`shared/W*`, `notify.js`, `_base.scss`)

| Role | Font | Tracking / case | Light | Dark |
| --- | --- | --- | --- | --- |
| Section header / card kicker | 600 10px mono | .2em, uppercase | `--color-slate` #1e2a5e; accent variant #c8303c | #c9d6ff; accent #ff8f97 |
| Dialog title band ("Delete page") | 600 13px display | .08em, uppercase | #fff on `--color-dialog-header-bg` #1c2a70 | #fff on #1a43bd |
| Overlay title band ("Profile") | 600 15px display | .08em, uppercase | #fff | #fff |
| Dialog body | 400 14px/1.6 sans | — | `--color-ink` #10194a | #e8ecff |
| Button label (all variants) | 500 12.5px sans | — | primary #fff on #c8303c; outlined #1e2a5e; ghost #4a5580 | primary #fff; outlined #c9d6ff; ghost #a7b3ea |
| Toast title | 500 13.5px sans | — | #fff on filled toast | same |
| Toast message | 400 13px/1.55 sans | — | #fff / #1e2a5e on light toast | #c9d6ff |
| Toast caption | 400 12px sans | — | rgba(255,255,255,.8) | same |
| Toast "Undo" | 600 11px sans | — | inherits toast text | same |
| Toast repeat mark "×3" | 600 10px mono | — | inherits | same |
| Field label ("Setting label") | 500 14px sans | — | #10194a | #e8ecff |
| Field value / placeholder | 400 13.5px sans | — | #10194a / #5a6699 | #e8ecff / #8b98d6 |
| Field hint | 400 12.5px sans | — | `--color-text-caption` #5a6699 | #8b98d6 |
| Field error | 400 11.5px sans | — | #c8303c | #ff8f97 |
| Read-only field value | 400 13px mono | — | #4a5580 | #a7b3ea |
| Path field (`/docs/…`) | 400 11.5px mono | — | #5a6699 | #8b98d6 |
| Count mark (12, 0) | 500 10.5px mono | — | #1e2a5e | #e8ecff |
| Badge (Draft, 1, 2) | 600 9.5px mono | .16em, uppercase | #fff on #c8303c; neutral #1e2a5e | #fff; neutral #c9d6ff |
| Segmented control option | 400 12px sans; selected 500 12px | — | #1e2a5e; selected #fff on #c8303c | #c9d6ff; selected #fff |
| Selected chip | 400 12px sans | — | #fff on #c8303c | same |
| Setting row description | 400 12.5px sans | — | #5a6699 | #8b98d6 |
| Loading / empty state | 500 13px / 400 13px sans | — | #4a5580 / #5a6699 | #a7b3ea / #8b98d6 |

### Editor (`EditorMarkdown.vue`, `PageHeader.vue` editing)

| Role | Font | Tracking / case | Light |
| --- | --- | --- | --- |
| Editable title | 700 32px/1.1 display | — | `--color-ink` #10194a |
| Editable description | 400 14px/1.4 sans | — | #4a5580 |
| Pane kicker "Markdown" | 600 9.5px mono | .22em, uppercase | #5a6699 |
| Pane kicker "Render preview" | italic 600 12px sans | — | #1e2a5e |
| Toolbar B / H glyphs | 700 14px / 700 13px display | — | #1e2a5e |
| Toolbar I glyph | italic 500 14px sans | — | #1e2a5e |
| Source pane (Monaco) | 400 12.5px/1.85 mono | — | #c3cee2 on #10194a |
| Preview h2 / paragraph | 600 25px/1.15 display / 400 15px/1.7 sans | — | #1f4fd6 / #1a2038 |
| Preview inline code | 400 13.5px mono | — | #1e2a5e |
| Callout kicker "Note" | 600 9.5px mono | .18em, uppercase | #4a5580 |

### Admin (`AdminLayout.vue`, `AdminDashboard.vue`)

| Role | Font | Tracking / case | Light |
| --- | --- | --- | --- |
| Admin kicker "Admin area" | 600 10px mono | .24em, uppercase | #e6ecff |
| Admin nav item | 300 16px sans | — | `--color-admin-sidebar-text` #c5cff5 (the one place Barlow 300 appears; keep it) |
| "beta" badge | 600 9px mono | .16em, uppercase | #fff on #c8303c |
| Page title "Dashboard" | 700 34px/1.05 display | — | #10194a |
| Counter numeral | 700 30px/1.1 display | — | #c8303c |
| Counter small numeral | 700 26px/1.2 display | — | #c8303c |
| Counter caption ("past day") | 400 12px mono | — | #5a6699 |
| Status line "Up to date" | 500 14px/1.4 sans | — | #177a5e |
| Panel kicker "Last logins" | 600 11px mono | .18em, uppercase | #1e2a5e |

### Search (`Search.vue`)

| Role | Font | Tracking / case | Light |
| --- | --- | --- | --- |
| Filter column kicker ("Sort by", "Filters") | 600 10px/1 mono | .2em, uppercase | #1f4fd6 |
| Filter group label | 500 9.5px mono | .16em, uppercase | #5a6699 |
| Result title | 500 15px sans | — | #10194a |
| Result path | 400 11.5px mono | — | #5a6699 |
| Result description | 400 13px/1.5 sans | — | #4a5580 |
| Snippet with matched terms | 400 12.5px/1.55 sans; match 600, #1f4fd6 on #ffe9eb | — | #1a2038 |
| Count line | 400 11.5px/1 mono | — | #5a6699 |
| "Redirect" mark | 400 11px mono | .1em, uppercase | #5a6699 |
| Empty-query prompt | italic 400 14.5px/1.6 sans | — | #4a5580 |

## 4. The four role swaps (Cobalt ≠ Ledger)

These are the only type-level differences between the aesthetics. Everything else is colour.

1. **Table head.** Ledger: mono eyebrow, 600 10.5px, .14em, uppercase. Cobalt: `600 0.8125rem/1.4 var(--font-sans)` (13px Barlow), sentence case, `letter-spacing: normal`, #1f4fd6 on #e6edff (dark #8fb0ff on #0e1540). Already tokenised as `--content-table-head-font` / `--content-table-head-tracking` in `_page-contents.scss` — verify the Cobalt block sets tracking to `normal` and `text-transform: none`.
2. **Numbered steps.** Ledger: `500 11px` mono figure "01" in the margin. Cobalt: 24px cobalt disc, `600 11px/24px var(--font-mono)` white numeral, no leading zero. Already the `cobalt-step` counter in `_page-contents.scss`; confirm the numeral is 600/11px, not `600 0.6875em` scaled off a larger parent (that resolves to ~10.3px at 15px body).
3. **Tag chips.** Ledger: 400 12px, outlined, accent-strong text. Cobalt: `500 12px` Barlow on the #dbe5ff pill — weight goes up one step because the chip is a filled tint, not a hairline outline.
4. **Contents active row.** Ledger: 500 weight, accent inset bar. Cobalt: `600 13px`, accent text on the accent wash — the weight step is what marks it, since there is no inset bar.

## 5. Dark mode

Dark restates colours only. The metric of every role in §3 is identical between `Page View 3x - Cobalt` and `Page View Dark 3x - Cobalt`, and between the two Primitives sheets. If a `body.body--cobalt.body--dark` rule touches anything other than `color`, `background`, `border-color` or `box-shadow`, remove that property.

Dark colour tiers (already in `tailwind.css`, listed for the type roles above): body #e8ecff, secondary #a7b3ea, caption/kicker #8b98d6, slate-on-dark #c9d6ff, h2 / heading accent #8fb0ff, links #7fa0ff, accent text #ff8f97, footer link #ff7a84. Sidebar and header tiers do not change between light and dark (both grounds are already dark).

## 6. Removals

- Any Cobalt-scoped `font-size`, `font-weight`, `line-height`, `letter-spacing`, `text-transform` outside §4.
- Any use of the Material `text-h*` / `text-subtitle*` / `text-body*` / `text-caption` / `text-overline` utilities on a Cardinal-drawn element (either aesthetic).
- Positive `letter-spacing` on Barlow body/control text. Tracking exists only on mono eyebrows (.14–.24em), the wordmark (.06em), display title bands (.08em) and avatar initials (.06em).
- Barlow Condensed below 600, except nowhere — the admin nav's 300 weight is Barlow (sans), not Condensed.

## 7. Tests

DevTools probe — run on a Cobalt page and a Ledger page and compare; every value should be equal except h2 colour and the §4 roles:

```js
[...document.querySelectorAll('.page-contents p, .page-contents h1, .page-contents h2, .page-contents h3, .page-contents li, .page-contents code, .page-sidebar-heading, .page-toc-item--d0, .page-toc-item--d1, .page-tag, .page-sidebar-revision')]
  .map(el => { const s = getComputedStyle(el); return [el.className || el.tagName, s.fontFamily.split(',')[0], s.fontSize, s.fontWeight, s.lineHeight, s.letterSpacing, s.color].join(' | ') })
```

Expected on Cobalt light: `P | Barlow | 15.5px | 400 | 26.66px | normal | rgb(26, 32, 56)`; `H1 | Barlow Condensed | 32px | 700 | … | rgb(26, 32, 56)`; `H2 | Barlow Condensed | 26px | 600 | 29.9px | normal | rgb(31, 79, 214)`; `page-sidebar-heading | Roboto Mono | 10px | 600 | … | 2px | rgb(90, 102, 153)`; `page-toc-item--d0 | Barlow | 13px | 500`; `page-tag | Barlow | 12px | 500 | … | rgb(26, 63, 176)`.

Extend the source-scan pattern of `cobaltTokens.test.js`:

- The `body.body--cobalt {` and `body.body--cobalt.body--dark {` blocks of `tailwind.css` contain no `--font-` declaration and no `font-size` / `font-weight` / `line-height` / `letter-spacing` / `text-transform`.
- Real-browser (pattern of `_page-contents.test.js`'s `measure()`): for `h1`, `h2`, `p`, `li` numeral, `code`, `pre code`, `.w-btn`, `.w-section-header` kicker, `.w-badge`, `.w-chip`, computed `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing` are equal across `body--cobalt` vs. default, and across `body--cobalt` vs. `body--cobalt body--dark`, except the four §4 roles — assert their Cobalt values from the table instead.
- Computed `fontWeight` of any element whose `fontFamily` starts with `Barlow Condensed` is ≥ 600.
- Computed `letterSpacing` is `normal` for every element whose `fontFamily` starts with `Barlow,` (the sans stack).
