# Cardinal wiki — project notes

## Source

Built from the `scarlett` branch of `dylan-hart/wiki` (Cardinal.js 3.x, the Wiki.js 3.x fork: Vue 3 + Vite + Tailwind, in-repo `W*` component library). See `github.md` for the screen map. The 2.x-based files (page-view options board, old Ledger, Admin, Editor) are reference only — do not extend them.

## Design decisions to keep

- **Ledger** is the locked visual language: continuous light slate chrome, hairline borders, blueprint corner marks, Barlow Condensed over Barlow, Roboto Mono for metadata, one pastel cardinal red accent (#e4676b fills / #c14a52 for accent TEXT on white/paper, #a83f45 for links and accent text on the tinted #eef1f7 / #f0f2f7 strips) reserved for the live edge — active nav, primary action, alerts.
- **Light text tiers**: body #2f3a4f, secondary #4e5d7d, caption/faint #57668a. Nothing lighter than #57668a carries text on paper — #8a99b8 and #64789f are for hairlines, icon strokes and separators only. Positive text is #3f7a66, not the #5f9c86 fill.
- **Dark theme**: ink #14171f, panel #1b1f2a, raised #242b3a, hairline #2a3040, text #e6eaf2 / secondary #9aa6bd / faint #8792ab, slate-light #8ea6cf. The accent lightens to #f08287 and takes DARK ink on fills (white on it is under contrast); filled toasts darken (#3f7a66 / #a83f45) rather than lighten. See the dark primitives sheet.
- **Overlay sizing**: the inbox and profile overlays sit at 50% of the viewport, centred, content scrolling inside. The file manager and page history overlays stay near-full-bleed (24px scrim margin).
- **Page actions rail**: duplicate, rename/move and delete are NOT separate rail buttons. Fold them into the more (`...`) menu alongside rerender and backlinks. The rail keeps: page properties (primary), pending assets (editing only), history, export, more.
