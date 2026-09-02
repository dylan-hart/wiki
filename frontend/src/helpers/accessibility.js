/**
 * Curated substitutes for every themeable color, keyed by the same name `AdminTheme.vue` uses for
 * `theme.color<Name>` (`primary`, `secondary`, `accent`, `header`, `sidebar`) plus the two fixed
 * status colors (`positive`, `negative`) that are never site-configurable. This is a palette swap,
 * not a simulation of what a CVD viewer would see of the site's own chosen color -- the site admin's
 * pick is discarded entirely for whichever mode is active, in favor of a color chosen to stay
 * distinguishable from its neighbors on that same page (mainly `primary`/`secondary`/`sidebar`,
 * which otherwise all render as close variants of the same hue) and, for `header`/`sidebar`, to stay
 * dark enough for the white text drawn over it.
 *
 * `protanopia` and `deuteranopia` (both red-green deficiencies) get the same substitutes: the
 * confusion axis is the same, so a palette that avoids reds/greens for one avoids it for the other.
 * `tritanopia` (blue-yellow) needs a different set, since blue -- the one hue the red-green modes see
 * fine -- is exactly what it confuses with yellow/green.
 */
const protanopia = {
  accent: '#0091EA',
  header: '#0D47A1',
  negative: '#fb8c00',
  positive: '#2196f3',
  primary: '#1976D2',
  secondary: '#2196f3',
  sidebar: '#1565C0'
}

const deuteranopia = {
  accent: '#0091EA',
  header: '#0D47A1',
  negative: '#ef6c00',
  positive: '#2196f3',
  primary: '#1976D2',
  secondary: '#2196f3',
  sidebar: '#1565C0'
}

const tritanopia = {
  accent: '#d32f2f',
  header: '#263238',
  primary: '#e91e63',
  secondary: '#02C39A',
  sidebar: '#00695C'
}

/**
 * Substitutes `base` with a CVD-safe color for `cvd`, when the CVD table for that mode names one for
 * `name`. Falls through to `base` unchanged for `cvd: 'none'`, an unrecognized `cvd`, or a `name` the
 * table has no entry for.
 */
export function getAccessibleColor(name, base, cvd) {
  switch (cvd) {
    case 'protanopia': {
      return protanopia[name] ?? base
    }
    case 'deuteranopia': {
      return deuteranopia[name] ?? base
    }
    case 'tritanopia': {
      return tritanopia[name] ?? base
    }
  }
  return base
}

/**
 * Expands a 3-digit hex color (`#abc` or `abc`) to 6 digits (`aabbcc`), leaving an already-6-digit
 * color (with or without its leading `#`) untouched. Bare hex, no `#`, is returned either way.
 */
function normalizeHex(hex) {
  const stripped = (hex || '').replace('#', '')
  if (stripped.length === 3) {
    return stripped
      .split('')
      .map((c) => c + c)
      .join('')
  }
  return stripped
}

/**
 * WCAG 2.x relative luminance of a hex color, per
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function relativeLuminance(hex) {
  const normalized = normalizeHex(hex)
  const channel = (start) => {
    const value = Number.parseInt(normalized.slice(start, start + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/**
 * WCAG 2.x contrast ratio between two hex colors, per
 * https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio -- always >= 1, order of the two arguments does
 * not matter.
 */
export function contrastRatio(hexA, hexB) {
  const lumA = relativeLuminance(hexA)
  const lumB = relativeLuminance(hexB)
  const lighter = Math.max(lumA, lumB)
  const darker = Math.min(lumA, lumB)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * The WCAG 2.x AA threshold for normal-weight text (4.5:1). Large/bold text's 3:1 threshold isn't
 * used anywhere in this codebase's contrast checks, so it isn't exported here.
 */
export const WCAG_AA_CONTRAST = 4.5
