/**
 * A palette swap, not a simulation of what a CVD viewer would see of the site's own color: the
 * admin's pick is discarded entirely for whichever mode is active, in favor of a color chosen to
 * stay distinguishable from its neighbors on the same page (`primary`/`secondary`/`sidebar`
 * otherwise render as close variants of one hue) and, for `header`/`sidebar`, dark enough for the
 * white text drawn over it.
 *
 * Both red-green deficiencies share one table -- the confusion axis is the same, so a palette that
 * avoids reds and greens for one avoids it for the other. `tritanopia` (blue-yellow) needs its own,
 * since blue, the one hue the red-green modes see fine, is exactly what it confuses.
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

/** Returns bare 6-digit hex, no `#`, expanding the 3-digit shorthand. */
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

/** WCAG 2.x, per https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio -- always >= 1, order-agnostic. */
export function contrastRatio(hexA, hexB) {
  const lumA = relativeLuminance(hexA)
  const lumB = relativeLuminance(hexB)
  const lighter = Math.max(lumA, lumB)
  const darker = Math.min(lumA, lumB)
  return (lighter + 0.05) / (darker + 0.05)
}

/** The AA threshold for normal-weight text; large/bold text's 3:1 is unused here. */
export const WCAG_AA_CONTRAST = 4.5
