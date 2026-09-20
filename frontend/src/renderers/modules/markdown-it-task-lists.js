// Vendored from markdown-it-task-lists 2.1.1 (https://github.com/revin/markdown-it-task-lists),
// converted to ESM. Upstream is abandoned, but its checkbox markup is load-bearing for this fork's
// styling and tiptap task-list extensions.
//
// One functional change from upstream: `disableCheckboxes` / `useLabelWrapper` / `useLabelAfter`
// live in the plugin closure rather than at module level, so two MarkdownIt instances `.use()`-ing
// this plugin with different options no longer share whichever was configured LAST. The HTML each
// helper emits is unchanged.
//
// ---
// ISC License
//
// Copyright (c) 2016, Revin Guillen
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
// ---

export default function markdownItTaskLists(md, options) {
  let disableCheckboxes = true
  let useLabelWrapper = false
  let useLabelAfter = false

  if (options) {
    disableCheckboxes = !options.enabled
    useLabelWrapper = !!options.label
    useLabelAfter = !!options.labelAfter
  }

  function attrSet(token, name, value) {
    const index = token.attrIndex(name)
    const attr = [name, value]

    if (index < 0) {
      token.attrPush(attr)
    } else {
      token.attrs[index] = attr
    }
  }

  function parentToken(tokens, index) {
    const targetLevel = tokens[index].level - 1
    for (let i = index - 1; i >= 0; i--) {
      if (tokens[i].level === targetLevel) {
        return i
      }
    }
    return -1
  }

  function isInline(token) {
    return token.type === 'inline'
  }

  function isParagraph(token) {
    return token.type === 'paragraph_open'
  }

  function isListItem(token) {
    return token.type === 'list_item_open'
  }

  function startsWithTodoMarkdown(token) {
    // leading whitespace in a list item is already trimmed off by markdown-it
    return (
      token.content.indexOf('[ ] ') === 0 ||
      token.content.indexOf('[x] ') === 0 ||
      token.content.indexOf('[X] ') === 0
    )
  }

  function isTodoItem(tokens, index) {
    return (
      isInline(tokens[index]) &&
      isParagraph(tokens[index - 1]) &&
      isListItem(tokens[index - 2]) &&
      startsWithTodoMarkdown(tokens[index])
    )
  }

  function makeCheckbox(token, TokenConstructor) {
    const checkbox = new TokenConstructor('html_inline', '', 0)
    const disabledAttr = disableCheckboxes ? ' disabled="" ' : ''
    if (token.content.indexOf('[ ] ') === 0) {
      checkbox.content =
        '<input class="task-list-item-checkbox"' + disabledAttr + 'type="checkbox">'
    } else if (token.content.indexOf('[x] ') === 0 || token.content.indexOf('[X] ') === 0) {
      checkbox.content =
        '<input class="task-list-item-checkbox" checked=""' + disabledAttr + 'type="checkbox">'
    }
    return checkbox
  }

  function beginLabel(TokenConstructor) {
    const token = new TokenConstructor('html_inline', '', 0)
    token.content = '<label>'
    return token
  }

  function endLabel(TokenConstructor) {
    const token = new TokenConstructor('html_inline', '', 0)
    token.content = '</label>'
    return token
  }

  function afterLabel(content, id, TokenConstructor) {
    const token = new TokenConstructor('html_inline', '', 0)
    token.content = '<label class="task-list-item-label" for="' + id + '">' + content + '</label>'
    token.attrs = [{ for: id }]
    return token
  }

  function todoify(token, TokenConstructor) {
    token.children.unshift(makeCheckbox(token, TokenConstructor))
    token.children[1].content = token.children[1].content.slice(3)
    token.content = token.content.slice(3)

    if (useLabelWrapper) {
      if (useLabelAfter) {
        token.children.pop()

        const id = 'task-item-' + Math.ceil(Math.random() * (10000 * 1000) - 1000)
        token.children[0].content = token.children[0].content.slice(0, -1) + ' id="' + id + '">'
        token.children.push(afterLabel(token.content, id, TokenConstructor))
      } else {
        token.children.unshift(beginLabel(TokenConstructor))
        token.children.push(endLabel(TokenConstructor))
      }
    }
  }

  md.core.ruler.after('inline', 'github-task-lists', function (state) {
    const tokens = state.tokens
    for (let i = 2; i < tokens.length; i++) {
      if (isTodoItem(tokens, i)) {
        todoify(tokens[i], state.Token)
        attrSet(tokens[i - 2], 'class', 'task-list-item' + (!disableCheckboxes ? ' enabled' : ''))
        attrSet(tokens[parentToken(tokens, i - 2)], 'class', 'contains-task-list')
      }
    }
  })
}
