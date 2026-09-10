# Scrollbars — Ledger + Cobalt, light + dark

Board: `Cardinal Wiki - Scrollbars 3x.dc.html`. Apply globally per theme body class; every scrolling region inherits (page, sidebar, overlays, code blocks, tables). No arrow buttons in either theme.

## Ledger
A ruled margin: 12px gutter, 1px hairline on the inner edge, square thumb filling the gutter edge to edge (no inset). Dark thumb on light track in light mode, a muted lighter thumb on the dark track in dark mode; one tone stronger on hover, cardinal only while dragging.

```css
@supports not selector(::-webkit-scrollbar) { .body--ledger { scrollbar-width: thin; scrollbar-color: #8a99b8 #f0f2f7; } }
.body--ledger ::-webkit-scrollbar { width: 12px; height: 12px; }
.body--ledger ::-webkit-scrollbar-track { background: #f0f2f7; border-left: 1px solid #dbe1ec; }
.body--ledger ::-webkit-scrollbar-track:horizontal { border-left: 0; border-top: 1px solid #dbe1ec; }
.body--ledger ::-webkit-scrollbar-thumb { background: #8a99b8; border: 0; border-radius: 0; }
.body--ledger ::-webkit-scrollbar-thumb:hover { background: #57668a; }
.body--ledger ::-webkit-scrollbar-thumb:active { background: #e4676b; }
.body--ledger ::-webkit-scrollbar-corner { background: #f0f2f7; }
.body--ledger ::-webkit-scrollbar-button { display: none; }

/* dark, and any Ledger surface on ink (#1c2233 code blocks) */
@supports not selector(::-webkit-scrollbar) { .body--ledger.body--dark, .body--ledger .code-block { scrollbar-color: #3a4256 #14171f; } }
.body--ledger.body--dark ::-webkit-scrollbar-track, .body--ledger .code-block::-webkit-scrollbar-track { background: #14171f; border-color: #2a3040; }
.body--ledger.body--dark ::-webkit-scrollbar-thumb, .body--ledger .code-block::-webkit-scrollbar-thumb { background: #3a4256; }
.body--ledger.body--dark ::-webkit-scrollbar-thumb:hover, .body--ledger .code-block::-webkit-scrollbar-thumb:hover { background: #4e5870; }
.body--ledger.body--dark ::-webkit-scrollbar-thumb:active, .body--ledger .code-block::-webkit-scrollbar-thumb:active { background: #f08287; }
.body--ledger.body--dark ::-webkit-scrollbar-corner, .body--ledger .code-block::-webkit-scrollbar-corner { background: #14171f; }
```

## Cobalt
Overlay pill, no track, no rule (consistent with the no-hairline rule). 14px gutter, 8px thumb that grows to 10px and deepens on hover/drag. Cobalt tint on light ground, white tint on dark ground; the dark-ground set applies to the sidebar, code blocks and dark mode.

```css
@supports not selector(::-webkit-scrollbar) { .body--cobalt { scrollbar-width: thin; scrollbar-color: rgba(31,79,214,.28) transparent; } }
.body--cobalt ::-webkit-scrollbar { width: 14px; height: 14px; }
.body--cobalt ::-webkit-scrollbar-track, .body--cobalt ::-webkit-scrollbar-corner { background: transparent; }
.body--cobalt ::-webkit-scrollbar-thumb { background: rgba(31,79,214,.28); border: 3px solid transparent; background-clip: padding-box; border-radius: 999px; }
.body--cobalt ::-webkit-scrollbar-thumb:hover { background-color: rgba(31,79,214,.5); border-width: 2px; }
.body--cobalt ::-webkit-scrollbar-thumb:active { background-color: #1f4fd6; border-width: 2px; }
.body--cobalt ::-webkit-scrollbar-button { display: none; }

/* dark ground: sidebar, code blocks, dark mode */
@supports not selector(::-webkit-scrollbar) { .body--cobalt.body--dark, .body--cobalt .sidebar, .body--cobalt .code-block { scrollbar-color: rgba(255,255,255,.22) transparent; } }
.body--cobalt.body--dark ::-webkit-scrollbar-thumb, .body--cobalt .sidebar ::-webkit-scrollbar-thumb, .body--cobalt .code-block::-webkit-scrollbar-thumb { background-color: rgba(255,255,255,.22); }
.body--cobalt.body--dark ::-webkit-scrollbar-thumb:hover, .body--cobalt .sidebar ::-webkit-scrollbar-thumb:hover, .body--cobalt .code-block::-webkit-scrollbar-thumb:hover { background-color: rgba(143,176,255,.6); }
.body--cobalt.body--dark ::-webkit-scrollbar-thumb:active, .body--cobalt .sidebar ::-webkit-scrollbar-thumb:active, .body--cobalt .code-block::-webkit-scrollbar-thumb:active { background-color: #8fb0ff; }
```

**Important:** Chromium 121+ ignores every `::-webkit-scrollbar*` rule on an element where `scrollbar-width` or `scrollbar-color` is non-auto. The standard properties are therefore wrapped in `@supports not selector(::-webkit-scrollbar)` so only non-WebKit engines see them. Firefox and Safari 18.2+ honour `scrollbar-width`/`scrollbar-color` only (thin, no hover growth, no drag colour); that degradation is accepted. macOS overlay scrollbars stay native when "show scrollbars: when scrolling" is on — Chromium only paints these when the bar is persistent.
