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

/**
 * Per-aesthetic FIXED status color defaults (OpenProject #2814, resolving a gap deferred by Feature
 * #2763/#2772's own logging -- `docs/cobalt-mockup-diff-signoff.md`'s "Frozen-primitive gaps").
 *
 * `colorPositive`/`colorNegative`/`colorInfo`/`colorWarning` back the `--q-positive`/`-negative`/
 * `-info`/`-warning` custom properties `composables/notify.js`'s toast presets (and any `bg-positive`/
 * `text-info`/... utility) resolve through. Unlike `AESTHETIC_DEFAULT_COLORS` above, these are NOT
 * admin-editable -- there is no `colorPositive`/etc. column on `backend/models/sites.ts`'s theme
 * shape and no color picker for them in `AdminTheme.vue`'s Appearance card, which is exactly why
 * `App.vue#applyTheme()` used to carry `positive`/`negative` as hardcoded literals rather than read
 * them off `siteStore.theme`. That is also why this is a SEPARATE map/accessor rather than four more
 * keys folded into `AESTHETIC_DEFAULT_COLORS`: `AdminTheme.vue#resetColors()` spreads that map's
 * return straight onto `state.config`, the payload a theme save PUTs to the backend, and a key with
 * no matching theme column would round-trip as silently-dropped dead weight in every saved theme.
 *
 * `App.vue#applyTheme()` is the sole consumer, keyed off the just-resolved `aesthetic.current`
 * (ledger/cobalt) rather than site config, and still runs each value through
 * `userStore.getAccessibleColor()` for colour-vision-deficiency remapping -- `helpers/accessibility.js`'s
 * CVD tables carry no `info`/`warning` entries (only `positive`/`negative` did before this), so those
 * two pass through unchanged for now, same as any other name the tables don't list.
 *
 * Ledger's values are unchanged from `css/tailwind.css`'s existing `:root` `--q-*` defaults and from
 * `App.vue`'s own pre-#2814 hardcoded literals for positive/negative. Cobalt's are
 * `ui-redesign-cobalt/HANDOFF.md`'s light-mode figures: "Positive text / fill" (the darker, white-
 * safe TEXT tone -- `#177a5e`, 5.27:1 on white), "Accent fill carrying WHITE text" for negative
 * (Cobalt's own accent -- `#c8303c`, 5.32:1 -- exactly as Ledger's own `--q-negative` already equals
 * `--q-accent`), "Info toast" (`#1e2a5e`, 13.57:1), and warning's own "the amber warning keeps
 * `#d9a441`" note -- unchanged from Ledger, 7.41:1 on Cobalt's `--color-ink` under the same dark-ink
 * (not white) label `notify.js`'s `warning` preset already draws. Dark-mode-specific Cobalt toast
 * swatches exist in the handoff (`Primitives Dark 3x - Cobalt.dc.html`) but the `--q-*` architecture
 * has no dark-specific override slot yet (see `css/tailwind.css`'s own note by `--q-header`), so,
 * like every other `--q-*` token, this seeds one Cobalt value used in both light and dark -- left for
 * future work alongside that same gap, not silently guessed at here.
 */
export const AESTHETIC_STATUS_COLORS = {
  ledger: {
    colorPositive: '#3f7a66',
    colorNegative: '#c14a52',
    colorInfo: '#38465f',
    colorWarning: '#d9a441'
  },
  cobalt: {
    colorPositive: '#177a5e',
    colorNegative: '#c8303c',
    colorInfo: '#1e2a5e',
    colorWarning: '#d9a441'
  }
}

/**
 * The fixed status-color defaults for one aesthetic. Falls back to `ledger` for an unknown or
 * missing value, same convention as `aestheticDefaultColors()` above.
 *
 * @param {'ledger'|'cobalt'|undefined} aesthetic
 * @returns {{ colorPositive: string, colorNegative: string, colorInfo: string, colorWarning: string }}
 */
export function aestheticStatusColors(aesthetic) {
  return AESTHETIC_STATUS_COLORS[aesthetic] ?? AESTHETIC_STATUS_COLORS.ledger
}
