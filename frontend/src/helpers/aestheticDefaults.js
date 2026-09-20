/**
 * The four admin-editable `--q-*` brand colors (`AdminTheme.vue`'s Appearance card), per aesthetic,
 * so that switching aesthetic visibly resets the color pickers before save -- `resetColors()` is
 * the sole consumer.
 *
 * `colorSecondary` and `dark` are deliberately excluded: the site's positive color does not move
 * with an aesthetic switch, and dark mode is an orthogonal axis, so both keep being reset to their
 * single existing default.
 *
 * `backend/models/sites.ts`'s `DEFAULT_THEME_COLORS` seed pins the same `ledger` literals
 * separately -- the two are independently-installed workspaces with no import between them, so each
 * side pins its own copy in its own tests.
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

export function aestheticDefaultColors(aesthetic) {
  return AESTHETIC_DEFAULT_COLORS[aesthetic] ?? AESTHETIC_DEFAULT_COLORS.ledger
}

/**
 * The FIXED status colors behind `--q-positive`/`-negative`/`-info`/`-warning`, per aesthetic.
 * Unlike `AESTHETIC_DEFAULT_COLORS` these are not admin-editable -- no theme column, no picker --
 * which is why they are a separate map rather than four more keys in that one: `resetColors()`
 * spreads it straight onto the payload a theme save PUTs, and a key with no matching theme column
 * would round-trip as silently-dropped dead weight in every saved theme.
 *
 * `helpers/accessibility.js`'s CVD tables carry no `info`/`warning` entries, so those two pass
 * through the colour-vision remapping unchanged, like any other name the tables don't list. One
 * Cobalt value serves both light and dark, since the `--q-*` layer has no dark-specific override
 * slot.
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

export function aestheticStatusColors(aesthetic) {
  return AESTHETIC_STATUS_COLORS[aesthetic] ?? AESTHETIC_STATUS_COLORS.ledger
}

/**
 * The chrome colors that change again on a dark ground: Cobalt's header deepens a step to cut
 * glare and its sidebar drops further. Ledger has no entry because its dark theme repaints header
 * and sidebar through `dark:` utilities rather than through the `--q-*` brand colors.
 */
const AESTHETIC_DARK_CHROME = {
  cobalt: {
    colorHeader: '#1a43bd',
    colorSidebar: '#0e1540'
  }
}

/**
 * The aesthetic is not only a site setting: a reader can pick Cobalt for themselves on a site whose
 * stored `colorHeader` is Ledger's `#ffffff`, and left to the stored value alone would get Cobalt's
 * indigo sidebar text on Ledger's near-white ground -- unreadable, and nothing the administrator
 * could have prevented.
 *
 * So a stored color still equal to some aesthetic's own DEFAULT counts as "not chosen" and follows
 * the resolved aesthetic, while one the administrator actually picked is left exactly as saved.
 * Compared case-insensitively against every aesthetic's defaults, not just the current one, because
 * the stored value is whichever aesthetic the site was seeded or last reset under.
 *
 * @param {'ledger'|'cobalt'|undefined} aesthetic The resolved aesthetic (site or user override).
 * @param {Record<string, string>} stored The site's saved brand colors.
 */
export function resolveAestheticColors(aesthetic, stored, dark = false) {
  const target = { ...aestheticDefaultColors(aesthetic), ...aestheticStatusColors(aesthetic) }
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
