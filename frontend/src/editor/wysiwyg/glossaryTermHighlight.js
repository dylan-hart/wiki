import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * A view-layer decoration overlay, deliberately not a stored mark or node: there is no markdown
 * syntax for a glossary term -- the renderer recognizes one by matching a live term list against
 * plain text -- so a stored mark would have to invent syntax the renderer ignores, or desync the
 * moment a term is renamed. Decorations never enter the document, so the markdown round-trip holds
 * by construction.
 *
 * `options.terms` is read once at construction and does not refresh mid-session; live updates would
 * need a way to push new terms into a running editor's plugin state.
 *
 * The renderer's "suppress inside an existing markdown link" rule is deliberately skipped: it
 * exists there to avoid emitting an invalid nested `<a>`, and a CSS overlay does not nest.
 */
/** Exported so a test can read the plugin's decoration state directly. */
export const glossaryTermHighlightPluginKey = new PluginKey('glossaryTermHighlight')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Surface forms are ordered longest first so a more specific alias wins over a shorter term it
 * contains. Boundaries are Unicode-aware lookaround rather than the renderer's explicit
 * boundary-character class: this only ever runs against a text node's own content, never markdown
 * source, where a literal `$` or backtick against a term would matter.
 */
function buildMatcher(terms) {
  const surfaceForms = (terms || [])
    .filter((entry) => entry?.term?.trim())
    .flatMap((entry) =>
      [entry.term, ...(entry.aliases ?? []).map((alias) => alias.value)].map((literal) => ({
        literal,
        entry
      }))
    )

  if (!surfaceForms.length) {
    return null
  }

  const sorted = surfaceForms.sort((a, b) => b.literal.length - a.literal.length)
  const byLowerForm = new Map(sorted.map(({ literal, entry }) => [literal.toLowerCase(), entry]))
  const alternation = sorted.map(({ literal }) => escapeRegExp(literal)).join('|')
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, 'giu')

  return { pattern, byLowerForm }
}

function buildDecorations(doc, matcher) {
  if (!matcher) {
    return DecorationSet.empty
  }

  const decorations = []
  doc.descendants((node, pos) => {
    if (!node.isText) {
      return
    }
    const text = node.text || ''
    matcher.pattern.lastIndex = 0
    let match
    while ((match = matcher.pattern.exec(text))) {
      const literal = match[0]
      const entry = matcher.byLowerForm.get(literal.toLowerCase())
      if (entry) {
        const from = pos + match.index
        const to = from + literal.length
        decorations.push(
          Decoration.inline(from, to, {
            class: 'wysiwyg-glossary-term',
            title: entry.definition
          })
        )
      }
      // -> Insurance against a future pattern edit that can match zero-width and loop forever.
      if (match.index === matcher.pattern.lastIndex) {
        matcher.pattern.lastIndex += 1
      }
    }
  })

  return DecorationSet.create(doc, decorations)
}

export const GlossaryTermHighlight = Extension.create({
  name: 'glossaryTermHighlight',

  addOptions() {
    return {
      terms: []
    }
  },

  addProseMirrorPlugins() {
    const matcher = buildMatcher(this.options.terms)

    return [
      new Plugin({
        key: glossaryTermHighlightPluginKey,
        state: {
          init: (_config, state) => buildDecorations(state.doc, matcher),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc, matcher) : old)
        },
        props: {
          decorations: (state) => glossaryTermHighlightPluginKey.getState(state)
        }
      })
    ]
  }
})

export default GlossaryTermHighlight
