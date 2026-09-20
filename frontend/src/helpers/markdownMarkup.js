/**
 * The decision logic behind `EditorMarkdown.vue`'s `toggleMarkup` -- the shared handler for every
 * symmetric-wrap toolbar button (Bold, Italic, Strikethrough, Inline Code, Keyboard Key, Subscript,
 * Superscript, ...) -- kept clear of the Monaco `Range`/`executeEdits` mechanics the component
 * wraps around it, so it is testable without a real editor instance.
 *
 * `word` is null whenever `editor.getModel().getWordAtPosition(position)` found none: the cursor is
 * not on or adjacent to a "word" under the markdown language's `wordPattern` -- an empty line, an
 * empty document, or a cursor next to non-word markup with nothing in it (`~~` with nothing between
 * the tildes).
 */

/**
 * `atCursor` says there was no word to wrap: the caller inserts `text` as a zero-width edit at the
 * cursor and lands the caret after `start`, between the two empty markers, rather than at Monaco's
 * default end-of-edit position, so the author can type into them right away.
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
