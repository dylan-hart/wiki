import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountEditorMarkdown } from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

// -> Same stand-in every EditorMarkdown suite installs; see `EditorMarkdown.lifecycle.test.js`.
vi.mock('y-monaco', () => ({ MonacoBinding: vi.fn() }))

const monaco = await import('monaco-editor')
const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

/*
  Monaco draws its own chrome, so the parts of `ui-redesign/Cardinal Wiki - Editor 3x.dc.html` that
  fall inside the source pane -- the code ground, the line-number gutter, the caret, the current-line
  band, the code lens and the markdown token ramp -- are settled by a THEME, not by any CSS this
  component could write. That makes the theme object the only reviewable artifact for those values,
  which is what this suite pins: every colour below is read straight off the design file.

  Companion to `editorScreenChrome.test.js`, which does the same job for everything drawn around
  Monaco rather than inside it (OpenProject #2624).
*/
describe('EditorMarkdown Monaco theme, against Cardinal Wiki - Editor 3x.dc.html', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /*
    Two themes are registered on mount now, one per aesthetic (`helpers/monacoTheme.js`): the Ledger
    definition this suite pins, and the Cobalt one derived from it. `definedTheme()` returns the
    Ledger half, which is the one the design file below settles; `definedTheme('cobalt')` returns
    the derivation, asserted once at the end against `Editor 3x - Cobalt`.
  */
  async function definedTheme(aesthetic = 'ledger') {
    await mountEditorMarkdown(EditorMarkdown, '# Prerequisites\n')
    const calls = monaco.editor.defineTheme.mock.calls
    expect(calls.length, 'the component defines both aesthetics’ themes on mount').toBe(2)
    const call = aesthetic === 'cobalt' ? calls[1] : calls[0]
    return { name: call[0], theme: call[1] }
  }

  it('registers itself under the name the editor is then created with', async () => {
    const { name, theme } = await definedTheme()
    expect(name).toBe('cardinaljs')
    expect(theme.base).toBe('vs-dark')
    expect(monaco.editor.create.mock.calls[0][1].theme).toBe(name)
  })

  /*
    The mock's line 136 puts `#14171f` on the line-number CELL and leaves the column behind the text
    on its parent's `#171b24`. Those two were the wrong way round here until #2624, which read as the
    gutter being the lighter of the pair -- the opposite of the recess the design draws.
  */
  it('grounds the text column one rung above the gutter, not below it', async () => {
    const { theme } = await definedTheme()
    expect(theme.colors['editor.background']).toBe('#171b24')
    expect(theme.colors['editorGutter.background']).toBe('#14171f')
  })

  it('takes the design’s foreground, current-line band and line-number tones', async () => {
    const { theme } = await definedTheme()
    expect(theme.colors['editor.foreground']).toBe('#c3cee2')
    expect(theme.colors['editor.lineHighlightBackground']).toBe('#1e2431')
    expect(theme.colors['editorLineNumber.foreground']).toBe('#3f4a63')
    // -> The design marks the caret's own line by reddening its number, not by a gutter fill
    expect(theme.colors['editorLineNumber.activeForeground']).toBe('#c14a52')
  })

  it('draws the caret in the accent and the code lens in the positive tone', async () => {
    const { theme } = await definedTheme()
    expect(theme.colors['editorCursor.foreground']).toBe('#e4676b')
    // -> "Edit block parameters" over the fenced block, line 152 of the design file
    expect(theme.colors['editorCodeLens.foreground']).toBe('#3f7a66')
  })

  /*
    Left as `rules: []` the editor inherited `vs-dark`'s own blues and oranges, which are nowhere in
    this language -- the one surface of the app that visibly belonged to a different product. Token
    names are Monarch's, from `monaco-editor`'s markdown grammar; a theme rule matches by prefix, so
    these bare names cover the `.md` postfix that grammar appends.
  */
  it('colours every markdown token the design spells out, rather than inheriting vs-dark', async () => {
    const { theme } = await definedTheme()
    const byToken = Object.fromEntries(theme.rules.map((rule) => [rule.token, rule.foreground]))
    expect(byToken).toEqual({
      keyword: 'f08287', // `# Prerequisites`, and a list marker
      comment: '8ea6cf', // `> [!NOTE]`
      string: '8792ab', // the ```` ```bash ```` fence line
      'variable.source': '9aa6bd', // the body inside a fence
      variable: 'a9b7d0' // an inline `code` span
    })
  })

  /*
    And the Cobalt derivation, against `ui-redesign-cobalt/Cardinal Wiki - Editor 3x - Cobalt.dc.html`
    -- the same surface on the other aesthetic's ramp. Every value here is read off that file: the
    text column on the card indigo, the gutter in the well below it, the caret in the untexted accent
    and the caret's own line number in the white-text one, and the two syntax tones the handoff gives
    Cobalt. Asserted as the whole object rather than a sample, because these come out of a MAPPING
    (`helpers/monacoTheme.js`) rather than being typed one by one: a role added to the Ledger theme
    with no Cobalt answer would otherwise pass straight through unnoticed.
  */
  it('derives the Cobalt twin onto that aesthetic’s own ramp', async () => {
    const { name, theme } = await definedTheme('cobalt')
    expect(name).toBe('cardinaljs-cobalt')
    expect(theme.colors).toEqual({
      'editor.background': '#141c4f',
      'editor.foreground': '#e8ecff',
      'editor.lineHighlightBackground': '#1c2a70',
      'editorLineNumber.foreground': '#3f4a63',
      'editorLineNumber.activeForeground': '#c8303c',
      'editorGutter.background': '#0b1238',
      'editorCursor.foreground': '#ff4d5a',
      'editorCodeLens.foreground': '#22a37f'
    })
    expect(Object.fromEntries(theme.rules.map((rule) => [rule.token, rule.foreground]))).toEqual({
      keyword: 'ff7a84',
      comment: '8fb0ff',
      string: '8b98d6',
      'variable.source': 'a7b3ea',
      variable: 'c5cff5'
    })
  })
})
