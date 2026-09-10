import MarkdownIt from 'markdown-it'
import mdAttrs from 'markdown-it-attrs'
import { full as mdEmoji } from 'markdown-it-emoji'
import mdTaskLists from 'markdown-it-task-lists'
import mdExpandTabs from 'markdown-it-expand-tabs'
import mdAbbr from 'markdown-it-abbr'
import mdSup from 'markdown-it-sup'
import mdSub from 'markdown-it-sub'
import mdMark from 'markdown-it-mark'
import mdMultiTable from 'markdown-it-multimd-table'
import mdFootnote from 'markdown-it-footnote'
import mdMdc from 'markdown-it-mdc'
import mdUnderline from './modules/markdown-it-underline'
import mdImsize from './modules/markdown-it-imsize'
import mdGithubAlerts from './modules/github-alerts'
import mdGlossary from './modules/markdown-it-glossary'
import mdMdcCompat from './modules/markdown-it-mdc-compat'
import mdIconShortcode from './modules/markdown-it-icon-shortcode'
import mdTex from './modules/markdown-it-tex'
import twemoji from '@twemoji/api'

// -> `lib/common`, not the `highlight.js` root: the root registers every language the package ships
//    (~190, several hundred kB gzipped) into this renderer's chunk regardless of whether any page on
//    the wiki ever fences one of them. `lib/common` registers ~36 of the most commonly written
//    languages instead -- `EditorCodeBlockMenu.vue` imports the SAME module, since hljs is a
//    module-singleton registry: importing anything narrower or wider here than there would silently
//    split what the fence-language picker offers from what this renderer can actually highlight. A
//    fence naming a language outside that set still renders -- see the `getLanguage` guard below --
//    just without highlighting, the same as it always has for a typo'd or unknown language.
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
 * Whether a link leaves this wiki.
 *
 * Resolved against the page's own address, so a relative path, an absolute one and a protocol-relative
 * URL are all judged the same way -- by the host they end up on. `mailto:`, `tel:` and the rest are not
 * pages at all, and are left unmarked: they announce themselves by what they are.
 *
 * `siteOrigin` -- the site's real, public origin -- is preferred over `globalThis.location?.href` when
 * given. The in-editor render runs in the author's own browser, already on the site's hostname, so
 * `location` is correct there and `siteOrigin` is not passed. The headless re-render
 * (`backend/models/rendering.ts`) instead runs the identical bundle in a headless browser navigated to
 * its own loopback address -- `location` there is never the site's hostname, so without `siteOrigin` an
 * absolute link to this same wiki would be judged external, disagreeing with what the editor's save
 * just produced. See OpenProject #1751.
 *
 * With no document to resolve against -- neither a `siteOrigin` nor a browser `location` -- only an
 * absolute URL can be judged, and it is judged external; a relative one fails to parse and comes back
 * internal.
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
 * An `<iconify-icon>` written the way a Vue component is, `<iconify-icon icon="tabler:home" />`.
 *
 * The lookahead rather than a `\b`: a hyphen ends a word, so a boundary alone also matches the start
 * of `<iconify-icon-something />` and would close it with the wrong tag.
 */
const SELF_CLOSED_ICON = /<iconify-icon(?![\w-])([^>]*?)\s*\/>/gi

/**
 * Give a self-closed icon the closing tag it actually needs.
 *
 * `/>` closes nothing in HTML outside the void elements, so the parser hands the icon the rest of the
 * paragraph as children -- and `iconify-icon` draws a shadow root with no slot in it, so that text
 * lands on the page invisible. The form is the one anybody writes, having seen it in every framework
 * for twenty years, and it is unambiguous about what was meant: an icon has no content.
 *
 * Done here, over the author's own HTML, rather than over the finished render, so that a `<iconify-icon
 * />` shown INSIDE a code block stays exactly as it was written -- that text is escaped by the time it
 * is rendered and is not raw HTML at all. `models/rendering.ts` lifts out anything that got nested
 * anyway, since a render can also arrive from something that is not this renderer.
 */
function closeIconTags(html) {
  return html.replace(SELF_CLOSED_ICON, '<iconify-icon$1></iconify-icon>')
}

/**
 * The permission a stripped `<iframe>`/`<script>`/`<style>` was missing, named the way a reader can
 * act on it, and the visible callout `sanitizeForPreview` leaves in the element's place.
 *
 * Shaped to match what an authored `> [!CAUTION]` GitHub-style admonition (`modules/github-alerts.js`'s
 * `caution` kind: `is-danger` / "Caution") renders as, so a reader sees the same object whether the
 * callout came from their own markdown or from this substitution (OpenProject #2911).
 *
 * A duplicate of the backend's own `gatedContentPlaceholder()` in `helpers/htmlSanitizePolicy.ts`, not
 * a shared import: there is no module boundary between this frontend workspace and the backend one to
 * share it through, so a wording change has to land in both -- each side's own test pins the exact
 * string.
 */
export function gatedContentPlaceholder(permission) {
  return `<blockquote class="is-danger"><p class="alert-title">Caution</p><p>This content requires the ${permission} permission and was not rendered.</p></blockquote>`
}

/**
 * What the editor preview shows in place of an `<iframe>`/`<script>`/`<style>` this author's own
 * permissions do not allow -- mirroring `write:scripts`/`write:styles` (the very permissions
 * `helpers/htmlSanitizePolicy.ts`'s `RenderPermissions` gates on server-side), so the preview stops
 * silently diverging from what a save is actually about to have sanitized out of it (OpenProject
 * #2911: previously the preview showed the raw embed regardless of the author's own permissions).
 *
 * Deliberately not folded into `MarkdownRenderer#render()` itself: that method is also what
 * `renderers/headless.js` calls, server-side, for the re-render queue -- and that caller has to keep
 * getting back unsanitized HTML, since it is `models/rendering.ts#postProcess` on the OTHER end of
 * that call that sanitizes it against whichever actor's permissions actually apply. Only a caller
 * that already knows which permissions to render the PREVIEW against -- the editor -- reaches for
 * this at all.
 *
 * Parses with a `<template>` rather than assigning straight into the live preview DOM: a template's
 * content is inert, so scanning it for a gated tag never risks running the very thing being asked
 * whether it may run, whichever way that question is answered.
 *
 * @param {string} html The editor's own rendered HTML -- see `MarkdownRenderer#render`.
 * @param {{ scripts: boolean, styles: boolean }} permissions What THIS author may embed.
 * @returns {string} The same HTML, with anything not permitted replaced by a visible callout.
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

export class MarkdownRenderer {
  constructor(config = {}) {
    this.md = new MarkdownIt({
      html: config.allowHTML,
      breaks: config.lineBreaks,
      linkify: config.linkify,
      typography: config.typographer,
      quotes: quoteStyles[config.quotes] ?? quoteStyles.english,
      highlight(str, lang) {
        if (['drawio', 'kroki', 'mermaid', 'plantuml'].includes(lang)) {
          /*
            Left as source, deliberately: a diagram is drawn by the block whose body it is —
            `block-diagram` for mermaid, `block-plantuml` and `block-kroki` for the others,
            `block-drawio` for draw.io/mxGraph XML — and each reads the text out of this `pre`. A
            fence on its own outside a block keeps the panel the stylesheet gives it, which says "a
            diagram nobody has drawn" rather than pretending to be a code sample.
          */
          return `<pre class="codeblock-${lang}"><code>${escape(str)}</code></pre>`
        } else {
          /*
            `getLanguage` first, because `hljs.highlight` THROWS on a language it does not know --
            `ignoreIllegals` only forgives illegal syntax within a language it does. markdown-it takes
            the first word of a fence's info string as the language name, so a fence whose code starts
            on the opening line (```   <!DOCTYPE rfc [) asks for a language called `<!DOCTYPE`, and the
            throw took the entire render with it: an empty preview, and -- since the editor patches the
            store with the result -- an empty render saved over the stored HTML.

            Unknown language therefore falls back to plain code, and the fallback ESCAPES: `str` is the
            author's raw source, and the unhighlighted branch used to interpolate it into the markup as
            it stood. hljs escapes what it emits, so this only ever affected the unhighlighted path.
          */
          const highlighted =
            lang && hljs.getLanguage(lang)
              ? hljs.highlight(str, { language: lang, ignoreIllegals: true })
              : { value: escape(str) }
          // -> `match` is null, not empty, when the code is a single line with no trailing newline
          const lineCount = (highlighted.value.match(/\n/g) ?? []).length
          const lineNums =
            lineCount > 1
              ? `<span aria-hidden="true" class="line-numbers-rows">${'<span></span>'.repeat(lineCount)}</span>`
              : ''
          // -> `lang` is escaped too: it is whatever the author typed after the backticks, and a quote
          //    in it would otherwise close the attribute and inject markup into the preview
          // -> A ternary, not `&&`: for a single-line block (`lineCount > 1` false) `&&` short-circuits
          //    to the boolean `false` itself, which then interpolated as the literal string "false"
          //    into the class attribute -- and since this render is both preview AND what gets saved,
          //    that literal class was written into every page's stored HTML permanently
          //    (OpenProject #946).
          return `<pre class="codeblock hljs${lineCount > 1 ? ' line-numbers' : ''}"><code class="language-${escape(lang ?? '')}">${highlighted.value}${lineNums}</code></pre>`
        }
      }
    })
      /*
        MDC's INLINE component syntax is off, and deliberately: `:name` is how it writes one, which is
        also how markdown writes an emoji, and MDC parses first. With it on, `:rocket:` came out as
        `<rocket>:` and no emoji shortcode in any page ever rendered — while this file goes to the
        trouble of drawing them as twemoji SVGs, and the editor has a picker for them.

        Everything else MDC brings is untouched: block components (`::note`), inline props and inline
        spans. Turning this back on means giving up emoji shortcodes again.

        OpenProject #2372 recorded a working hypothesis that a `::block-name{...}` block fails to
        parse once one of its quoted attribute values contains a space, corrupting every block after
        it in the document (seen via a Playwright trace against `e2e/tests/csp.spec.js`). That does
        not reproduce against this renderer, this fork's own MDC config, and `markdown-it-mdc` 0.2.12
        (the version pinned in `package.json`) -- see `markdown.test.js`'s "MDC block attribute values
        containing a space" describe for the regression coverage and the WP's own comment thread for
        the full investigation. If a future dependency bump reintroduces this, that test is what will
        catch it.
      */
      .use(mdMdc, { syntax: { inlineComponent: false } })
      .use(mdAttrs, {
        allowedAttributes: ['id', 'class', 'target']
      })
      .use(mdEmoji)
      .use(mdTaskLists, { label: false, labelAfter: false })
      .use(mdExpandTabs, { tabWidth: config.tabWidth })
      .use(mdAbbr)
      .use(mdSup)
      .use(mdSub)
      .use(mdMark)
      .use(mdFootnote)
      .use(mdImsize)
      .use(mdGithubAlerts)
      .use(mdGlossary, { terms: config.glossaryTerms })
      /*
        MDC's own quirks, told apart from the syntax this wiki already spends on footnotes,
        `markdown-it-attrs` braces and markdown headings -- see the module for each case.
      */
      .use(mdMdcCompat)
      .use(mdIconShortcode)
      .use(mdTex)

    if (config.underline) {
      this.md.use(mdUnderline)
    }

    /*
      MultiMarkdown tables: multi-line cells, `^^` rowspans, and a table with no header row.

      `multimdTable` is the name the setting has everywhere else -- `base.yml`, `models/sites.ts`, the
      editor's config overlay -- and this read it as `mdmultiTable`, so the plugin was never installed
      and none of those three features has ever worked.

      The shim is what makes fixing that safe. `markdown-it-multimd-table` merges its options with
      `md.utils.assign`, which markdown-it dropped in 14; on 15 the `use()` call throws
      `md.utils.assign is not a function`, out of the CONSTRUCTOR -- so with the name corrected and
      nothing else, every render in the app would have died instead. 4.2.3 is the last release of the
      plugin (Aug 2023) and there is no fixed version to move to.

      `md.utils` is one object shared by every markdown-it instance, so this restores the helper
      process-wide rather than for this renderer. That is as narrow as it can be made and it is benign:
      the removed helper WAS this, minus a guard against non-object sources that the one call site
      cannot hit.
    */
    if (config.multimdTable) {
      this.md.utils.assign ??= Object.assign
      this.md.use(mdMultiTable, { multiline: true, rowspan: true, headerless: true })
    }

    // --------------------------------
    // LINK DESTINATIONS
    // --------------------------------

    /*
      Where a link goes is decided here, at render time, and recorded as a class -- `is-external-link`
      -- for the stylesheet to mark. It cannot be decided in CSS: a selector can match on the shape of
      an href but not compare its host with the wiki's own, which is the whole question.

      The class survives being stored: `models/rendering.ts` keeps `class` on every element.
    */
    this.md.renderer.rules.link_open = (tokens, idx, options, env, slf) => {
      if (isExternalHref(tokens[idx].attrGet('href'), env?.siteOrigin)) {
        tokens[idx].attrJoin('class', 'is-external-link')
      }
      return slf.renderToken(tokens, idx, options, env, slf)
    }

    // --------------------------------
    // TABLE SCROLL WRAPPER
    // --------------------------------

    /*
      A table's own scroll frame -- THREE nested boxes, not two (OpenProject #2958, tightening
      #2935's split further). `.table-wrap` is the outer, non-scrolling frame: `_page-contents.scss`'s
      `// TABLES` section draws the border, radius, shadow and corner marks on it, and nothing about
      it ever clips a descendant, so Ledger's marks (4px outside it) are never cropped. Nested inside,
      `.table-clip` is a plain `overflow: hidden` + the same radius, and nothing else -- it does not
      scroll itself, so it has no scrollbar of its own to worry about, which is exactly what lets it
      clip cleanly. Nested inside THAT, `.table-scroll` gets `overflow-x: auto` and the scrollbar
      tokens, with `<table>` itself reduced to `width: max-content; min-width: 100%`.

      Splitting the clip from the scroll this far is what actually contains a wide table's cell
      backgrounds to the rounded corner in Cobalt: a native scrollbar's track/thumb is browser/OS
      chrome, not ordinary painted content, and is not reliably clipped by `border-radius` on the SAME
      element that produces it -- `.table-scroll` combining `overflow-x: auto` with its own radius
      (the shape #2935 landed) still let a classic, space-reserving scrollbar (Windows/Linux by
      default, macOS whenever scrollbars are set to show always) square off the very corner it sits
      against, one level in from the frame #2935 already fixed. `.table-clip`'s `overflow: hidden`
      clips `.table-scroll` as a whole -- scrollbar chrome included -- the same way any ordinary
      content is clipped by an ancestor's `overflow: hidden`, because from `.table-clip`'s own
      perspective there is no scrolling happening on IT; there is just a child box to trim to its own
      rounded rectangle. See `_page-contents.scss`'s own comments on all three boxes, and
      `ui-iteration-markdown-tables/markdown-tables.md`'s original "the scrollbar painting over the
      rounded corners" note, which is the same failure mode this closes. See OpenProject
      #2916/#2935/#2958.

      A plain trio of `<div>`s, not tokens carrying any classes of their own -- table AND
      thead/tbody/tr/td tokens already exist for markdown-it's own default table rendering (including
      `markdown-it-multimd-table`'s, which produces the same core tokens with richer cell content),
      so wrapping at `table_open`/`table_close` catches every table regardless of which parser rule
      produced it, exactly like `link_open` above wraps every link regardless of which rule matched.
    */
    this.md.renderer.rules.table_open = (tokens, idx, options, env, slf) =>
      `<div class="table-wrap"><div class="table-clip"><div class="table-scroll">${slf.renderToken(tokens, idx, options, env, slf)}`
    this.md.renderer.rules.table_close = (tokens, idx, options, env, slf) =>
      `${slf.renderToken(tokens, idx, options, env, slf)}</div></div></div>`

    // --------------------------------
    // RESOLVE IMAGE SOURCES
    // --------------------------------

    /*
      Where a picture loads from -- see `fileSrc` for what is rewritten and why the source keeps what
      the author wrote.

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
      And the same for an `<img>` the author wrote as HTML, which never becomes a token to hold an
      attribute -- so it is the rendered text that is rewritten, after whatever rule produced it.
      Raw HTML is also where a self-closed `<iconify-icon />` turns up, and it is fixed in the same
      pass for the same reason: this is the only point at which the author's own markup is still
      distinguishable from the markup the renderer produced.
    */
    const passthrough = (tokens, idx) => tokens[idx].content
    for (const rule of ['html_block', 'html_inline']) {
      const renderHtml = this.md.renderer.rules[rule] ?? passthrough
      this.md.renderer.rules[rule] = (tokens, idx, options, env, slf) =>
        closeIconTags(rewriteHtmlImages(renderHtml(tokens, idx, options, env, slf), env?.pagePath))
    }

    // --------------------------------
    // TWEMOJI
    // --------------------------------

    /*
      Drawn from this instance, never from a CDN: the callback replaces twemoji's default `base` +
      size + extension entirely, so the `src` is the whole path and nothing upstream is contacted for
      it. `vite.config.js` puts the SVGs at `/_assets/svg/twemoji/` — copied into the build output,
      served out of `node_modules` in dev — so the two have to agree on this path.

      The artwork comes from the same upstream project as this parser, at a pinned tag (see
      `twemoji-assets` in `package.json`). They are separate dependencies, so the build checks that
      every emoji a page can hold still resolves to a file — an emoji the parser knows and the asset
      set does not is a broken image in a page.
    */
    this.md.renderer.rules.emoji = (token, idx) => {
      return twemoji.parse(token[idx].content, {
        callback(icon, opts) {
          return `/_assets/svg/twemoji/${icon}.svg`
        }
      })
    }

    // --------------------------------
    // Inject line numbers for preview scroll sync
    // --------------------------------

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

    // --------------------------------
    // Where the tabsets are, for the editor's preview
    // --------------------------------

    /*
      Every tabset in the document, in order, as the source line range of each of its panels.

      This is for the editor: a `block-tabs` in the preview keeps which panel is open in its own state,
      and the preview is rebuilt from scratch on every keystroke — so without this, writing inside the
      second panel of a tabset threw the author back to the first one, and no amount of preserving state
      across the rebuild would say WHICH panel they are working in.

      Read from the token stream rather than by scanning the source for `::block-tab`, so it is the
      parser's opinion of where each panel begins and ends, and it cannot drift from the markup the same
      parse produced. Only line numbers are kept: everything else about a panel is already in the render.
    */
    this.tabsMap = []
    this.md.core.ruler.push('collect_tabsets', (state) => {
      this.tabsMap = []
      // -> A stack, because a tabset may sit inside another one; a panel belongs to the innermost
      const open = []
      for (const token of state.tokens) {
        if (token.tag === 'block-tabs' && token.type === 'mdc_block_open') {
          const tabset = []
          this.tabsMap.push(tabset)
          open.push(tabset)
        } else if (token.tag === 'block-tabs' && token.type === 'mdc_block_close') {
          open.pop()
        } else if (
          token.tag === 'block-tab' &&
          token.type === 'mdc_block_open' &&
          token.map &&
          open.length > 0
        ) {
          open.at(-1).push(token.map)
        }
      }
    })
  }

  /**
   * @param {string} src Markdown source.
   * @param {string} [pagePath] Path of the page this source belongs to, without a leading slash. What
   *                            a relative image resolves against -- see `fileSrc`.
   * @param {string} [siteOrigin] The site's real public origin (e.g. `https://wiki.example.com`), for
   *                              `isExternalHref` to judge a link's destination against. Only the
   *                              headless re-render passes this -- see `isExternalHref`'s own comment.
   */
  render(src, { pagePath = '', siteOrigin } = {}) {
    this.linesMap = []
    // -> A fresh env every time, whatever the caller passed: markdown-it keeps per-render state in it
    //    (footnotes and references), and one shared between renders would carry the last one's
    return this.md.render(src, { pagePath, siteOrigin })
  }

  getClosestPreviewLine(line) {
    return this.linesMap.findLast((n) => n <= line)
  }

  /**
   * Which tabset panel a source line is inside, as the pair of indices that finds it in the render.
   *
   * The innermost panel wins, so a tabset within a tabset answers for its own lines: the map is built
   * outermost-first, and a later match is therefore a deeper one.
   *
   * @param {number} line A 1-based editor line, as Monaco counts them.
   * @returns {{tabset: number, tab: number}|null} Indices among the document's tabsets and that
   *          tabset's panels, or null when the line is not inside one.
   */
  getTabAtLine(line) {
    let found = null
    for (const [tabset, tabs] of this.tabsMap.entries()) {
      for (const [tab, map] of tabs.entries()) {
        /*
          `map` is 0-based and ends one past the panel's last line of content, which is exactly the line
          its `::` sits on -- so the end is inclusive here, and a caret resting on the marker that closes
          a panel still counts as being in it.
        */
        if (line - 1 >= map[0] && line - 1 <= map[1]) {
          found = { tabset, tab }
        }
      }
    }
    return found
  }
}
