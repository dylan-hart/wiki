import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * Highlights recognized glossary terms in the WYSIWYG editor -- the editor-side counterpart to
 * `renderers/modules/markdown-it-glossary.js`'s own term matching (see that file's doc comments for
 * the case-insensitive whole-word boundary rule this ports).
 *
 * Deliberately **not** a stored mark or node. There is no markdown syntax for a glossary term --
 * the renderer recognizes one by matching a live term list against otherwise-plain text at render
 * time, not from anything an author typed. A stored, editable mark would have to either invent
 * syntax the renderer knows nothing about, or silently desync from the term list the moment a term
 * is renamed or removed after the mark was applied. Decorations sidestep both: they are a pure
 * VIEW-layer overlay (`Decoration.inline`), never part of the document, so the round-trip
 * (`markdown -> editor -> markdown`) acceptance criterion holds by construction -- content the
 * decorations point at cannot itself change because of them.
 *
 * `options.terms` is read once, at construction (`EditorWysiwyg.vue`'s `buildExtensions()` passes
 * `editorStore.editors.markdown?.glossaryTerms` at editor-build time) -- it does not live-update if
 * the term list changes again later in the same editing session. Acceptable for this pass: a
 * within-session term edit is rare, and the decorations recompute on every keystroke regardless (the
 * `terms` list itself just does not refresh mid-session without a remount). A live-updating version
 * would need a way to push new terms into a running editor's plugin state, which is out of scope
 * here.
 *
 * Deliberately skips the renderer's "suppress inside an existing markdown link" rule
 * (`markdown-it-glossary.js`'s `insideLink` tracking): that rule exists there to avoid emitting an
 * invalid nested `<a>` in the published page's literal HTML. A decoration is a non-nesting CSS
 * overlay, not a wrapping tag, so the concern it guards against does not apply here.
 */
/** Exported so a test (or a future live-update caller) can read the plugin's decoration state directly. */
export const glossaryTermHighlightPluginKey = new PluginKey('glossaryTermHighlight')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Builds a single case-insensitive alternation over every term's surface forms (its own name plus
 * every alias), longest first so a more specific alias wins over a shorter term it contains -- the
 * same ordering rule `markdown-it-glossary.js` documents. Bounded with Unicode-aware
 * letter/number/underscore lookaround (a `\b`-alike that also works outside ASCII) rather than
 * `markdown-it-glossary.js`'s own explicit boundary-character class -- simpler to get right on a
 * plain JS string, and this only ever runs against a text node's own content, never markdown source
 * where a literal `$`/backtick/etc right against a term would matter the way it does there.
 *
 * @example
 * buildMatcher([{ term: 'API', definition: 'Application Programming Interface' }])
 * // → a RegExp matching whole-word "API" (case-insensitively), plus a lookup Map back to the entry
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
      // -> Guards against a zero-width match looping forever (not expected with this pattern, but
      //    cheap insurance against a future edit that introduces one).
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
