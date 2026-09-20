import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

/*
  Monaco needs a layout engine happy-dom does not have, and everything asserted here is what the
  composable HANDS it -- the theme's colour map and the editor options.
*/
vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    // -> The real modified-side editor is the same object on every call; a factory that minted a
    //    fresh one each time would make `getModifiedEditor().revealLineNearTop` unassertable
    createDiffEditor: vi.fn(() => {
      const modifiedEditor = { revealLineNearTop: vi.fn() }
      return {
        setModel: vi.fn(),
        updateOptions: vi.fn(),
        dispose: vi.fn(),
        onDidUpdateDiff: vi.fn(() => ({ dispose: vi.fn() })),
        getLineChanges: vi.fn(() => null),
        getModifiedEditor: vi.fn(() => modifiedEditor)
      }
    }),
    createModel: vi.fn(() => ({ dispose: vi.fn() }))
  }
}))

import * as monaco from 'monaco-editor'

import { useMonacoDiff } from './monacoDiff.js'

async function definedTheme() {
  const container = ref(document.createElement('div'))
  const { showDiff } = useMonacoDiff(container, { isInline: () => false })
  await showDiff({
    original: { text: 'a', language: 'markdown' },
    modified: { text: 'b', language: 'markdown' }
  })
  // -> `[0]`, not `.at(-1)`: `helpers/monacoTheme.js` registers a pair, and the second call is the
  //    Cobalt twin derived from this one
  return monaco.editor.defineTheme.mock.calls[0][1]
}

beforeEach(() => {
  monaco.editor.defineTheme.mockClear()
  monaco.editor.createDiffEditor.mockClear()
  monaco.editor.createModel.mockClear()
})

/**
 * These are theme-map facts rather than CSS, so they are asserted against what the composable hands
 * `monaco.editor.defineTheme` -- nothing else in the app restyles this editor.
 */
describe('useMonacoDiff: the cardinaljs diff theme (OpenProject #2637)', () => {
  it('paints the line-number gutter BELOW the text ground, not above it', async () => {
    const { colors } = await definedTheme()

    // -> Asserted as an ordering as well as a literal, so a re-tone that keeps the gutter darker
    //    than the text ground need not come back here
    expect(colors['editorGutter.background']).toBe('#11141b')
    expect(luminanceOf(colors['editorGutter.background'])).toBeLessThan(
      luminanceOf(colors['editor.background'])
    )
  })

  it('keeps the active line number muted rather than falling through to vs-dark near-white', async () => {
    const { colors } = await definedTheme()

    expect(colors['editorLineNumber.activeForeground']).toBe('#8792ab')
    expect(luminanceOf(colors['editorLineNumber.activeForeground'])).toBeLessThan(
      luminanceOf(colors['editor.foreground'])
    )
  })

  it('suppresses the scroll-decoration shadow the B-side gutter was emitting', async () => {
    const { colors } = await definedTheme()

    // -> `scrollbar.shadow` is what Monaco substitutes into the modified pane's `box-shadow`, cast
    //    leftwards across its own line numbers; transparent leaves the hairline border separating them
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
      theme: 'cardinaljs',
      fontSize: 12.5
    })
  })
})

describe('useMonacoDiff: scrollToFirstChange (OpenProject #2930)', () => {
  it('subscribes to the diff update but does not reveal anything before it fires', async () => {
    const container = ref(document.createElement('div'))
    const { showDiff } = useMonacoDiff(container, { isInline: () => true })
    await showDiff({
      original: { text: 'a\nb', language: 'markdown' },
      modified: { text: 'a\nc', language: 'markdown' },
      scrollToFirstChange: true
    })

    const diffEditor = monaco.editor.createDiffEditor.mock.results.at(-1).value
    expect(diffEditor.onDidUpdateDiff).toHaveBeenCalledTimes(1)
    expect(diffEditor.getModifiedEditor().revealLineNearTop).not.toHaveBeenCalled()
  })

  it('reveals the first changed line near the top once Monaco reports the diff is ready', async () => {
    const container = ref(document.createElement('div'))
    const { showDiff } = useMonacoDiff(container, { isInline: () => true })
    await showDiff({
      original: { text: 'a\nb', language: 'markdown' },
      modified: { text: 'a\nc', language: 'markdown' },
      scrollToFirstChange: true
    })

    const diffEditor = monaco.editor.createDiffEditor.mock.results.at(-1).value
    diffEditor.getLineChanges.mockReturnValue([
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 2
      }
    ])
    diffEditor.onDidUpdateDiff.mock.calls[0][0]()

    expect(diffEditor.getModifiedEditor().revealLineNearTop).toHaveBeenCalledWith(2)
  })

  it("falls back off a pure deletion's modifiedStartLineNumber of 0", async () => {
    const container = ref(document.createElement('div'))
    const { showDiff } = useMonacoDiff(container, { isInline: () => true })
    await showDiff({
      original: { text: 'a\nb\nc', language: 'markdown' },
      modified: { text: 'a\nc', language: 'markdown' },
      scrollToFirstChange: true
    })

    const diffEditor = monaco.editor.createDiffEditor.mock.results.at(-1).value
    // -> Monaco's own convention: nothing was inserted, so there is no modified range and
    //    modifiedStartLineNumber reports 0 rather than a real line
    diffEditor.getLineChanges.mockReturnValue([
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 0,
        modifiedEndLineNumber: 1
      }
    ])
    diffEditor.onDidUpdateDiff.mock.calls[0][0]()

    expect(diffEditor.getModifiedEditor().revealLineNearTop).toHaveBeenCalledWith(1)
  })

  it('never subscribes when scrollToFirstChange is left at its default', async () => {
    const container = ref(document.createElement('div'))
    const { showDiff } = useMonacoDiff(container, { isInline: () => false })
    await showDiff({
      original: { text: 'a', language: 'markdown' },
      modified: { text: 'b', language: 'markdown' }
    })

    const diffEditor = monaco.editor.createDiffEditor.mock.results.at(-1).value
    expect(diffEditor.onDidUpdateDiff).not.toHaveBeenCalled()
  })

  it('ignores a stale diff-update callback once a newer comparison has started', async () => {
    const container = ref(document.createElement('div'))
    const { showDiff } = useMonacoDiff(container, { isInline: () => true })
    await showDiff({
      original: { text: 'a', language: 'markdown' },
      modified: { text: 'b', language: 'markdown' },
      scrollToFirstChange: true
    })
    const diffEditor = monaco.editor.createDiffEditor.mock.results.at(-1).value
    const staleOnUpdate = diffEditor.onDidUpdateDiff.mock.calls[0][0]

    // -> A second comparison on the same editor instance, before the first's worker reports back
    await showDiff({
      original: { text: 'a', language: 'markdown' },
      modified: { text: 'c', language: 'markdown' }
    })

    diffEditor.getLineChanges.mockReturnValue([
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 1
      }
    ])
    staleOnUpdate()

    expect(diffEditor.getModifiedEditor().revealLineNearTop).not.toHaveBeenCalled()
  })
})

function luminanceOf(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
