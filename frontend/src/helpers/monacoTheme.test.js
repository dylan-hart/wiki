import { describe, expect, it, vi } from 'vitest'

import {
  MONACO_THEME_COBALT,
  MONACO_THEME_LEDGER,
  defineMonacoThemes,
  monacoThemeName
} from './monacoTheme.js'

/*
  Monaco is the one surface the design-token layer cannot reach -- `defineTheme()` takes plain hex
  strings and never resolves a CSS custom property -- so the aesthetic is applied by registering a
  second theme and switching to it. What is worth pinning here is that the second theme is DERIVED
  rather than re-typed: each surface writes only its Ledger definition, and this maps every tone onto
  Cobalt's answer for the same role. A role with no answer passes through unchanged, which is right
  for the colours that are not aesthetic at all -- and is also the thing most likely to go unnoticed,
  so it is asserted deliberately rather than assumed.
*/
function fakeMonaco() {
  return { editor: { defineTheme: vi.fn() } }
}

const LEDGER = {
  base: 'vs-dark',
  inherit: true,
  rules: [{ token: 'keyword', foreground: 'f08287' }],
  colors: {
    'editor.background': '#171b24',
    'editorGutter.background': '#14171f',
    'editorCursor.foreground': '#e4676b',
    'diffEditor.insertedLineBackground': '#5f9c862e'
  }
}

describe('defineMonacoThemes', () => {
  it('registers the caller’s definition unchanged under the Ledger id', () => {
    const monaco = fakeMonaco()

    defineMonacoThemes(monaco, LEDGER)

    expect(monaco.editor.defineTheme.mock.calls[0]).toEqual([MONACO_THEME_LEDGER, LEDGER])
  })

  it('derives the Cobalt twin by mapping each tone onto the same role’s Cobalt answer', () => {
    const monaco = fakeMonaco()

    defineMonacoThemes(monaco, LEDGER)

    const [name, theme] = monaco.editor.defineTheme.mock.calls[1]
    expect(name).toBe(MONACO_THEME_COBALT)
    expect(theme.colors['editor.background']).toBe('#141c4f')
    expect(theme.colors['editorGutter.background']).toBe('#0b1238')
    expect(theme.colors['editorCursor.foreground']).toBe('#ff4d5a')
    // -> `rules[].foreground` carries no `#`, and comes back the same way
    expect(theme.rules[0]).toEqual({ token: 'keyword', foreground: 'ff7a84' })
  })

  it('passes through a colour with no Cobalt answer, rather than guessing one', () => {
    const monaco = fakeMonaco()

    defineMonacoThemes(monaco, LEDGER)

    // -> A diff's own inserted-line wash is not an aesthetic tone; nothing should touch it
    expect(
      monaco.editor.defineTheme.mock.calls[1][1].colors['diffEditor.insertedLineBackground']
    ).toBe('#5f9c862e')
  })

  it('keeps the base and inherit flags, and copes with a theme that has neither list', () => {
    const monaco = fakeMonaco()

    defineMonacoThemes(monaco, { base: 'vs-dark', inherit: true })

    const [, theme] = monaco.editor.defineTheme.mock.calls[1]
    expect(theme).toMatchObject({ base: 'vs-dark', inherit: true, rules: [], colors: {} })
  })
})

describe('monacoThemeName', () => {
  it('names the Cobalt theme for the Cobalt aesthetic and the Ledger one otherwise', () => {
    expect(monacoThemeName('cobalt')).toBe(MONACO_THEME_COBALT)
    expect(monacoThemeName('ledger')).toBe(MONACO_THEME_LEDGER)
    // -> An unresolved aesthetic is Ledger, the default, never an unregistered id
    expect(monacoThemeName(undefined)).toBe(MONACO_THEME_LEDGER)
  })
})
