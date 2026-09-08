/**
 * Monaco's themes, one per aesthetic.
 *
 * Monaco is the one surface in the app the design-token layer cannot reach: `defineTheme()` takes
 * plain hex strings and never resolves a CSS custom property, so an aesthetic cannot be applied by
 * re-resolving a variable the way every other surface does (`ui-redesign-cobalt/HANDOFF.md`,
 * "Architecture"). It has to be applied by registering a second theme and SWITCHING to it.
 *
 * Seven surfaces mount Monaco and each registers its own ground (`monacoThemeId.test.js` documents
 * why the registration is repeated per component). Rather than hand-writing a Cobalt twin of each,
 * `defineMonacoThemes` derives one: every colour a Ledger theme names is looked up in the table
 * below and replaced with Cobalt's answer for the same ROLE, so a surface keeps its own shape --
 * which rung it sits on, whether its gutter is above or below its text ground -- while moving onto
 * the other aesthetic's ramp. A colour with no entry is passed through unchanged, which is correct
 * for the ones that are not aesthetic at all (a diff's red and green, `#fff`).
 *
 * The two ids are separate registrations rather than one re-registered id because Monaco's registry
 * is global and a surface may be the first to mount: re-defining one id would make whichever
 * component mounted last decide the aesthetic for all of them.
 */

export const MONACO_THEME_LEDGER = 'cardinaljs'
export const MONACO_THEME_COBALT = 'cardinaljs-cobalt'

/**
 * Ledger tone -> Cobalt tone, by the role each plays in an editor surface.
 *
 * Grounds map onto Cobalt's own dark ramp (`#141c4f` card, `#0b1238` the well a gutter sits in,
 * `#1c2a70` the raised rung a line highlight uses); the accent pair keeps the handoff's fill/text
 * split (`#ff4d5a` untexted, `#c8303c` under a label); the chrome and syntax tones are the two
 * `Editor 3x - Cobalt` draws its own markdown source in.
 */
const COBALT_TONE = {
  // -- Grounds
  '#070a0d': '#0b1238',
  '#0d1117': '#141c4f',
  '#11141b': '#0b1238',
  '#14171f': '#0b1238',
  '#171b24': '#141c4f',
  '#1b1f2a': '#141c4f',
  '#1e2431': '#1c2a70',
  '#242b3a': '#1c2a70',
  // -- Foregrounds and chrome
  '#c3cee2': '#e8ecff',
  '#546e7a': '#3f4a63',
  '#8ea6cf': '#8fb0ff',
  '#8792ab': '#8b98d6',
  '#9aa6bd': '#a7b3ea',
  '#a9b7d0': '#c5cff5',
  // -- The live edge
  '#f08287': '#ff7a84',
  '#e4676b': '#ff4d5a',
  '#c14a52': '#c8303c',
  // -- Status
  '#3f7a66': '#22a37f'
}

function cobaltTone(value) {
  if (typeof value !== 'string') {
    return value
  }
  // -> `rules[].foreground` is written without the `#`; `colors` values carry it
  const bare = value.startsWith('#')
  const mapped = COBALT_TONE[(bare ? value : `#${value}`).toLowerCase()]
  if (!mapped) {
    return value
  }
  return bare ? mapped : mapped.slice(1)
}

/**
 * Registers both aesthetics' themes from one Ledger definition.
 *
 * @param {typeof import('monaco-editor')} monaco
 * @param {{ base: string, inherit: boolean, rules: Array, colors: Record<string, string> }} theme
 *   The surface's own Ledger theme, exactly as it would have passed to `defineTheme` before.
 */
export function defineMonacoThemes(monaco, theme) {
  monaco.editor.defineTheme(MONACO_THEME_LEDGER, theme)
  monaco.editor.defineTheme(MONACO_THEME_COBALT, {
    ...theme,
    rules: (theme.rules ?? []).map((rule) => ({
      ...rule,
      foreground: cobaltTone(rule.foreground)
    })),
    colors: Object.fromEntries(
      Object.entries(theme.colors ?? {}).map(([key, value]) => [key, cobaltTone(value)])
    )
  })
}

/**
 * Which of the two a surface should mount with, and switch to when the reader changes aesthetic.
 *
 * @param {'ledger'|'cobalt'} aesthetic The resolved aesthetic (`composables/aesthetic.js`).
 */
export function monacoThemeName(aesthetic) {
  return aesthetic === 'cobalt' ? MONACO_THEME_COBALT : MONACO_THEME_LEDGER
}
