import MarkdownIt from 'markdown-it'
import mdAttrs from 'markdown-it-attrs'
import { full as mdEmoji } from 'markdown-it-emoji'
import mdAbbr from 'markdown-it-abbr'
import mdSup from 'markdown-it-sup'
import mdSub from 'markdown-it-sub'
import mdMark from 'markdown-it-mark'
import mdFootnote from 'markdown-it-footnote'
import mdDeflist from 'markdown-it-deflist'
import mdUnderline from './modules/markdown-it-underline'
import mdExpandTabs from './modules/markdown-it-expand-tabs'
import mdTable from './modules/markdown-it-table'
import mdImsize from './modules/markdown-it-imsize'
import mdGithubAlerts from './modules/github-alerts'
import mdGlossary from './modules/markdown-it-glossary'
import mdBlocks from './modules/markdown-it-blocks'
import mdIconShortcode from './modules/markdown-it-icon-shortcode'
import mdTex from './modules/markdown-it-tex'
import mdTaskLists from './modules/markdown-it-task-lists'
import twemoji from '@twemoji/api'

// -> `lib/common`, not the `highlight.js` root: the root registers every language the package ships
//    into this chunk whether or not a page ever fences one. hljs is a module-singleton registry, so
//    `EditorCodeBlockMenu.vue` must import the SAME module -- anything narrower or wider here splits
//    what the fence-language picker offers from what this renderer can highlight.
import hljs from 'highlight.js/lib/common'

import { escape } from 'es-toolkit/string'

import { fileSrc, rewriteHtmlImages } from './htmlImages'

const quoteStyles = {
  chinese: '””‘’',
  english: '“”‘’',
  french: ['«\xA0', '\xA0»', '‹\xA0', '\xA0›'],
  german: '„“‚‘',
  greek: '«»‘’',
  japanese: '「」「」',
  hungarian: '„”’’',
  polish: '„”‚‘',
  portuguese: '«»‘’',
  russian: '«»„“',
  spanish: '«»‘’',
  swedish: '””’’'
}

/**
 * `siteOrigin` -- the site's real, public origin -- is preferred over `globalThis.location?.href`: the
 * headless re-render (`backend/models/rendering.ts`) runs this same bundle in a browser navigated to
 * its own loopback address, where `location` would judge an absolute link to this very wiki external
 * and disagree with what the editor's save produced. The in-editor render is already on the site's
 * hostname and passes nothing.
 *
 * Anything that is not http(s) is not a page at all, and is left unmarked rather than called external.
 */
function isExternalHref(href, siteOrigin) {
  if (!href) {
    return false
  }
  const here = siteOrigin || globalThis.location?.href
  try {
    const url = new URL(href, here)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false
    }
    return here ? url.origin !== new URL(here).origin : true
  } catch {
    return false
  }
}

/**
 * The lookahead rather than a `\b`: a hyphen ends a word, so a boundary alone also matches the start
 * of `<iconify-icon-something />` and would close it with the wrong tag.
 */
const SELF_CLOSED_ICON = /<iconify-icon(?![\w-])([^>]*?)\s*\/>/gi

/**
 * `/>` closes nothing in HTML outside the void elements, so the parser hands the icon the rest of the
 * paragraph as children -- and `iconify-icon` draws a shadow root with no slot in it, so that text
 * lands on the page invisible. Authors write the self-closed form anyway, and it is unambiguous: an
 * icon has no content.
 *
 * Run over the author's own HTML rather than over the finished render, so that an `<iconify-icon />`
 * shown INSIDE a code block stays exactly as it was written -- that text is escaped by then and is
 * not raw HTML at all.
 */
function closeIconTags(html) {
  return html.replace(SELF_CLOSED_ICON, '<iconify-icon$1></iconify-icon>')
}

function renameAttr(token, from, to) {
  const i = token.attrIndex(from)
  if (i < 0) {
    return
  }
  const value = token.attrs[i][1]
  token.attrs.splice(i, 1)
  token.attrSet(to, value)
}

function asDiv(tokens, idx, options, env, slf) {
  tokens[idx].tag = 'div'
  return slf.renderToken(tokens, idx, options, env, slf)
}

function asGridRole(role) {
  return (tokens, idx, options, env, slf) => {
    tokens[idx].attrSet('role', role)
    return asDiv(tokens, idx, options, env, slf)
  }
}

function asGridCell(role) {
  return (tokens, idx, options, env, slf) => {
    const token = tokens[idx]
    renameAttr(token, 'colspan', 'aria-colspan')
    renameAttr(token, 'rowspan', 'aria-rowspan')
    return asGridRole(role)(tokens, idx, options, env, slf)
  }
}

/**
 * Shaped to match what an authored `> [!CAUTION]` GitHub-style admonition (`modules/github-alerts.js`'s
 * `caution` kind: `is-danger` / "Caution") renders as, so a reader sees the same object whether the
 * callout came from their own markdown or from this substitution.
 *
 * Duplicated in the backend's `helpers/htmlSanitizePolicy.ts#gatedContentPlaceholder()` rather than
 * imported -- the two workspaces share no module boundary -- so a wording change has to land in both.
 * Each side's own test pins the exact string.
 */
export function gatedContentPlaceholder(permission) {
  return `<blockquote class="is-danger"><p class="alert-title">Caution</p><p>This content requires the ${permission} permission and was not rendered.</p></blockquote>`
}

/**
 * Mirrors the `write:scripts`/`write:styles` gate `helpers/htmlSanitizePolicy.ts`'s
 * `RenderPermissions` applies server-side, so the preview does not silently show an embed the save is
 * about to sanitize out.
 *
 * Deliberately not folded into `MarkdownRenderer#render()`: that method is also what
 * `renderers/headless.js` calls for the re-render queue, and that caller must keep getting back
 * unsanitized HTML -- `models/rendering.ts#postProcess` on the other end sanitizes it against
 * whichever actor's permissions actually apply. Only a caller that already knows which permissions
 * the PREVIEW is for reaches for this.
 *
 * Parses into a `<template>` rather than the live preview DOM: a template's content is inert, so
 * scanning it for a gated tag never risks running the very thing being asked whether it may run.
 *
 * @param {{ scripts: boolean, styles: boolean }} permissions
 */
export function sanitizeForPreview(html, permissions) {
  if (permissions?.scripts && permissions?.styles) {
    return html ?? ''
  }

  const holder = document.createElement('template')
  holder.innerHTML = html ?? ''

  const replaceGated = (selector, permission) => {
    for (const el of holder.content.querySelectorAll(selector)) {
      const placeholder = document.createElement('template')
      placeholder.innerHTML = gatedContentPlaceholder(permission)
      el.replaceWith(...placeholder.content.childNodes)
    }
  }

  if (!permissions?.scripts) {
    replaceGated('iframe, script', 'write:scripts')
  }
  if (!permissions?.styles) {
    replaceGated('style', 'write:styles')
  }

  return holder.innerHTML
}

const FENCE_ATTRIBUTE =
  /([a-z][\w-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s"']+))/gi

export function parseFenceAttributes(source, unescape = (value) => value) {
  const attributes = {}
  for (const match of (source ?? '').matchAll(FENCE_ATTRIBUTE)) {
    attributes[match[1].toLowerCase()] = unescape(match[2] ?? match[3] ?? match[4])
  }
  return attributes
}

export function parseFenceInfo(info, unescape = (value) => value) {
  const trimmed = (info ?? '').trim()
  const boundary = trimmed.search(/\s/)
  return {
    lang: unescape(boundary < 0 ? trimmed : trimmed.slice(0, boundary)),
    attributes: parseFenceAttributes(boundary < 0 ? '' : trimmed.slice(boundary + 1), unescape)
  }
}

const LINE_RANGE = /^(\d+)(?:\s*-\s*(\d+))?$/

export function parseLineRanges(value) {
  const ranges = []
  for (const entry of (value ?? '').split(',')) {
    const match = LINE_RANGE.exec(entry.trim())
    if (!match) {
      continue
    }
    const from = Number(match[1])
    const to = match[2] === undefined ? from : Number(match[2])
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
      continue
    }
    ranges.push([Math.min(from, to), Math.max(from, to)])
  }
  return ranges
}

export function parseLineStart(value) {
  if (!/^\d+$/.test((value ?? '').trim())) {
    return 1
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) ? parsed : 1
}

function inRanges(ranges, line) {
  return ranges.some(([from, to]) => line >= from && line <= to)
}

function lineRows(lineCount, lineStart, highlights) {
  const rows = []
  for (let index = 0; index < lineCount; index++) {
    rows.push(
      inRanges(highlights, lineStart + index)
        ? '<span class="is-highlighted"></span>'
        : '<span></span>'
    )
  }
  return `<span aria-hidden="true" class="line-numbers-rows">${rows.join('')}</span>`
}

function codeBlock(str, lang, attributes) {
  if (['drawio', 'kroki', 'mermaid', 'plantuml'].includes(lang)) {
    /*
      Left as source, deliberately: the diagram is drawn by the block whose body this fence is
      (`block-diagram`, `block-plantuml`, `block-kroki`, `block-drawio`), each of which reads
      the text back out of this `pre`. A fence outside any block keeps the panel the stylesheet
      gives it, which reads as "a diagram nobody has drawn" rather than as a code sample.
    */
    return `<pre class="codeblock-${lang}"><code>${escape(str)}</code></pre>`
  }

  /*
    `getLanguage` first, because `hljs.highlight` THROWS on a language it does not know --
    `ignoreIllegals` only forgives illegal syntax within a language it does. markdown-it takes
    the first word of a fence's info string as the language name, so a fence whose code starts
    on the opening line asks for a language called `<!DOCTYPE`, and the throw takes the whole
    render with it -- an empty preview, and an empty render saved over the stored HTML.

    The fallback must ESCAPE: `str` is the author's raw source, and only hljs escapes what it
    emits.
  */
  const highlighted =
    lang && hljs.getLanguage(lang)
      ? hljs.highlight(str, { language: lang, ignoreIllegals: true })
      : { value: escape(str) }
  // -> `match` is null, not empty, when the code is a single line with no trailing newline
  const lineCount = (highlighted.value.match(/\n/g) ?? []).length

  const lineStart = parseLineStart(attributes.linesstart)
  const highlights = parseLineRanges(attributes.lineshighlight)
  const numbered = lineCount > 1
  const rows =
    numbered || highlights.length > 0 ? lineRows(Math.max(lineCount, 1), lineStart, highlights) : ''
  const start = lineStart === 1 ? '' : ` data-line-start="${lineStart}"`
  // -> `lang` is escaped too: it is whatever the author typed after the backticks, and a quote
  //    in it would otherwise close the attribute and inject markup into the preview
  // -> A ternary, not `&&`: for a single-line block `&&` short-circuits to the boolean
  //    `false`, which interpolates as the literal string "false" into the class attribute --
  //    and this render is both the preview AND what gets saved
  const pre = `<pre class="codeblock hljs${numbered ? ' line-numbers' : ''}"${start}><code class="language-${escape(lang ?? '')}">${highlighted.value}${rows}</code></pre>`
  const title = (attributes.title ?? '').trim()
  return title
    ? `<div class="codeblock-titled hljs"><div class="codeblock-title">${escape(title)}</div>${pre}</div>`
    : pre
}

export class MarkdownRenderer {
  constructor(config = {}) {
    this.md = new MarkdownIt({
      html: config.allowHTML,
      breaks: config.lineBreaks,
      linkify: config.linkify,
      typographer: config.typographer,
      quotes: quoteStyles[config.quotes] ?? quoteStyles.english
    })
      .use(mdAttrs, {
        // -> `style` is here for the WYSIWYG editor's text-colour/highlight-colour/font-family/
        //    text-align marks, which serialize as a trailing `{style="…"}` on a heading/paragraph's
        //    own line. This allowlist only decides whether the `style` ATTRIBUTE survives at all;
        //    `backend/helpers/htmlSanitizePolicy.ts`'s `ALLOWED_STYLES` is what restricts the CSS
        //    declarations inside it for an author without `write:styles`.
        allowedAttributes: ['id', 'class', 'target', 'style']
      })
      .use(mdEmoji)
      .use(mdTaskLists, { label: false, labelAfter: false })
      .use(mdExpandTabs, { tabWidth: config.tabWidth })
      .use(mdAbbr)
      .use(mdSup)
      .use(mdSub)
      .use(mdMark)
      .use(mdFootnote)
      .use(mdDeflist)
      .use(mdImsize)
      .use(mdGithubAlerts)
      .use(mdGlossary, { terms: config.glossaryTerms })
      .use(mdBlocks)
      .use(mdIconShortcode)
      .use(mdTex)

    if (config.underline) {
      this.md.use(mdUnderline)
    }

    /*
      `./modules/markdown-it-table.js` is a from-scratch replacement for `markdown-it-multimd-table`,
      which calls a `md.utils.assign` helper markdown-it dropped in v14 and so throws out of its own
      constructor on 15, with no release since Aug 2023 to fix it.
    */
    if (config.multimdTable) {
      this.md.use(mdTable, { multiline: true, rowspan: true, headerless: true })
    }

    /*
      Marked at render time with a class, because it cannot be decided in CSS: a selector can match on
      the shape of an href but not compare its host with the wiki's own, which is the whole question.
    */
    this.md.renderer.rules.link_open = (tokens, idx, options, env, slf) => {
      if (isExternalHref(tokens[idx].attrGet('href'), env?.siteOrigin)) {
        tokens[idx].attrJoin('class', 'is-external-link')
      }
      return slf.renderToken(tokens, idx, options, env, slf)
    }

    /*
      A rendered table is CSS Grid, not a real `<table>`: every rule below retags its token to a
      `<div>` and adds the matching ARIA role. The reason is `border-collapse: collapse` -- combined
      with an ancestor `overflow: hidden` + `border-radius` clip it is a known cross-browser gap, in
      which a collapsed table's borders and backgrounds do not respect the ancestor's clip and square
      corners bleed past a rounded frame. A `<table>` carries that intrinsically, so no
      container-level fix exists.

      `thead`/`tbody` render as nothing: an ARIA grid has no row-group concept -- every `role="row"`
      sits directly under `role="table"` -- and `table`/`row`/`columnheader`/`cell` are the whole of
      what a screen reader needs to read this back as a table.

      `colspan`/`rowspan` become `aria-colspan`/`aria-rowspan`: the HTML attributes are meaningless on
      a `<div>` and the backend sanitizer does not allow them there either, while `aria-*` already
      passes its blanket allowance, so a spanned cell survives a save with no sanitizer change.
    */
    this.md.renderer.rules.table_open = (tokens, idx, options, env, slf) =>
      `<div class="table-wrap"><div class="table-clip"><div class="table-scroll">${asGridRole('table')(tokens, idx, options, env, slf)}`
    this.md.renderer.rules.table_close = (tokens, idx, options, env, slf) =>
      `${asDiv(tokens, idx, options, env, slf)}</div></div></div>`

    this.md.renderer.rules.thead_open = () => ''
    this.md.renderer.rules.thead_close = () => ''
    this.md.renderer.rules.tbody_open = () => ''
    this.md.renderer.rules.tbody_close = () => ''

    this.md.renderer.rules.tr_open = asGridRole('row')
    this.md.renderer.rules.tr_close = asDiv

    this.md.renderer.rules.th_open = asGridCell('columnheader')
    this.md.renderer.rules.th_close = asDiv

    this.md.renderer.rules.td_open = asGridCell('cell')
    this.md.renderer.rules.td_close = asDiv

    /*
      A caption is retagged too, and has to be: the WHATWG "in body" insertion mode treats a `caption`
      start tag outside an ACTUAL `<table>` as a parse error and drops it, spilling its text out as a
      bare text node -- and `table_open` above has already made sure no `<table>` exists for it to be
      inside. A `<div>` is not subject to that rule.

      `.table-caption` is what `_page-contents.css`'s grid rules key off to place it, including
      ordering a bottom caption (`style="caption-side: bottom"`, set by the table module) to the
      visual end of the grid, since a caption's tokens sit wherever it was authored.
    */
    this.md.renderer.rules.caption_open = (tokens, idx, options, env, slf) => {
      tokens[idx].attrJoin('class', 'table-caption')
      return asDiv(tokens, idx, options, env, slf)
    }
    this.md.renderer.rules.caption_close = asDiv

    /*
      Wrapped around whichever rule is in place rather than replacing it: the default one is what turns
      an image token's children into its `alt` text, and `markdown-it-imsize` has already put the size
      it parsed on the same token.
    */
    const renderImage =
      this.md.renderer.rules.image ??
      ((tokens, idx, options, env, slf) => slf.renderToken(tokens, idx, options, env, slf))
    this.md.renderer.rules.image = (tokens, idx, options, env, slf) => {
      const src = tokens[idx].attrGet('src')
      if (src) {
        tokens[idx].attrSet('src', fileSrc(src, env?.pagePath))
      }
      return renderImage(tokens, idx, options, env, slf)
    }

    /*
      An `<img>` the author wrote as HTML never becomes a token to hold an attribute, so it is the
      rendered text that gets rewritten. A self-closed `<iconify-icon />` is fixed in the same pass:
      these two rules are the only point at which the author's own markup is still distinguishable
      from the markup the renderer produced.
    */
    const passthrough = (tokens, idx) => tokens[idx].content
    for (const rule of ['html_block', 'html_inline']) {
      const renderHtml = this.md.renderer.rules[rule] ?? passthrough
      this.md.renderer.rules[rule] = (tokens, idx, options, env, slf) =>
        closeIconTags(rewriteHtmlImages(renderHtml(tokens, idx, options, env, slf), env?.pagePath))
    }

    /*
      Drawn from this instance, never from a CDN: the callback replaces twemoji's default `base` +
      size + extension entirely, so the `src` is the whole path and nothing upstream is contacted for
      it. `vite.config.js` puts the SVGs at `/_assets/svg/twemoji/` — copied into the build output,
      served out of `node_modules` in dev — so the two have to agree on this path.
    */
    this.md.renderer.rules.emoji = (token, idx) => {
      return twemoji.parse(token[idx].content, {
        callback(icon, opts) {
          return `/_assets/svg/twemoji/${icon}.svg`
        }
      })
    }

    this.md.renderer.rules.fence = (tokens, idx) => {
      const { lang, attributes } = parseFenceInfo(tokens[idx].info, (value) =>
        this.md.utils.unescapeAll(value)
      )
      return `${codeBlock(tokens[idx].content, lang, attributes)}\n`
    }

    // -> For the editor preview's scroll sync
    this.linesMap = []
    const injectLineNumbers = (tokens, idx, options, env, slf) => {
      let line
      if (tokens[idx].map && tokens[idx].level === 0) {
        line = tokens[idx].map[0] + 1
        tokens[idx].attrJoin('class', 'line')
        tokens[idx].attrSet('data-line', String(line))
        this.linesMap.push(line)
      }
      return slf.renderToken(tokens, idx, options, env, slf)
    }
    this.md.renderer.rules.paragraph_open = injectLineNumbers
    this.md.renderer.rules.heading_open = injectLineNumbers
    this.md.renderer.rules.blockquote_open = injectLineNumbers

    /*
      Every tabset, in order, as the source line range of each of its panels.

      For the editor: a `block-tabs` in the preview keeps which panel is open in its own state, and the
      preview is rebuilt from scratch on every keystroke — so without a way to say WHICH panel the
      caret is in, writing inside the second panel throws the author back to the first.

      Read from the token stream rather than by scanning the source for `::block-tab`, so it cannot
      drift from the markup the same parse produced.
    */
    this.tabsMap = []
    this.md.core.ruler.push('collect_tabsets', (state) => {
      this.tabsMap = []
      // -> A stack, because a tabset may sit inside another one; a panel belongs to the innermost
      const open = []
      for (const token of state.tokens) {
        if (token.tag === 'block-tabs' && token.type === 'wiki_block_open') {
          const tabset = []
          this.tabsMap.push(tabset)
          open.push(tabset)
        } else if (token.tag === 'block-tabs' && token.type === 'wiki_block_close') {
          open.pop()
        } else if (
          token.tag === 'block-tab' &&
          token.type === 'wiki_block_open' &&
          token.map &&
          open.length > 0
        ) {
          open.at(-1).push(token.map)
        }
      }
    })
  }

  /**
   * @param {string} [pagePath] Path of the page this source belongs to, without a leading slash --
   *                            what a relative image resolves against (`fileSrc`).
   * @param {string} [siteOrigin] The site's real public origin. Only the headless re-render passes
   *                              this -- see `isExternalHref`.
   */
  render(src, { pagePath = '', siteOrigin } = {}) {
    this.linesMap = []
    // -> A fresh env every time: markdown-it keeps per-render state in it (footnotes, references),
    //    and one shared between renders would carry the last one's
    return this.md.render(src, { pagePath, siteOrigin })
  }

  getClosestPreviewLine(line) {
    return this.linesMap.findLast((n) => n <= line)
  }

  /**
   * The innermost panel wins, so a tabset within a tabset answers for its own lines: the map is built
   * outermost-first, so a later match is a deeper one and the loop keeps the last rather than the
   * first.
   *
   * @param {number} line A 1-based editor line, as Monaco counts them.
   * @returns {{tabset: number, tab: number}|null} Indices into `tabsMap`, or null outside any tabset.
   */
  getTabAtLine(line) {
    let found = null
    for (const [tabset, tabs] of this.tabsMap.entries()) {
      for (const [tab, map] of tabs.entries()) {
        /*
          `map` is 0-based and ends one past the panel's last line of content -- exactly the line its
          closing `::` sits on -- so the end is treated as inclusive and a caret resting on that
          marker still counts as being in the panel.
        */
        if (line - 1 >= map[0] && line - 1 <= map[1]) {
          found = { tabset, tab }
        }
      }
    }
    return found
  }
}
