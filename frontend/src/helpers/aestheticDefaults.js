/**
 * Per-aesthetic admin-editable color defaults (OpenProject #2768).
 *
 * `colorPrimary` / `colorAccent` / `colorHeader` / `colorSidebar` are the four admin-editable
 * `--q-*` brand colors (`AdminTheme.vue`'s Appearance card, `helpers/cssVars.js`). Each aesthetic
 * (`composables/aesthetic.js`) ships its own defaults for these four so that switching aesthetic
 * visibly resets the color pickers before save (`AdminTheme.vue`'s `resetColors()`, the sole
 * consumer). Ledger's values are Cardinal's existing brand -- already live in `css/tailwind.css`'s
 * `:root` block and `backend/models/sites.ts`'s `DEFAULT_THEME_COLORS`. Cobalt's are
 * `ui-redesign-cobalt/HANDOFF.md`'s "Primary color (admin default `colorPrimary`)", "Accent fill
 * carrying WHITE text", "Header bar" and "Sidebar ground" rows -- the same literals
 * `css/cobaltTokens.test.js` pins for the token layer's own (non-admin-configurable) chrome colors.
 *
 * Deliberately excludes `colorSecondary` and `dark`: the HANDOFF's per-aesthetic substitution never
 * calls for the site's positive color to move with the aesthetic switch, and dark mode is a wholly
 * separate, orthogonal axis (`composables/dark.js`) that a color-defaults reset does not touch --
 * both keep being reset to their single existing default in `resetColors()`.
 *
 * A fresh site is always seeded on the `ledger` aesthetic (`backend/models/sites.ts`), so its
 * `DEFAULT_THEME_COLORS` seed already agrees with `AESTHETIC_DEFAULT_COLORS.ledger` below with no
 * cross-workspace import needed (`backend/` and `frontend/` are independently-installed workspaces);
 * each side pins its own literal in its own tests, matching the existing `sites.test.ts` pattern.
 */
export const AESTHETIC_DEFAULT_COLORS = {
  ledger: {
    colorPrimary: '#c14a52',
    colorAccent: '#c14a52',
    colorHeader: '#ffffff',
    colorSidebar: '#f0f2f7'
  },
  cobalt: {
    colorPrimary: '#1f4fd6',
    colorAccent: '#c8303c',
    colorHeader: '#1f4fd6',
    colorSidebar: '#10194a'
  }
}

/**
 * The admin-editable color defaults for one aesthetic. Falls back to `ledger` for an unknown or
 * missing value -- `state.config.aesthetic` reads as `undefined` until OpenProject #2769 adds the
 * Aesthetic setting row that actually populates it, and a site should not be left with no answer at
 * all in the meantime.
 *
 * @param {'ledger'|'cobalt'|undefined} aesthetic
 * @returns {{ colorPrimary: string, colorAccent: string, colorHeader: string, colorSidebar: string }}
 */
export function aestheticDefaultColors(aesthetic) {
  return AESTHETIC_DEFAULT_COLORS[aesthetic] ?? AESTHETIC_DEFAULT_COLORS.ledger
}
