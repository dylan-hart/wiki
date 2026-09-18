import { Blockquote } from '@tiptap/extension-blockquote'

/**
 * GitHub-style alerts for the WYSIWYG editor -- `> [!NOTE]` and friends -- ported from
 * `renderers/modules/github-alerts.js`'s own `KINDS`/`MARKER` detection (see that file's doc
 * comments for the mapping onto the content stylesheet's admonition classes) onto marked's
 * `blockquote` token instead of markdown-it's `blockquote_open`/`paragraph_open`/`inline` triplet.
 *
 * Extends the stock `Blockquote` node in place -- `kind`/`title` default to `null`/`''` for an
 * ordinary quote -- rather than registering a second, separate node under the SAME `blockquote`
 * markdown token. `@tiptap/markdown`'s `MarkdownManager.renderNodeToMarkdown` resolves a node's
 * renderer via `getHandlerForToken(node.type)`, which checks the PARSE registry (keyed by
 * `markdownTokenName`) before the render registry (keyed by the node's own name): a separate
 * `githubAlert` node sharing `markdownTokenName: 'blockquote'` for parsing would, once registered,
 * also get its `renderMarkdown` picked for every PLAIN `blockquote`-typed node in the document --
 * confirmed empirically (a plain `> quote` round-tripped back out as `> [!NOTE]\n>\n> quote`).
 * One extended node sidesteps that entirely: there is only ever one registration for the
 * `blockquote` token/node name, so this failure mode cannot occur.
 *
 * Registered in `EditorWysiwyg.vue`'s `buildExtensions()` in place of `StarterKit`'s own
 * `blockquote` (`blockquote: false`, the same pattern already used there for `codeBlock`/`link`).
 */
const KINDS = new Map([
  ['note', { className: 'is-info', label: 'Note' }],
  ['tip', { className: 'is-success', label: 'Tip' }],
  ['important', { className: 'is-important', label: 'Important' }],
  ['warning', { className: 'is-warning', label: 'Warning' }],
  ['caution', { className: 'is-danger', label: 'Caution' }],
  ['question', { className: 'is-question', label: 'Question' }]
])

const MARKER = /^\[!([a-z]+)\][ \t]*([^\n]*)(?:\n|$)/i

/** The stock Blockquote's own line-prefixing renderer (`@tiptap/extension-blockquote`, unexported). */
function renderPlainBlockquote(node, h) {
  if (!node.content) {
    return ''
  }
  const prefix = '>'
  return node.content
    .map((child, index) => {
      const rendered = h.renderChild ? h.renderChild(child, index) : h.renderChildren([child])
      return rendered
        .split('\n')
        .map((line) => (line.trim() === '' ? prefix : `${prefix} ${line}`))
        .join('\n')
    })
    .join(`\n${prefix}\n`)
}

export const GithubAlert = Blockquote.extend({
  name: 'blockquote',

  addAttributes() {
    return {
      // -> `null` (not `'note'`) so a plain blockquote's markdown JSON carries no alert attrs at
      //    all when serialized -- `alert-block`/`data-alert-kind` only ever appear on a real alert.
      kind: { default: null },
      title: { default: '' }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'blockquote[data-alert-kind]',
        getAttrs: (element) => ({
          kind: element.getAttribute('data-alert-kind') || 'note',
          title: element.getAttribute('data-alert-title') || ''
        })
      },
      { tag: 'blockquote' }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    if (!node.attrs.kind) {
      return this.parent?.({ node, HTMLAttributes }) ?? ['blockquote', HTMLAttributes, 0]
    }
    const kind = KINDS.get(node.attrs.kind) || KINDS.get('note')
    return [
      'blockquote',
      {
        ...HTMLAttributes,
        class: `alert-block ${kind.className}`,
        'data-alert-kind': node.attrs.kind,
        'data-alert-title': node.attrs.title
      },
      0
    ]
  },

  parseMarkdown: (token, h) => {
    const firstChild = token.tokens?.[0]
    const marker = firstChild?.type === 'paragraph' ? MARKER.exec(firstChild.text || '') : null
    const kind = marker && KINDS.get(marker[1].toLowerCase())

    const parseChildren = h.parseBlockChildren ?? h.parseChildren

    if (!kind) {
      return h.createNode('blockquote', undefined, parseChildren(token.tokens || []))
    }

    const title = (marker[2] || '').trim()
    const rest = (firstChild.text || '').slice(marker[0].length)

    // -> When the marker was the WHOLE first paragraph (the common case: `> [!NOTE]` on its own
    //    line, then a blank `>` line, then the body), marked's blockquote tokens are
    //    `[paragraph("[!NOTE]"), space, paragraph(body)]` -- the leading `space` token is the blank
    //    line that separated them. Dropped here rather than left in `bodyTokens`: `parseBlockChildren`
    //    reads a leading `space` as an IMPLICIT blank line before the first real block and inserts an
    //    extra empty paragraph for it, which is one blank line too many once `renderMarkdown` below
    //    already puts its own blank line between the marker and the body.
    let remainder = token.tokens.slice(1)
    while (remainder[0]?.type === 'space') {
      remainder = remainder.slice(1)
    }

    const bodyTokens = rest
      ? [
          { type: 'paragraph', raw: rest, text: rest, tokens: h.tokenizeInline?.(rest) ?? [] },
          ...remainder
        ]
      : remainder

    // -> `blockquote`'s content model is `block+` (at least one child) -- a bare `> [!NOTE]` with no
    //    body at all would otherwise parse to a node with empty content, which ProseMirror rejects
    //    outright (`Invalid content for node blockquote`). An empty paragraph placeholder keeps the
    //    node valid, and round-trips back to nothing (`renderMarkdown`'s own `body ? ... : marker-only`
    //    branch, below) exactly like a genuinely marker-only alert does.
    const content = parseChildren(bodyTokens)

    return h.createNode(
      'blockquote',
      { kind: marker[1].toLowerCase(), title },
      content.length ? content : [{ type: 'paragraph' }]
    )
  },

  renderMarkdown: (node, h) => {
    if (!node.attrs?.kind) {
      return renderPlainBlockquote(node, h)
    }

    const kind = node.attrs.kind.toUpperCase()
    const title = node.attrs.title ? ` ${node.attrs.title}` : ''
    const body = h.renderChildren(node.content || [], '\n\n')
    const content = body ? `[!${kind}]${title}\n\n${body}` : `[!${kind}]${title}`

    const prefix = '>'
    return content
      .split('\n')
      .map((line) => (line.trim() === '' ? prefix : `${prefix} ${line}`))
      .join('\n')
  }
})

export default GithubAlert
