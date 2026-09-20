<template>
  <!--
    A real <textarea> with a highlighted copy of its own text painted underneath: the textarea's
    text is transparent, so what you read is the <pre> and what you type into is the textarea. The
    two only stay registered while they share every metric affecting glyph position -- see the
    style block. The textarea is what buys native undo/redo, selection, mobile keyboards, form
    semantics and screen-reader behaviour, which contenteditable and canvas editors do not.
  -->
  <div
    class="util-code-editor"
    :class="{ 'util-code-editor--square': square }"
    :style="{ height: `${minHeight}px`, '--util-code-editor-gutter': gutterWidth }">
    <pre class="util-code-editor-view" aria-hidden="true"><code v-html="highlighted" /></pre>
    <textarea
      ref="inputEl"
      class="util-code-editor-input"
      :value="modelValue"
      :aria-label="ariaLabel"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      @input="onInput"
      @scroll="onScroll"
      @keydown.tab.exact.prevent="onTab" />
  </div>
</template>

<script setup>
/**
 * Deliberately basic -- no bracket matching, autocomplete, folding, multiple cursors or find: the
 * call sites are short config fields, not worth an editor library's bundle cost.
 *
 * Not in `components/shared/`, despite being a form control: that library is registered eagerly, so
 * a `w-*` component here would pull the highlighter into the main bundle for every visitor. Imported
 * per call site instead, it stays in the lazy chunks of the few screens that use it.
 */
import { computed, ref } from 'vue'

// -> `lib/core` plus named languages, NOT the `highlight.js` root: that root registers every
//    language it ships, hundreds of kB of them
import hljs from 'highlight.js/lib/core'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  language: {
    type: String,
    default: 'plaintext'
  },
  /** A fixed height in px, not a floor: content beyond it scrolls. */
  minHeight: {
    type: Number,
    default: 150
  },
  ariaLabel: {
    type: String,
    default: null
  },
  /**
   * Sharp corners, for a field that spans its container edge to edge: where the editor IS the
   * surface, a radius cuts across the dialog's own edge instead of reading as an inset control.
   */
  square: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:modelValue'])

const inputEl = ref(null)

/* Module scope, not per instance: hljs keeps one global registry, so this would only repeat. */
hljs.registerLanguage('css', css)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

/*
  The `language` prop names the language the way the call sites already do; `html` is hljs's `xml`.
  A name absent here is escaped and left alone rather than throwing, so a new call site cannot break
  the field by asking for a language nobody added.
*/
const HLJS_LANGUAGES = {
  css: 'css',
  html: 'xml',
  javascript: 'javascript',
  json: 'json',
  yaml: 'yaml'
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/*
  hljs emits nothing but `<span class="…">`, `</span>` and escaped text, which is what makes this
  three-branch match sufficient.
*/
const HLJS_TOKENS = /<span class="[^"]*">|<\/span>|[^<]+/g

/**
 * A token can legitimately run across a newline -- a block comment, a template literal, a YAML
 * block scalar -- and its span then contains the break, so the string cannot simply be cut at "\n":
 * open spans are closed at the end of each line and reopened at the start of the next, or the line
 * elements nest inside one another and the numbering collapses to a single row.
 */
function splitHighlightedLines(html) {
  const lines = []
  const open = []
  let current = ''

  for (const [token] of html.matchAll(HLJS_TOKENS)) {
    if (token === '</span>') {
      open.pop()
      current += token
    } else if (token.startsWith('<span')) {
      open.push(token)
      current += token
    } else {
      // -> Text is the only branch that can hold a newline
      const parts = token.split('\n')
      for (const [index, part] of parts.entries()) {
        if (index > 0) {
          current += '</span>'.repeat(open.length)
          lines.push(current)
          current = open.join('')
        }
        current += part
      }
    }
  }

  lines.push(current)
  return lines
}

const lines = computed(() => {
  const value = props.modelValue ?? ''
  const language = HLJS_LANGUAGES[props.language]
  const html = language
    ? // -> Partial code is the normal state in a field being typed into: illegal syntax must not
      //   abort the highlight and blank the view
      hljs.highlight(value, { language, ignoreIllegals: true }).value
    : value.replace(/[&<>]/g, (c) => ESCAPES[c])

  return splitHighlightedLines(html)
})

/*
  One string rather than a v-for, so the whole view is one innerHTML write per keystroke instead of
  an element-by-element patch. `data-line` is what the gutter draws with `content: attr()`.
*/
const highlighted = computed(() =>
  lines.value
    .map(
      (line, index) => `<span class="util-code-editor-line" data-line="${index + 1}">${line}</span>`
    )
    .join('')
)

const gutterWidth = computed(() => `calc(${String(lines.value.length).length}ch + 1.35rem)`)

function onInput(ev) {
  emit('update:modelValue', ev.target.value)
}

function onScroll(ev) {
  const view = ev.target.previousElementSibling
  view.scrollTop = ev.target.scrollTop
}

/*
  Shift+Tab is deliberately NOT handled, so it still moves focus and a keyboard user is never trapped
  in the field.
*/
function onTab(ev) {
  const el = ev.target
  const { selectionStart: start, selectionEnd: end, value } = el
  emit('update:modelValue', `${value.slice(0, start)}  ${value.slice(end)}`)
  // -> Vue writing the new value back into the element drops the caret at the end; the plain input
  //    path never needs this because the DOM already holds what was emitted
  requestAnimationFrame(() => {
    el.selectionStart = start + 2
    el.selectionEnd = start + 2
  })
}

/*
  A method rather than an `autofocus` prop: focus is an action taken at a moment, not a state, and a
  dialog reopening with the same props has to be able to ask again.
*/
defineExpose({
  focus() {
    inputEl.value?.focus()
  }
})
</script>

<style>
/*
  Unscoped, but every selector is under `.util-code-editor`: the highlighted markup arrives through
  `v-html` and so carries no scope attribute, which a scoped rule could only reach through `:deep()`
  on every line of the palette below.
*/
.util-code-editor {
  position: relative;
  overflow: hidden;
  /* -> Same resting and focus edge as the other form controls; see `.w-input-control` */
  border: 1px solid rgb(0 0 0 / 0.24);
  background-color: #fff;
  transition: border-color 0.36s cubic-bezier(0.4, 0, 0.2, 1);
  /*
    The text metrics are repeated here, not only on the layers, for the `ch` in the gutter width:
    `ch` resolves against the element's own font, so against the page font the gutter would be sized
    for the wrong glyph.
  */
  font-family: var(--font-mono);
  font-size: 13px;

  /* -> The gutter stripe sits on the container, not the scrolling layer, so it stays put while the
        numbers within it scroll */
  background-image: linear-gradient(
    to right,
    #f6f8fa 0,
    #f6f8fa var(--util-code-editor-gutter),
    rgb(0 0 0 / 0.09) var(--util-code-editor-gutter),
    rgb(0 0 0 / 0.09) calc(var(--util-code-editor-gutter) + 1px),
    transparent calc(var(--util-code-editor-gutter) + 1px)
  );

  &:focus-within {
    border-color: var(--color-primary);
  }
}

/*
  -> A prop rather than a class the caller passes: the radius above is a single-class rule in an
     unlayered stylesheet, so an override would come down to which file the bundler happened to emit
     last.
*/
.util-code-editor--square {
  border-radius: 0;
}

/*
  Any difference between the two layers in a property that affects glyph position -- font, size,
  line height, letter spacing, tab size, padding, wrapping -- shows up as the highlight drifting out
  from under the text, further with every line. Change one, change both.
*/
.util-code-editor-view,
.util-code-editor-input {
  position: absolute;
  inset: 0;
  margin: 0;
  /* -> Text starts clear of the gutter on BOTH layers, or the two disagree by the gutter's width */
  padding: 8px 10px 8px calc(var(--util-code-editor-gutter) + 8px);
  border: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  tab-size: 2;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

.util-code-editor-view {
  overflow: hidden;
  /* -> Clicks belong to the textarea underneath, including the click that places the caret */
  pointer-events: none;
  color: #24292f;
}

/*
  The number is a pseudo-element on the line rather than a row in a parallel gutter list, which is
  what keeps it correct under soft wrapping: a line wrapping to three rows is one block three rows
  tall with its number at the top. A parallel list would drift by one row per wrap. It also means
  the numbers cannot be selected or copied.
*/
.util-code-editor-line {
  display: block;
  position: relative;

  /* -> An empty block would be zero rows high, so a blank line would collapse and take its number
        with it. Matches the `line-height` above; the two have to move together. */
  min-height: 1.5em;

  &::before {
    content: attr(data-line);
    position: absolute;
    /*
      Out into the stripe the container paints: 8px of the offset cancels the text's own left
      padding, the other 10px is the gap off the divider. No width or `text-align` needed -- a
      right-positioned box with no width shrinks to its content, so the digits right-align by
      themselves and the gap holds at any number of digits.
    */
    right: calc(100% + 18px);
    color: rgb(0 0 0 / 0.38);
  }
}

.util-code-editor-input {
  overflow: auto;
  resize: none;
  outline: none;
  background-color: transparent;
  /* -> The text is read off the layer below; only the caret and the selection band come from here */
  color: transparent;
  caret-color: #24292f;

  &::selection {
    background-color: rgb(25 118 210 / 0.28);
  }
}

/*
  Two flat token palettes keyed off `body--dark` rather than a per-theme stylesheet, so switching
  appearance is a class on <body> and the editors recolour instantly -- no fetch, no re-init, no JS.
*/
.util-code-editor {
  .hljs-comment,
  .hljs-quote {
    color: #6a737d;
    font-style: italic;
  }
  .hljs-keyword,
  .hljs-selector-tag,
  .hljs-literal,
  .hljs-doctag,
  .hljs-formula {
    color: #d73a49;
  }
  .hljs-string,
  .hljs-regexp,
  .hljs-addition,
  .hljs-selector-attr,
  .hljs-selector-pseudo {
    color: #032f62;
  }
  .hljs-number,
  .hljs-variable,
  .hljs-template-variable,
  .hljs-symbol,
  .hljs-bullet,
  .hljs-attr,
  .hljs-meta {
    color: #005cc5;
  }
  .hljs-title,
  .hljs-section,
  .hljs-selector-id,
  .hljs-selector-class {
    color: #6f42c1;
  }
  .hljs-built_in,
  .hljs-type,
  .hljs-attribute,
  .hljs-property,
  .hljs-params {
    color: #e36209;
  }
  .hljs-name,
  .hljs-tag {
    color: #22863a;
  }
  .hljs-deletion {
    color: #b31d28;
  }
  .hljs-emphasis {
    font-style: italic;
  }
  .hljs-strong {
    font-weight: 600;
  }
}

body.body--dark {
  .util-code-editor {
    border-color: rgb(255 255 255 / 0.3);
    background-color: var(--color-dark-5);
    background-image: linear-gradient(
      to right,
      var(--color-dark-4) 0,
      var(--color-dark-4) var(--util-code-editor-gutter),
      rgb(255 255 255 / 0.12) var(--util-code-editor-gutter),
      rgb(255 255 255 / 0.12) calc(var(--util-code-editor-gutter) + 1px),
      transparent calc(var(--util-code-editor-gutter) + 1px)
    );

    &:focus-within {
      border-color: var(--color-primary);
    }
  }

  .util-code-editor-view {
    color: #e6edf3;
  }

  .util-code-editor-line::before {
    color: rgb(255 255 255 / 0.34);
  }

  .util-code-editor-input {
    caret-color: #e6edf3;
  }

  .util-code-editor {
    .hljs-comment,
    .hljs-quote {
      color: #8b949e;
    }
    .hljs-keyword,
    .hljs-selector-tag,
    .hljs-literal,
    .hljs-doctag,
    .hljs-formula {
      color: #ff7b72;
    }
    .hljs-string,
    .hljs-regexp,
    .hljs-addition,
    .hljs-selector-attr,
    .hljs-selector-pseudo {
      color: #a5d6ff;
    }
    .hljs-number,
    .hljs-variable,
    .hljs-template-variable,
    .hljs-symbol,
    .hljs-bullet,
    .hljs-attr,
    .hljs-meta {
      color: #79c0ff;
    }
    .hljs-title,
    .hljs-section,
    .hljs-selector-id,
    .hljs-selector-class {
      color: #d2a8ff;
    }
    .hljs-built_in,
    .hljs-type,
    .hljs-attribute,
    .hljs-property,
    .hljs-params {
      color: #ffa657;
    }
    .hljs-name,
    .hljs-tag {
      color: #7ee787;
    }
    .hljs-deletion {
      color: #ffa198;
    }
  }
}
</style>
