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
 * The two status colours, which are NOT administrator-editable and so are not part of the four
 * above -- `App.vue` writes them straight onto `--q-positive`/`--q-negative` so the colour-vision-
 * deficiency remapping still reaches them. Each aesthetic keeps the TEXT tone of its own pair
 * (`#3f7a66`/`#c14a52` in Ledger, `#177a5e`/`#c8303c` in Cobalt), because both are drawn under a
 * white label here -- a toast, a solid button -- and the brighter fills they pair with
 * (`--color-positive-fill` / `--color-negative-fill`) are separate tokens nothing resolves through
 * this path.
 */
export const AESTHETIC_STATUS_COLORS = {
  ledger: {
    colorPositive: '#3f7a66',
    colorNegative: '#c14a52'
  },
  cobalt: {
    colorPositive: '#177a5e',
    colorNegative: '#c8303c'
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
 * The chrome colors that change again on a dark ground.
 *
 * Cobalt's header bar deepens one step on dark (`#1a43bd`, "to cut glare" -- the handoff's own
 * Surfaces table) and its sidebar drops to `#0e1540`; nothing else about the aesthetic moves between
 * light and dark that a token in `css/tailwind.css` does not already carry. Ledger has no entry here
 * at all: its header and sidebar are the app's ordinary light chrome, and its dark theme repaints
 * them through `dark:` utilities rather than through the `--q-*` brand colors.
 */
const AESTHETIC_DARK_CHROME = {
  cobalt: {
    colorHeader: '#1a43bd',
    colorSidebar: '#0e1540'
  }
}

/**
 * The four `--q-*` brand colors to actually paint with, for one RESOLVED aesthetic.
 *
 * `resetColors()` only reaches a site whose administrator opens AdminTheme and saves, and the
 * aesthetic is not only a site setting: a reader can pick Cobalt for themselves
 * (`users.prefs.aesthetic`) on a site whose stored `colorHeader` is Ledger's `#ffffff`. Left to the
 * stored value alone that reader gets Cobalt's indigo sidebar text on Ledger's near-white sidebar
 * ground -- unreadable, and nothing the administrator could have prevented.
 *
 * So a stored color that is still some aesthetic's own DEFAULT is treated as "not chosen" and
 * follows the resolved aesthetic; a color the administrator actually picked is left exactly as
 * saved. Compared case-insensitively against every aesthetic's defaults, not just the current one,
 * because the site's stored value is whichever aesthetic it was seeded or last reset under.
 *
 * @param {'ledger'|'cobalt'|undefined} aesthetic The resolved aesthetic (site or user override).
 * @param {Record<string, string>} stored The site's saved `colorPrimary`/`colorAccent`/`colorHeader`/`colorSidebar`.
 * @returns {Record<string, string>} The same four keys, with untouched defaults moved onto `aesthetic`.
 */
export function resolveAestheticColors(aesthetic, stored, dark = false) {
  const target = {
    ...aestheticDefaultColors(aesthetic),
    ...(AESTHETIC_STATUS_COLORS[aesthetic] ?? AESTHETIC_STATUS_COLORS.ledger)
  }
  const darkChrome = (dark && AESTHETIC_DARK_CHROME[aesthetic]) || {}
  const out = {}
  for (const key of Object.keys(target)) {
    const value = stored?.[key]
    const isUntouchedDefault =
      !value ||
      Object.values(AESTHETIC_DEFAULT_COLORS).some(
        (defaults) => defaults[key]?.toLowerCase() === String(value).toLowerCase()
      )
    out[key] = isUntouchedDefault ? (darkChrome[key] ?? target[key]) : value
  }
  return out
}
