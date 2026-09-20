import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountEditorMarkdown } from './editorMarkdownHarness.js'

vi.mock('monaco-editor', async () => (await import('./editorMarkdownHarness.js')).monacoMock())

const monaco = await import('monaco-editor')
const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

/*
  Monaco draws its own chrome, so the parts of the design file that fall inside the source pane --
  the code ground, the line-number gutter, the caret, the current-line band, the code lens and the
  markdown token ramp -- are settled by a THEME, not by any CSS this component could write. That
  makes the theme object the only reviewable artifact for those values, which is what this pins:
  every colour below is read straight off the design file.
*/
describe('EditorMarkdown Monaco theme, against Cardinal Wiki - Editor 3x.dc.html', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /*
    Two themes are registered on mount, one per aesthetic (`helpers/monacoTheme.js`): the Ledger
    definition the design file settles, and the Cobalt one derived from it.
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
    expect(theme.colors['editorCodeLens.foreground']).toBe('#3f7a66')
  })

  /*
    Left as `rules: []` the editor inherits `vs-dark`'s own blues and oranges, which are nowhere in
    this language. Token names are Monarch's, from `monaco-editor`'s markdown grammar; a theme rule
    matches by prefix, so these bare names cover the `.md` postfix that grammar appends.
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
    Asserted as the whole object rather than a sample, because these come out of a MAPPING
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
