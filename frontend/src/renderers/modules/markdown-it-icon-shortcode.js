/**
 * An icon written the way an emoji is: `:tabler:arrows-vertical:`.
 *
 * The inner colon is what tells the two apart, and it is a reliable tell in both directions: an
 * Iconify reference is always `prefix:name` and an emoji shortcode never holds a colon. So the two
 * syntaxes can share the delimiter without either having to know about the other -- `:smile:` has
 * nothing here to match, and this rule runs while the inline is tokenized, well before the emoji
 * plugin's core rule ever looks at the text.
 *
 * Sticky rather than anchored, so it is matched at the cursor without slicing the source at every
 * colon in the document.
 *
 * The prefix must begin with a letter, which every Iconify set does. Without that, `10:30:45:` in a
 * line of prose is an icon reference as far as this is concerned.
 */
const ICON_SHORTCODE = /:([a-z][a-z\d]*(?:-[a-z\d]+)*):([a-z\d]+(?:[-.][a-z\d]+)*):/y

/** The inline rule behind it. `state.pos` is at a `:` for any of this to be worth trying. */
function iconShortcode(state, silent) {
  if (state.src.charCodeAt(state.pos) !== 0x3a /* : */) {
    return false
  }
  ICON_SHORTCODE.lastIndex = state.pos
  const match = ICON_SHORTCODE.exec(state.src)
  // -> `posMax` is the end of what is being tokenized, which inside a link label is not the end of
  //    the line: a match that runs past it belongs to the text after, not to this
  if (!match || state.pos + match[0].length > state.posMax) {
    return false
  }
  if (!silent) {
    const token = state.push('iconify_icon', 'iconify-icon', 0)
    token.markup = match[0]
    token.content = `${match[1]}:${match[2]}`
  }
  state.pos += match[0].length
  return true
}

export default (md) => {
  /*
    Icons written as shortcodes, `:tabler:home:`.

    Registered ahead of every other inline rule so that the whole reference is claimed in one go.
    Nothing else wants it -- MDC's inline component syntax, the only other rule that would take a
    colon, is off in `markdown.js` -- but the alternative is the emoji plugin's core rule, which runs
    over the TEXT of a token that by then has already been split around the colons.
  */
  md.inline.ruler.before('text', 'iconify_icon', iconShortcode)
  md.renderer.rules.iconify_icon = (tokens, idx) =>
    `<iconify-icon icon="${tokens[idx].content}"></iconify-icon>`
}
