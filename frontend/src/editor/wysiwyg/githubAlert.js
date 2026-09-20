import { Blockquote } from '@tiptap/extension-blockquote'

/**
 * Extends the stock `Blockquote` in place rather than registering a second node under the same
 * `blockquote` markdown token: `@tiptap/markdown`'s `MarkdownManager.renderNodeToMarkdown` resolves
 * a renderer through the parse registry (keyed by `markdownTokenName`) before the render registry,
 * so a separate node sharing that token would also render every plain blockquote as an alert.
 *
 * It claims the `blockquote` node name, so `StarterKit` must be registered with `blockquote: false`
 * alongside it.
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

/** Duplicates `@tiptap/extension-blockquote`'s line-prefixing renderer, which it does not export. */
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
      // -> `null`, not `'note'`, so a plain blockquote serializes with no alert attrs at all.
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

    // -> For a marker on its own line marked emits `[paragraph("[!NOTE]"), space, paragraph(body)]`.
    //    `parseBlockChildren` reads that leading `space` as an implicit blank line and inserts an
    //    empty paragraph for it -- one blank line too many, since `renderMarkdown` below already
    //    puts its own between marker and body.
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

    // -> `blockquote`'s content model is `block+`, so a bare `> [!NOTE]` would parse to empty
    //    content that ProseMirror rejects outright. The placeholder paragraph keeps the node valid
    //    and round-trips back to a marker-only alert.
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
