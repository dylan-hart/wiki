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

/** Builds the editor by asking for one comparison, then hands back the theme it defined. */
async function definedTheme() {
  const container = ref(document.createElement('div'))
  const { showDiff } = useMonacoDiff(container, { isInline: () => false })
  await showDiff({
    original: { text: 'a', language: 'markdown' },
    modified: { text: 'b', language: 'markdown' }
  })
  /*
    The Ledger half of the pair `helpers/monacoTheme.js` registers (the Cobalt twin is derived from
    it and is asserted in `EditorMarkdown.theme.test.js`, the one place the derivation is pinned).
    `[0]`, not `.at(-1)`: the second call is that derivation.
  */
  return monaco.editor.defineTheme.mock.calls[0][1]
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
describe('useMonacoDiff: the cardinaljs diff theme (OpenProject #2637)', () => {
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
      theme: 'cardinaljs',
      fontSize: 12.5
    })
  })
})

/**
 * OpenProject #2930: the draft-restore dialog wants the diff opened already scrolled to the first
 * change, which `PageHistoryOverlay.vue` (the only other consumer) does not -- so this is an opt-in
 * `scrollToFirstChange` flag on `showDiff()` rather than default behaviour.
 */
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
    // -> Monaco's own convention for a pure deletion: nothing was inserted, so there is no modified
    //    range and modifiedStartLineNumber reports 0 rather than a real line.
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

    // -> A second comparison starts (no scrollToFirstChange this time) on the same diff editor
    //    instance before the first's worker computation ever reports back
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

/** Relative luminance of a `#rrggbb`, enough to say which of two tones is the darker. */
function luminanceOf(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
