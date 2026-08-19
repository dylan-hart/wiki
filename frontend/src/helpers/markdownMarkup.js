/**
 * Pure decision logic behind `EditorMarkdown.vue`'s `toggleMarkup` -- the shared handler for every
 * symmetric-wrap toolbar button (Bold, Italic, Strikethrough, Inline Code, Keyboard Key, Subscript,
 * Superscript, ...). Pulled out so it's testable without a real Monaco editor instance; the
 * component maps the result onto a Monaco `Range`/`Selection` and calls `executeEdits`.
 *
 * `toggleMarkup` reaches here when the cursor has no selected text and falls back to
 * `editor.getModel().getWordAtPosition(position)` to find a word to wrap. That call returns `null`
 * when the cursor isn't on or adjacent to a "word" under the markdown language's `wordPattern` --
 * an empty line, an empty document, or a cursor next to non-word markup with nothing in it (`~~`
 * with nothing between the tildes). `toggleMarkup` used to read `wordObj.startColumn`
 * unconditionally in that case and threw a `TypeError` (OpenProject #800).
 */

/**
 * @param {object} args
 * @param {string} args.start - Opening marker, e.g. `**`.
 * @param {string} args.end - Closing marker, e.g. `**` (symmetric markers) or `</kbd>`.
 * @param {string|null} args.word - The word Monaco found under the cursor, or `null` when it found
 *   none.
 * @returns {{ text: string, atCursor: boolean }} `text` is the replacement for the edit. `atCursor`
 *   is `true` when there was no word to wrap -- the caller inserts `text` as a zero-width edit at
 *   the cursor and should land the caret after `start` (between the two empty markers) rather than
 *   at Monaco's default end-of-edit position, so the author can type into them right away.
 */
export function resolveWordMarkup({ start, end, word }) {
  if (word == null) {
    return { text: `${start}${end}`, atCursor: true }
  }
  if (word.startsWith(start) && word.endsWith(end)) {
    return { text: word.substring(start.length, word.length - end.length), atCursor: false }
  }
  return { text: `${start}${word}${end}`, atCursor: false }
}
