# Cardinal wiki — design decisions (copy of the project CLAUDE.md)

## Source

Built from the `scarlett` branch of `dylan-hart/wiki` (Wiki.js 3.x: Vue 3 + Vite + Tailwind, in-repo `W*` component library). See `github.md` for the screen map. The 2.x-based files (page-view options board, old Ledger, Admin, Editor) are reference only — do not extend them.

## Design decisions to keep

- **Ledger** is the locked visual language: continuous light slate chrome, hairline borders, blueprint corner marks, Barlow Condensed over Barlow, Roboto Mono for metadata, one pastel cardinal red accent (#e4676b fills / #c14a52 for accent TEXT on white/paper, #a83f45 for links and accent text on the tinted #eef1f7 / #f0f2f7 strips) reserved for the live edge — active nav, primary action, alerts.
- **Light text tiers**: body #2f3a4f, secondary #4e5d7d, caption/faint #57668a. Nothing lighter than #57668a carries text on paper — #8a99b8 and #64789f are for hairlines, icon strokes and separators only. Positive text is #3f7a66, not the #5f9c86 fill.
- **Dark theme**: ink #14171f, panel #1b1f2a, raised #242b3a, hairline #2a3040, text #e6eaf2 / secondary #9aa6bd / faint #8792ab, slate-light #8ea6cf. The accent lightens to #f08287 and takes DARK ink on fills (white on it is under contrast); filled toasts darken (#3f7a66 / #a83f45) rather than lighten. See the dark primitives sheet.
- **Overlay sizing**: the inbox and profile overlays sit at 50% of the viewport, centred, content scrolling inside. The file manager and page history overlays stay near-full-bleed (24px scrim margin).
- **Public site (`Cardinal Site - *.dc.html`)**: cardinal.wiki marketing pages in the Ledger language. Primary buttons fill `#c14a52` with white (the repo's contrast divergence), selected segments fill `#e4676b` with ink. Status honesty is a rule: anything not in the repo yet carries a `Planned` badge and a dashed "proposed command shape" block, never a runnable-looking command. Import commands are the real `npm run migrate` / `verify-migration` flags from `backend/migration/source-args.ts` + `cli.ts`. Container image tag `ghcr.io/cardinal-wiki/cardinal:3` is a placeholder until a registry exists.
- **Page actions rail**: duplicate, rename/move and delete are NOT separate rail buttons. Fold them into the more (`...`) menu alongside rerender and backlinks. The rail keeps: page properties (primary), pending assets (editing only), history, export, more.

## Themes

Two themes ship. Filenames carry the theme suffix: `Cardinal Wiki - <Screen> 3x - Ledger.dc.html` (default, the brand) and `Cardinal Wiki - <Screen> 3x - Cobalt.dc.html` (the loud alternate).

- **Cobalt** is the alternate: solid cobalt top bar (#1f4fd6, white type and icons), deep-indigo sidebar (#10194a, active item cobalt with a 3px #ff4d5a inset bar), tinted ground #f2f5ff, white cards with 8px radius and `0 2px 10px rgba(16,25,74,.08)` shadow instead of hairlines and corner marks, gradient page banner (#1f4fd6 → #3d6df7). Accent red is #ff4d5a fills / #c8303c text; links are cobalt #1f4fd6. Body #1a2038, secondary #4a5580, faint #5a6699. h2 in cobalt with no rule. Code blocks #10194a, 8px radius. Dialogs and overlays (inbox, profile, history, file manager, table editor, block picker, menus, confirm) take a 12px radius with `overflow:hidden`; the side dialog rounds only its outer edge (12px 0 0 12px). No dark eyebrow bar on dialog tops — the rounded corner is the edge. No dark variant yet.
- Canonical Cobalt page view: `Cardinal Wiki - Page View 3x - Cobalt.dc.html` (locked from option 1a in `Cardinal Wiki - Theme Takes 3x.dc.html`). The other Cobalt screens were derived mechanically from the Ledger set and may need hand polish.
