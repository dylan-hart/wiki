/**
 * Mapped onto the admonition classes the content stylesheet already draws — the ones `{.is-info}`
 * and friends attach — so an alert and a hand-classed blockquote are the same object on the page,
 * styled in one place.
 *
 * The labels are English, as the marker itself is: what the renderer emits is stored as the page's
 * HTML, so nothing here can follow the reader's locale afterwards.
 */
const KINDS = new Map([
  ['note', { className: 'is-info', label: 'Note' }],
  ['tip', { className: 'is-success', label: 'Tip' }],
  ['important', { className: 'is-important', label: 'Important' }],
  ['warning', { className: 'is-warning', label: 'Warning' }],
  ['caution', { className: 'is-danger', label: 'Caution' }],
  ['question', { className: 'is-question', label: 'Question' }]
])

/**
 * Whatever the author wrote after the marker on the same line becomes the admonition's title:
 * `> [!NOTE] Read this first` is headed "Read this first" rather than "Note". A deliberate step past
 * GitHub, which renders those words as the first line of the quote instead. The capture is raw
 * markdown and is parsed as such, so a title may hold a link or a `code` span.
 */
const MARKER = /^\[!([a-z]+)\][ \t]*([^\n]*)(?:\n|$)/i

/**
 * The inline token is left with nothing but `content`: the core `inline` rule runs after this one and
 * is what turns that into children, which is what lets an author's own title carry markdown — and
 * what keeps it escaped if it carries anything else.
 */
function titleTokens(state, title) {
  const open = new state.Token('paragraph_open', 'p', 1)
  open.attrSet('class', 'alert-title')
  open.block = true

  const inline = new state.Token('inline', '', 0)
  inline.content = title
  inline.children = []

  const close = new state.Token('paragraph_close', 'p', -1)
  close.block = true

  return [open, inline, close]
}

export default (md) => {
  /*
    After `block` and so before `inline`: at this point a paragraph is still one `inline` token
    holding its raw source, so claiming the marker is a matter of cutting a line off a string. Run
    after `inline` instead and the same job means walking children and reasoning about where
    markdown-it put the break — soft, or hard where the author left two spaces after the marker.
  */
  md.core.ruler.after('block', 'github_alert', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      if (
        tokens[i].type !== 'blockquote_open' ||
        tokens[i + 1]?.type !== 'paragraph_open' ||
        tokens[i + 2]?.type !== 'inline'
      ) {
        continue
      }

      const marker = MARKER.exec(tokens[i + 2].content)
      const kind = marker ? KINDS.get(marker[1].toLowerCase()) : null
      if (!kind) {
        continue
      }

      // -> Joined rather than set: an author may have classed the quote themselves, and the
      //    stylesheet is written to expect the admonition class on top of that
      tokens[i].attrJoin('class', kind.className)

      const title = marker[2].trim() || kind.label

      const rest = tokens[i + 2].content.slice(marker[0].length)
      if (rest) {
        tokens[i + 2].content = rest
        tokens.splice(i + 1, 0, ...titleTokens(state, title))
      } else {
        // -> The marker line was the whole paragraph: the title replaces it rather than heading it
        tokens.splice(i + 1, 3, ...titleTokens(state, title))
      }
    }
  })
}
