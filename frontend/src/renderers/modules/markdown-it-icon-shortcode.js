/**
 * An icon written the way an emoji is: `:tabler:arrows-vertical:`. The inner colon tells the two
 * apart in both directions -- an Iconify reference is always `prefix:name`, an emoji shortcode never
 * holds a colon -- so the two syntaxes share the delimiter without either knowing about the other.
 *
 * Sticky rather than anchored, so it is matched at the cursor without slicing the source at every
 * colon in the document. The prefix must begin with a letter, which every Iconify set does; without
 * that, `10:30:45:` in a line of prose is an icon reference.
 */
const ICON_SHORTCODE = /:([a-z][a-z\d]*(?:-[a-z\d]+)*):([a-z\d]+(?:[-.][a-z\d]+)*):/y

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
    Registered ahead of every other inline rule so the whole reference is claimed in one go: the
    alternative is the emoji plugin's core rule, which runs over the text of a token that has by then
    already been split around the colons.
  */
  md.inline.ruler.before('text', 'iconify_icon', iconShortcode)
  md.renderer.rules.iconify_icon = (tokens, idx) =>
    `<iconify-icon icon="${tokens[idx].content}"></iconify-icon>`
}
