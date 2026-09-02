import { nextTick } from 'vue'
import * as monaco from 'monaco-editor'

/**
 * Above this many characters on either side, the comparison is not put in front of Monaco at all.
 *
 * Monaco's own diff computation runs in a worker, so it does not freeze the tab the way a main-thread
 * computation would -- but a page with tens of thousands of lines is well within where it quietly runs
 * past its computation budget (`maxComputationTime` on the diff editor below) and gives up, returning
 * no changes. That result renders exactly like two versions with nothing different between them, with
 * no indication the comparison was ever abandoned -- worse than a blank pane, which would at least look
 * broken. This threshold is chosen to sit below where that starts happening in practice, so the honest
 * "too large to render inline" notice is what a reader sees instead of a false "nothing changed".
 */
export const DIFF_INLINE_CHAR_LIMIT = 500_000

export function tooLargeToDiffInline(a, b) {
  return (
    (a?.content?.length ?? 0) > DIFF_INLINE_CHAR_LIMIT ||
    (b?.content?.length ?? 0) > DIFF_INLINE_CHAR_LIMIT
  )
}

/**
 * A read-only Monaco diff editor over one container element: built on first use, fed a pair of
 * texts, and torn down again.
 *
 * Lifted out of `PageHistoryOverlay.vue`, whose own concern is which two versions to compare and how
 * to fetch them -- everything about the editor drawing that comparison is here, and none of it reads
 * the overlay's state.
 *
 * @param {{value: HTMLElement|null}} containerRef Where the editor mounts.
 * @param {object} opts
 * @param {() => boolean} opts.isInline Whether to open inline rather than side by side. Read at
 *   creation time; call `setInline()` for a later change.
 */
export function useMonacoDiff(containerRef, { isInline }) {
  /*
    The Monaco instances, deliberately plain `let`s: they are large objects with their own internals,
    and making them reactive buys nothing and costs a lot.
  */
  let diffEditor = null
  let originalModel = null
  let modifiedModel = null

  /** The editor is built on first use, since the container only exists once there is history to show. */
  async function mountEditor() {
    await nextTick()
    if (diffEditor || !containerRef.value) {
      return
    }

    // -> The markdown editor's theme, defined again here because that component may never have mounted
    monaco.editor.defineTheme('wikijs', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#070a0d',
        'editor.lineHighlightBackground': '#0d1117',
        'editorLineNumber.foreground': '#546e7a',
        'editorGutter.background': '#0d1117'
      }
    })

    diffEditor = monaco.editor.createDiffEditor(containerRef.value, {
      automaticLayout: true,
      fontSize: 14,
      // -> Side by side by default: this exists to compare the two, and an inline diff of prose reads
      //    as a jumble of half-lines. The header offers the other way for anyone who prefers it.
      renderSideBySide: !isInline(),
      originalEditable: false,
      // -> A reader, not an editor. Restoring a version is its own action, and is not implemented yet.
      readOnly: true,
      scrollBeyondLastLine: false,
      theme: 'wikijs',
      wordWrap: 'on',
      // -> Written out rather than left to Monaco's own defaults (which happen to be these same two
      //    values today): the diff computation itself runs off the main thread in a worker, so a huge
      //    pair of versions does not freeze the tab -- but past this budget the worker gives up and
      //    returns no changes at all, and an abandoned computation then looks identical to two versions
      //    that truly have no differences, with nothing in the UI to say which one happened. `DIFF_INLINE
      //    _CHAR_LIMIT` above is what actually keeps that silent case from being reached in practice; this
      //    is the backstop for the content that slips in under it but still turns out to be slow to diff.
      maxComputationTime: 5000,
      maxFileSize: 50
    })
  }

  /** Releases whatever the diff editor is currently showing, without disposing the editor itself. */
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
   * Show one comparison, mounting the editor if this is the first.
   *
   * @param {object} sides
   * @param {{text: string, language: string}} sides.original
   * @param {{text: string, language: string}} sides.modified
   * @param {() => boolean} [sides.isStale] Asked again after the mount await -- a newer comparison
   *   started while this one was waiting owns the editor now, and this one must not touch it.
   */
  async function showDiff({ original, modified, isStale }) {
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
  }

  return { showDiff, setInline, disposeModels, disposeEditor }
}
