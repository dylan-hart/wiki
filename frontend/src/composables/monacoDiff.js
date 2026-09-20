import { nextTick } from 'vue'
import * as monaco from 'monaco-editor'

import { useAesthetic } from '@/composables/aesthetic'
import { defineMonacoThemes, monacoThemeName } from '@/helpers/monacoTheme'

/**
 * Past its `maxComputationTime` budget Monaco's diff worker gives up and reports no changes, which
 * renders identically to two versions that genuinely match. This sits below where that starts, so a
 * reader gets the honest "too large to render inline" notice instead of a false "nothing changed".
 */
export const DIFF_INLINE_CHAR_LIMIT = 500_000

export function tooLargeToDiffInline(a, b) {
  return (
    (a?.content?.length ?? 0) > DIFF_INLINE_CHAR_LIMIT ||
    (b?.content?.length ?? 0) > DIFF_INLINE_CHAR_LIMIT
  )
}

/**
 * @param {{value: HTMLElement|null}} containerRef
 * @param {object} opts
 * @param {() => boolean} opts.isInline Read once, at creation time; `setInline()` is what changes it
 *   afterwards.
 */
export function useMonacoDiff(containerRef, { isInline }) {
  // -> Plain `let`s: these are large objects with their own internals, and reactivity over them
  //    buys nothing and costs a lot.
  let diffEditor = null
  let originalModel = null
  let modifiedModel = null
  /**
   * Bumped per `showDiff()` call, so a `scrollToFirstChange` subscription that resolves after a
   * newer comparison replaced it does not reveal a line in what is no longer shown.
   */
  let generation = 0

  /** Waits a tick: the container is only rendered once there is history to show. */
  async function mountEditor() {
    await nextTick()
    if (diffEditor || !containerRef.value) {
      return
    }

    // -> The markdown editor's theme, defined again here because that component may never have mounted
    defineMonacoThemes(monaco, {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#14171f',
        'editor.foreground': '#c3cee2',
        'editor.lineHighlightBackground': '#171b24',
        'editorLineNumber.foreground': '#3f4a63',
        /*
          Must sit BELOW `editor.background`, not above it: a lighter rung draws the two line-number
          columns as pale bands framing the diff. This is the design's own literal, not a named rung.
        */
        'editorGutter.background': '#11141b',
        /*
          Unset, the cursor's line number falls through to `vs-dark`'s near-white `#c6c6c6`. Only
          CHANGED line numbers are meant to stand out, and Monaco colours those from the diff
          decoration rather than this token.
        */
        'editorLineNumber.activeForeground': '#8792ab',
        /*
          Transparent kills all three shadows Monaco substitutes this token into, including the one
          the modified pane casts leftwards across its own gutter unconditionally. The
          `diffEditor.border` hairline beside it does the separating, per Cardinal's no-elevation rule.
        */
        'scrollbar.shadow': '#00000000'
      }
    })

    diffEditor = monaco.editor.createDiffEditor(containerRef.value, {
      automaticLayout: true,
      // -> Sized so a side-by-side diff of prose fits two readable columns in half an overlay each
      fontSize: 12.5,
      lineHeight: 23,
      fontFamily: "'Roboto Mono', Consolas, 'Liberation Mono', Courier, monospace",
      renderSideBySide: !isInline(),
      originalEditable: false,
      readOnly: true,
      scrollBeyondLastLine: false,
      theme: monacoThemeName(useAesthetic().current),
      wordWrap: 'on',
      // -> Pinned rather than left to Monaco's defaults: the backstop for content that slips under
      //    `DIFF_INLINE_CHAR_LIMIT` and still diffs slowly enough for the worker to give up silently
      maxComputationTime: 5000,
      maxFileSize: 50
    })
  }

  function disposeModels() {
    diffEditor?.setModel(null)
    originalModel?.dispose()
    modifiedModel?.dispose()
    originalModel = null
    modifiedModel = null
  }

  function disposeEditor() {
    disposeModels()
    diffEditor?.dispose()
    diffEditor = null
  }

  /** A live option, so switching keeps the scroll position and the models rather than rebuilding. */
  function setInline(inline) {
    diffEditor?.updateOptions({ renderSideBySide: !inline })
  }

  /**
   * @param {object} sides
   * @param {{text: string, language: string}} sides.original
   * @param {{text: string, language: string}} sides.modified
   * @param {() => boolean} [sides.isStale] Asked again after the mount await -- a newer comparison
   *   started while this one was waiting owns the editor now, and this one must not touch it.
   * @param {boolean} [sides.scrollToFirstChange] Scroll to the first changed line once Monaco's diff
   *   computation resolves.
   */
  async function showDiff({ original, modified, isStale, scrollToFirstChange = false }) {
    const thisGeneration = ++generation
    await mountEditor()
    if (isStale?.() || !diffEditor) {
      return
    }

    const previous = [originalModel, modifiedModel]
    originalModel = monaco.editor.createModel(original.text, original.language)
    modifiedModel = monaco.editor.createModel(modified.text, modified.language)
    diffEditor.setModel({ original: originalModel, modified: modifiedModel })
    // -> After the swap, not before: disposing a model the editor still holds blanks the pane
    for (const model of previous) {
      model?.dispose()
    }

    if (scrollToFirstChange) {
      revealFirstChangeOnceComputed(thisGeneration)
    }
  }

  /**
   * Monaco's diff computation runs off the main thread, so `getLineChanges()` answers nothing until
   * `onDidUpdateDiff` fires -- reading it straight after `setModel` sees no changes at all.
   */
  function revealFirstChangeOnceComputed(thisGeneration) {
    const editor = diffEditor
    const subscription = editor.onDidUpdateDiff(() => {
      subscription.dispose()
      // -> A newer showDiff() call, or a dispose, happened while this was waiting on the worker
      if (thisGeneration !== generation || editor !== diffEditor) {
        return
      }
      const firstChange = editor.getLineChanges()?.[0]
      if (!firstChange) {
        return
      }
      /*
        A pure deletion has no modified range -- Monaco reports modifiedStartLineNumber: 0 rather
        than a real line, so fall back to where it would have landed, then to the top.
      */
      const line = firstChange.modifiedStartLineNumber || firstChange.modifiedEndLineNumber || 1
      editor.getModifiedEditor().revealLineNearTop(line)
    })
  }

  return { showDiff, setInline, disposeModels, disposeEditor }
}
