/**
 * Wraps every case-insensitive, whole-word mention of a glossary term with a native `title` tooltip
 * carrying its definition, linking through to the term's canonical page when one is set. Modeled on
 * `markdown-it-abbr`'s own text-token scan.
 *
 * `terms` come in as `{ term, definition, aliases, isAcronym, link }[]`, already resolved by
 * `backend/models/glossary.ts#getCachedTerms`, so this plugin does no page lookups of its own. An
 * alias (`{ value, isAcronym }`) is just another surface form resolving to the SAME entry;
 * `isAcronym` only affects how the path-segment humanizer casts a path segment, never matching here.
 */
export default function glossaryPlugin(md, options = {}) {
  const terms = (options.terms ?? []).filter((entry) => entry?.term?.trim())
  if (!terms.length) {
    return
  }

  const escapeRE = md.utils.escapeRE
  const arrayReplaceAt = md.utils.arrayReplaceAt

  // -> The same boundary classes `markdown-it-abbr` bounds a match on: Unicode punctuation or space,
  //    or one of a short list of ASCII symbols those two categories don't cover. This is what keeps
  //    a term like "log" from matching inside "login".
  const OTHER_CHARS = ' \r\n$+<=>^`|~'
  const UNICODE_PUNCT_RE = md.utils.lib.ucmicro.P.source
  const UNICODE_SPACE_RE = md.utils.lib.ucmicro.Z.source
  const BOUNDARY = `${UNICODE_PUNCT_RE}|${UNICODE_SPACE_RE}|[${OTHER_CHARS.split('').map(escapeRE).join('')}]`

  // -> Sorted longest-first ACROSS the whole flattened list, not per-entry: where two surface forms
  //    could both match the same span (a term "API" and some other entry's alias "REST API"), the
  //    more specific one has to win, and regex alternation tries its branches in written order.
  const surfaceForms = terms.flatMap((entry) =>
    [entry.term, ...(entry.aliases ?? []).map((alias) => alias.value)].map((literal) => ({
      literal,
      entry
    }))
  )
  const sortedForms = surfaceForms.sort((a, b) => b.literal.length - a.literal.length)
  const byLowerForm = new Map(
    sortedForms.map(({ literal, entry }) => [literal.toLowerCase(), entry])
  )
  const alternation = sortedForms.map(({ literal }) => escapeRE(literal)).join('|')
  const pattern = new RegExp(`(^|${BOUNDARY})(${alternation})($|${BOUNDARY})`, 'gi')

  function glossaryReplace(state) {
    for (const blockToken of state.tokens) {
      if (blockToken.type !== 'inline') {
        continue
      }
      let tokens = blockToken.children

      // -> Whether index `i` sits between a `link_open`/`link_close` pair, computed once per inline
      //    block rather than per match. A term matched inside an author's own link still gets its
      //    tooltip but must not also emit a nested `<a>`: nested anchors are invalid HTML, and a
      //    browser recovers by closing the outer link early, silently breaking the author's link.
      let linkDepth = 0
      const insideLink = tokens.map((token) => {
        if (token.type === 'link_open') {
          linkDepth++
          return true
        }
        if (token.type === 'link_close') {
          const wasInside = linkDepth > 0
          linkDepth--
          return wasInside
        }
        return linkDepth > 0
      })

      // -> Scanned from the end: splicing replacement nodes in at index `i` leaves every index
      //    before it valid
      for (let i = tokens.length - 1; i >= 0; i--) {
        const currentToken = tokens[i]
        if (currentToken.type !== 'text') {
          continue
        }
        const suppressLink = insideLink[i]

        const text = currentToken.content
        pattern.lastIndex = 0
        if (!pattern.test(text)) {
          continue
        }
        pattern.lastIndex = 0

        let pos = 0
        const nodes = []
        let match
        while ((match = pattern.exec(text))) {
          const entry = byLowerForm.get(match[2].toLowerCase())

          if (match.index > 0 || match[1].length > 0) {
            const before = new state.Token('text', '', 0)
            before.content = text.slice(pos, match.index + match[1].length)
            nodes.push(before)
          }

          const asLink = entry.link && !suppressLink
          const tag = asLink ? 'a' : 'abbr'
          const open = new state.Token('glossary_open', tag, 1)
          open.attrs = asLink
            ? [
                ['href', entry.link],
                ['title', entry.definition],
                ['class', 'glossary-term']
              ]
            : [
                ['title', entry.definition],
                ['class', 'glossary-term']
              ]
          nodes.push(open)

          const matched = new state.Token('text', '', 0)
          matched.content = match[2]
          nodes.push(matched)

          nodes.push(new state.Token('glossary_close', tag, -1))

          // -> Back `lastIndex` up over the trailing boundary character so it can also serve as the
          //    LEADING boundary of the next match; two terms separated by one space otherwise miss
          //    the second
          pattern.lastIndex -= match[3].length
          pos = pattern.lastIndex
        }

        if (!nodes.length) {
          continue
        }
        if (pos < text.length) {
          const after = new state.Token('text', '', 0)
          after.content = text.slice(pos)
          nodes.push(after)
        }

        blockToken.children = tokens = arrayReplaceAt(tokens, i, nodes)
      }
    }
  }

  md.core.ruler.after('linkify', 'glossary_replace', glossaryReplace)
}
