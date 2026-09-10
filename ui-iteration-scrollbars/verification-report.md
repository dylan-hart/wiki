# Cross-browser verification: handoff-8 scrollbar treatment

OpenProject #3008. Verifies #3005 (Ledger `_base.scss`), #3006 (Cobalt `_base.scss`) and #3007
(per-surface reconciliation), all landed on `workcycle-merged-d3os1iayypeenntn336ajdh1ilsz` as of
this run.

## Method

Real stack, real browsers — not source reading:

- `npm run build` in `frontend/` against this branch's actual code, served by `node backend` against
  an ephemeral Postgres 18 container.
- A throwaway page (`/scrollbar-verify`) seeded with a long body, a 15-column table and a long code
  block, so every scrolling region in scope actually has something to scroll.
- Playwright **1.62.1** (the version pinned in `e2e/package.json` / `frontend/package.json`), driving
  real Chromium, Firefox and WebKit — not the frontend's own bundled test harness, since this needed
  the real production build rather than a dev/test build.
- **Gotcha hit and worked around:** Playwright's headless Chromium passes `--hide-scrollbars` by
  default, which suppresses scrollbar painting entirely (not even overlay renders) regardless of any
  other scrollbar-related flag. `ignoreDefaultArgs: ['--hide-scrollbars']` was required before any
  scrollbar — classic or overlay — showed up in a screenshot at all. Confirmed with a standalone
  `overflow:auto` repro before trusting any subsequent screenshot.
- The real page-level scroll region is `.page-container-scrl` (a `<w-scroll-area>`), not
  `window`/`document` — the app shell's header/rail stay fixed and only this inner region scrolls.
  Likewise the admin sidebar's real scroll region is `.admin-nav` (also a `<w-scroll-area>`) inside
  `.admin-sidebar`, not the drawer element itself.

## Chromium — high-fidelity check (spec requires exact match)

Classic (non-overlay) scrollbars, all three states (idle / hover / active-drag), both aesthetics,
both light and dark, against `Cardinal Wiki - Scrollbars 3x.dc.html`'s reference panes and
`scrollbars.md`'s literal colour values:

| Region | Ledger light | Ledger dark | Cobalt light | Cobalt dark |
| --- | --- | --- | --- | --- |
| Page scroll | ✅ idle #8a99b8/#f0f2f7, hover #57668a, active #e4676b | ✅ idle #3a4256/#14171f, active #f08287 | ✅ overlay pill, tint 0.28→0.5→solid, grows on hover/active | ✅ white-tint pill on dark ground |
| Wide table (`.table-scroll`) | ✅ blends into frame, subtler at rest per spec | not separately screenshotted (same token mechanism) | ✅ blends into Cobalt's own page ground | ✅ |
| Code block | ✅ dark-ground pair (`.body--ledger .code-block` selector) even in light mode | ✅ | ✅ white-tint pill (dark-ground selector includes `.page-contents pre`) | ✅ |
| `.sidebar-nav` (reader nav) | not overflowing in this fixture (single-page test site — no content depth) | — | ✅ white-tint pill, dark-ground selector matches | — |
| `.admin-sidebar` / `.admin-nav` | ❌ **see finding below** — plain light-mode Ledger colours on the sidebar's always-dark ink ground | ✅ (dark mode already resolves the dark-ground pair regardless) | ✅ white-tint pill, correct | ✅ |

Gutter widths matched spec (12px Ledger classic gutter with reserved track space; Cobalt's 14px
overlay pill with no track fill) in every screenshot checked.

## Firefox / WebKit — accepted-degradation check

Both engines render a thin, correctly-tinted bar via `scrollbar-color` alone, with no hover growth
and no drag colour change, in every aesthetic/mode combination checked. This reads as an intentional
minimal treatment, not as broken chrome — matches the handoff's own "accepted degradation" framing.

## macOS overlay scrollbars ("when scrolling") — not mechanically verifiable in this environment

Playwright's headless Chromium did not visibly distinguish an "overlay" launch (default args, no
`--disable-features=OverlayScrollbar`) from the "classic" one once `--hide-scrollbars` was stripped
from both — both rendered the same persistent, reserved-gutter scrollbar in this headless/sandboxed
environment, which means this environment cannot reproduce macOS's own system-level "always show" vs
"when scrolling" preference distinctly. This specific sub-check needs a human with a real, windowed
macOS Chromium (or Safari) session with that system preference toggled, per the epic coordination
note's own call-out.

Reasoned rather than left unaddressed: the shipped CSS only targets `::-webkit-scrollbar*`
pseudo-elements. Blink does not generate those boxes at all when the platform is in overlay mode —
there is no selector for our rules to match, so there is no code path in `_base.scss` by which this
treatment could turn a "when scrolling" overlay bar into a persistent one. This is standard,
well-documented Chromium behaviour, not something either #3005 or #3006's CSS could have broken.

## Finding: Ledger's `.admin-sidebar` scrollbar (filed as OpenProject #3020)

`.admin-sidebar` is drawn on ink in *every* aesthetic by explicit design
(`AdminLayout.vue`'s own header comment: "The admin sidebar is drawn on INK in both themes -- it is
the one column in the app that always is"), and Cobalt's own `_base.scss` block correctly lists it
in its dark-ground selector set. Ledger's equivalent block, however, only widens to
`.body--ledger.body--dark` and `.body--ledger .code-block` — `.admin-sidebar` was left off, so in
Ledger **light** mode the admin nav's scroll region (`.admin-nav`) paints the plain light-mode
Ledger thumb/track (`#8a99b8` / `#f0f2f7`) against the sidebar's dark ink background: a visible pale
rectangle seam rather than a blended dark-ground scrollbar. Ledger dark mode is unaffected (the
`.body--ledger.body--dark` selector already covers it). `.sidebar-nav` (the reader-facing nav) is
*not* affected — its background is theme/site-configurable, not fixed dark, and Ledger's own default
is light, confirmed with no contrast issue in testing.

Filed as a Bug (OpenProject #3020, child of Epic #3004) with the exact selector-list fix, rather than
patched here — #3008 is verification-only per the epic coordination note's file-ownership split.

## Screenshots

144 screenshots across the full aesthetic × dark × engine × region matrix were captured during this
run and sent directly to Dylan rather than committed to the repo as binaries. Representative frames
(Ledger light idle/hover/active 3-state, Cobalt light idle/hover/active, Firefox/WebKit degraded
state, and the `.admin-sidebar` finding) are called out by name in the completion comment on #3008.
