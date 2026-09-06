import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

/*
  Monaco itself is a real editor needing a layout engine happy-dom does not have. Everything asserted
  here is what the composable HANDS Monaco -- the theme's colour map and the editor options -- so a
  stub that records those calls is the whole surface under test.
*/
vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    createDiffEditor: vi.fn(() => ({
      setModel: vi.fn(),
      updateOptions: vi.fn(),
      dispose: vi.fn()
    })),
    createModel: vi.fn(() => ({ dispose: vi.fn() }))
  }
}))

import * as monaco from 'monaco-editor'

import { useMonacoDiff } from './monacoDiff.js'

/** Builds the editor by asking for one comparison, then hands back the theme it defined. */
async function definedTheme() {
  const container = ref(document.createElement('div'))
  const { showDiff } = useMonacoDiff(container, { isInline: () => false })
  await showDiff({
    original: { text: 'a', language: 'markdown' },
    modified: { text: 'b', language: 'markdown' }
  })
  return monaco.editor.defineTheme.mock.calls.at(-1)[1]
}

beforeEach(() => {
  monaco.editor.defineTheme.mockClear()
  monaco.editor.createDiffEditor.mockClear()
  monaco.editor.createModel.mockClear()
})

/**
 * OpenProject #2637, notes 3 and 4 of Dylan's 2026-09-05 review: "line number columns should be
 * darker than the markdown content lines, not lighter. there also appears to be a shadow emitting
 * from the B side line number column that should not be there."
 *
 * Both are theme-map facts rather than CSS, so they are asserted against exactly what this composable
 * hands `monaco.editor.defineTheme` -- which is also the only thing standing between the design file
 * and what a reader sees, since nothing else in the app restyles this editor.
 */
describe('useMonacoDiff: the wikijs diff theme (OpenProject #2637)', () => {
  it('paints the line-number gutter BELOW the text ground, not above it', async () => {
    const { colors } = await definedTheme()

    /*
      The design (`ui-redesign/Cardinal Wiki - History 3x.dc.html`) draws every gutter cell on
      `#11141b` against a `#14171f` text ground. Asserted as an ordering, not just as a literal: the
      defect was a gutter one rung LIGHTER than the content, and a future re-tone that keeps the
      relationship right should not have to come back here.
    */
    expect(colors['editorGutter.background']).toBe('#11141b')
    expect(luminanceOf(colors['editorGutter.background'])).toBeLessThan(
      luminanceOf(colors['editor.background'])
    )
  })

  it('keeps the active line number muted rather than falling through to vs-dark near-white', async () => {
    const { colors } = await definedTheme()

    expect(colors['editorLineNumber.activeForeground']).toBe('#8792ab')
    // -> Still dimmer than the code beside it, which is the whole complaint
    expect(luminanceOf(colors['editorLineNumber.activeForeground'])).toBeLessThan(
      luminanceOf(colors['editor.foreground'])
    )
  })

  it('suppresses the scroll-decoration shadow the B-side gutter was emitting', async () => {
    const { colors } = await definedTheme()

    /*
      `scrollbar.shadow` is what Monaco substitutes into
      `.monaco-diff-editor.side-by-side .editor.modified { box-shadow: -6px 0 5px -5px ... }` -- the
      shadow cast leftwards out of the B pane, across its own line numbers. Fully transparent leaves
      the `border-left` hairline declared beside it doing the separating, which is how Cardinal draws
      every edge that used to be an elevation.
    */
    expect(colors['scrollbar.shadow']).toBe('#00000000')
  })

  it('still opens side by side, read-only, at the design metrics', async () => {
    const container = ref(document.createElement('div'))
    const { showDiff } = useMonacoDiff(container, { isInline: () => false })
    await showDiff({
      original: { text: 'a', language: 'markdown' },
      modified: { text: 'b', language: 'markdown' }
    })

    const [, options] = monaco.editor.createDiffEditor.mock.calls.at(-1)
    expect(options).toMatchObject({
      renderSideBySide: true,
      readOnly: true,
      theme: 'wikijs',
      fontSize: 12.5
    })
  })
})

/** Relative luminance of a `#rrggbb`, enough to say which of two tones is the darker. */
function luminanceOf(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
