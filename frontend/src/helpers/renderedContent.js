import { BUNDLED_ICONS } from '@/assets/icons.generated'

import { copyToClipboard } from './clipboard'
import { isServerPath } from './serverPaths'
import { notify } from '@/composables/notify'

/**
 * The affordances a rendered page grows once it is on screen: a copy button on every code block, and a
 * pilcrow on every heading that copies a link to it.
 *
 * Scripted rather than rendered, because a page's HTML arrives through `v-html`: there is no template
 * to put a component in, and no Vue instance inside the render to hang one off. So the same treatment
 * is applied to whatever the render just produced -- in the page view and in the editor's preview
 * alike, both of which call `enhanceRenderedContent` after the content changes.
 *
 * Idempotent: a decorated element is marked, so re-running over content that has not been replaced
 * adds nothing. The controls carry their own listeners and are discarded wholesale when `v-html` next
 * writes over them, which is why nothing has to be torn down.
 */

/** Drawn from the same inlined set the interface uses; see `scripts/generate-icons.mjs`. */
const ICON_COPY = 'tabler:copy'
const ICON_DONE = 'tabler:check'

/** How long a control reports success before offering itself again. */
const COPIED_FOR_MS = 1600

/**
 * An inlined icon as SVG markup.
 *
 * `WIcon` does this in a template; a control built in script cannot use it, so the same record is read
 * directly. Missing icons are impossible in practice -- the names above are literals, so the generator
 * bundles them -- but an empty string is a nicer failure than a broken template string.
 */
function iconSvg(name) {
  const icon = BUNDLED_ICONS[name]
  if (!icon) {
    return ''
  }
  return `<svg viewBox="0 0 ${icon.width} ${icon.height}" width="16" height="16" aria-hidden="true" focusable="false">${icon.body}</svg>`
}

/**
 * Copy, then have the control say so itself: a toast for something this small would be noise, and the
 * pointer is already on the thing that changed.
 */
async function copyWithFeedback({ text, control, restingLabel, restingHtml, doneLabel, t }) {
  try {
    await copyToClipboard(text)
  } catch (err) {
    notify({ type: 'negative', message: t('common.clipboard.failure'), caption: err.message })
    return
  }

  control.classList.add('is-copied')
  control.innerHTML = iconSvg(ICON_DONE)
  setLabel(control, doneLabel)
  clearTimeout(control._resetTimer)
  control._resetTimer = setTimeout(() => {
    control.classList.remove('is-copied')
    control.innerHTML = restingHtml
    setLabel(control, restingLabel)
  }, COPIED_FOR_MS)
}

/**
 * One string for the two things that have to say it: the accessible name, and the tooltip a control
 * draws for itself (see `.heading-anchor::after`). `data-tooltip` is absent on controls whose icon
 * already says what they do, and the stylesheet then has nothing to render.
 */
function setLabel(control, label) {
  control.setAttribute('aria-label', label)
  if (control.dataset.tooltip !== undefined) {
    control.dataset.tooltip = label
  }
}

/** The code as the author wrote it, without the line numbers the gutter draws. */
function codeOf(pre) {
  const code = pre.querySelector('code')
  if (!code) {
    return pre.textContent
  }
  /*
    Cloned so the gutter can be dropped without touching what is on screen. Its spans hold no text --
    the numbers are drawn by a counter -- but the clone keeps the copy honest if that ever changes.
  */
  const copy = code.cloneNode(true)
  for (const gutter of copy.querySelectorAll('.line-numbers-rows')) {
    gutter.remove()
  }
  return copy.textContent.replace(/\n$/, '')
}

function addCodeCopyButtons(root, t) {
  for (const pre of root.querySelectorAll('pre.codeblock:not([data-code-copy])')) {
    // -> Marks the block as done, and is what the stylesheet keys the button's position off
    pre.dataset.codeCopy = ''

    const restingLabel = t('common.renderedContent.copyCode')

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'code-copy'
    setLabel(button, restingLabel)
    button.innerHTML = iconSvg(ICON_COPY)
    button.addEventListener('click', () =>
      copyWithFeedback({
        text: codeOf(pre),
        control: button,
        restingLabel,
        restingHtml: iconSvg(ICON_COPY),
        doneLabel: t('common.renderedContent.copyCodeDone'),
        t
      })
    )

    pre.appendChild(button)
  }
}

/**
 * The link a heading's pilcrow copies.
 *
 * Built from the address bar rather than from the page store, so it carries whatever the reader is
 * actually on -- locale prefix included. The editor is the one place where those diverge: it previews a
 * page that lives at its own address, not at `/_edit/…`, so that prefix is dropped.
 *
 * Not a locale parse site -- the locale prefix from the address bar is deliberately preserved.
 */
function headingUrl(id) {
  const path = window.location.pathname.replace(/^\/_edit\//, '/')
  return `${window.location.origin}${path}#${id}`
}

/** The pilcrow, as a character: no icon set carries it, and every font does. */
const PILCROW = '¶'

function addHeadingAnchors(root, t) {
  const headings = 'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'

  for (const heading of root.querySelectorAll(headings)) {
    if (heading.dataset.headingAnchor !== undefined) {
      continue
    }
    heading.dataset.headingAnchor = ''

    const restingLabel = t('common.renderedContent.copyHeadingLink')

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'heading-anchor'
    // -> Declares that this control has a tooltip; `setLabel` keeps the two in step
    button.dataset.tooltip = ''
    setLabel(button, restingLabel)
    button.textContent = PILCROW
    button.addEventListener('click', () =>
      copyWithFeedback({
        text: headingUrl(heading.id),
        control: button,
        restingLabel,
        restingHtml: PILCROW,
        doneLabel: t('common.renderedContent.copyHeadingLinkDone'),
        t
      })
    )

    heading.appendChild(button)
  }
}

/**
 * @param {HTMLElement|null} root The element the render was written into.
 * @param {Function} t vue-i18n translation method
 */
export function enhanceRenderedContent(root, t) {
  if (!root) {
    return
  }
  addCodeCopyButtons(root, t)
  addHeadingAnchors(root, t)
}

/*
  KEYWORD HIGHLIGHT / FIND (OpenProject #2541, Feature #2539)
  =============================================================

  Carries a keyword forward from the knowledge graph's filter into the page the reader lands on:
  every literal, case-insensitive occurrence of the term in the rendered content is wrapped in a
  `<mark>`, with `Index.vue` layering find-like navigation (count, next/prev, auto-scroll) on top of
  the elements this returns.

  A `TreeWalker` over the LIVE text nodes, deliberately not a string regex/replace against the HTML:
  the render arrives as one string only until `v-html` writes it, and splicing the string risks
  matching inside a tag attribute, a URL, or markup `enhanceRenderedContent` above already injected
  (a code-copy button's aria-label, the pilcrow). Walking the real DOM only ever sees text a reader
  can actually read.
*/

/** What marks the `<mark>` wrappers this pass creates as its own, distinct from an author's own
 *  `==term==` markdown -- `_page-contents.scss` already styles a bare `mark`, which this reuses
 *  rather than inventing a second visual language; only the "current match" state adds anything.
 */
const KEYWORD_HIGHLIGHT_ATTR = 'keywordHighlight'
const KEYWORD_HIGHLIGHT_SELECTOR = 'mark[data-keyword-highlight]'

/** Whether a node sits somewhere content should never be scanned for a match, or is already one. */
function skipsKeywordScan(parent) {
  return Boolean(parent?.closest(`script, style, ${KEYWORD_HIGHLIGHT_SELECTOR}`))
}

/** Every text node under `root` worth testing against the term, collected up front. */
function collectHighlightableTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || skipsKeywordScan(node.parentElement)) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })
  const nodes = []
  let node
  while ((node = walker.nextNode())) {
    nodes.push(node)
  }
  return nodes
}

/**
 * Splits one text node on every case-insensitive occurrence of `needle`, replacing it in place with
 * a mix of plain text and new `<mark>` elements -- one per match, in order.
 *
 * A plain `.indexOf` walk against lower-cased copies, not a `RegExp`: the term is arbitrary reader
 * input carried through a query param, and this way it is matched as the literal string it is,
 * with no regex-metacharacter escaping to get right.
 *
 * @returns The `<mark>` elements created, in document order.
 */
function wrapMatchesInTextNode(node, needleLower) {
  const text = node.nodeValue
  const textLower = text.toLowerCase()
  let cursor = 0
  let index = textLower.indexOf(needleLower, cursor)
  if (index === -1) {
    return []
  }

  const marks = []
  const fragment = document.createDocumentFragment()
  while (index !== -1) {
    if (index > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, index)))
    }
    const mark = document.createElement('mark')
    mark.className = 'keyword-highlight'
    mark.dataset[KEYWORD_HIGHLIGHT_ATTR] = ''
    mark.textContent = text.slice(index, index + needleLower.length)
    fragment.appendChild(mark)
    marks.push(mark)
    cursor = index + needleLower.length
    index = textLower.indexOf(needleLower, cursor)
  }
  if (cursor < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(cursor)))
  }
  node.parentNode.replaceChild(fragment, node)
  return marks
}

/**
 * Wrap every literal, case-insensitive match of `term` inside `root` in a new `<mark>`.
 *
 * Always clears any previous pass's wrappers first (a no-op when there are none), so calling this
 * again -- the same term after an unrelated re-render, or a different term while the same content
 * is still on screen -- never nests one `<mark>` inside another. The `TreeWalker`'s own
 * already-wrapped-ancestor skip (`skipsKeywordScan`) is the second, structural half of that: within
 * one pass, a match cannot be found twice, because the elements it just created are never
 * re-visited (`collectHighlightableTextNodes` gathers its list before any mutation begins).
 *
 * @param {HTMLElement|null} root The element the render was written into.
 * @param {string} term The keyword to highlight. A blank or whitespace-only term clears and finds
 *   nothing, same as no term at all.
 * @returns {{ matches: HTMLElement[] }} The `<mark>` elements created, in document order.
 */
export function applyKeywordHighlight(root, term) {
  if (!root) {
    return { matches: [] }
  }
  clearKeywordHighlight(root)

  const needle = typeof term === 'string' ? term.trim() : ''
  if (!needle) {
    return { matches: [] }
  }

  const needleLower = needle.toLowerCase()
  const matches = []
  for (const node of collectHighlightableTextNodes(root)) {
    matches.push(...wrapMatchesInTextNode(node, needleLower))
  }
  return { matches }
}

/** Unwrap every `<mark>` this pass created, merging the text back with its neighbours. */
export function clearKeywordHighlight(root) {
  if (!root) {
    return
  }
  for (const mark of root.querySelectorAll(KEYWORD_HIGHLIGHT_SELECTOR)) {
    const parent = mark.parentNode
    if (!parent) {
      continue
    }
    parent.replaceChild(document.createTextNode(mark.textContent), mark)
    parent.normalize()
  }
}

/**
 * A link's resolved URL, or null when this app has no business intercepting it at all.
 *
 * The half of the decision `routableHref` and `sameDocumentHash` share: an anchor asking for a new
 * context (`target`, `download`, `rel="external"`) is the browser's to handle whatever it points at,
 * and an `href` that is not a URL at all is nobody's. Each of the two then goes on to ask its own
 * question of what comes back.
 *
 * @param {object} link The anchor's own properties: `href` is the resolved absolute URL.
 * @returns {URL|null}
 */
function interceptableUrl({ href, target, download, rel } = {}) {
  if (!href || (target && target !== '_self') || download || /\bexternal\b/.test(rel ?? '')) {
    return null
  }
  try {
    return new URL(href)
  } catch {
    return null
  }
}

/**
 * Where a link inside rendered content should take the reader, if the router should handle it.
 *
 * A page's HTML arrives through `v-html`, so every link in it is a plain anchor: left alone, the
 * browser tears the whole application down and builds it again to show a page the router could have
 * swapped in. This decides which links are worth intercepting, and everything it declines stays
 * exactly as the browser would have treated it.
 *
 * Declined, deliberately:
 *   - another origin, or a scheme that is not http(s) — `mailto:`, `tel:`, a download link
 *   - anything asking for a new context: `target`, `download`, `rel="external"`
 *   - a path the server owns rather than the router
 *   - a fragment on the page already open, which is `sameDocumentHash`'s business instead
 *
 * @param {object} link The anchor's own properties: `href` is the resolved absolute URL.
 * @param {Location|{origin: string, pathname: string}} current Where the reader is now.
 * @returns {string|null} A path to push, or null to let the browser do what it would have done.
 */
export function routableHref(link = {}, current) {
  const url = interceptableUrl(link)
  if (!url) {
    return null
  }
  if (url.origin !== current.origin || !/^https?:$/.test(url.protocol)) {
    return null
  }
  // -> A link to one of these is a request for a file, not a page, and handing it to the router would
  //    render the catch-all page view over the top of nothing
  if (isServerPath(url.pathname)) {
    return null
  }
  // -> Same page, different fragment: nothing to route to, and `sameDocumentHash` handles the scroll
  if (url.pathname === current.pathname && url.hash) {
    return null
  }

  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * The fragment of a link that points at a heading on the page already open, if that is what it is.
 *
 * The counterpart to `routableHref`, which declines these: there is no page to load, only a place on
 * this one to travel to. Left to the browser it is an instant jump, where every other way of reaching
 * a heading in this app animates — the contents list does, and so does arriving with a `#heading` in
 * the URL.
 *
 * Declined on the same grounds as a routable link, so a fragment link asking for a new tab, or
 * carrying `download` / `rel="external"`, is still the browser's to handle.
 *
 * @param {object} link The anchor's own properties: `href` is the resolved absolute URL.
 * @param {Location|{origin: string, pathname: string}} current Where the reader is now.
 * @returns {string|null} The `#fragment` to travel to, or null when this is not such a link.
 */
export function sameDocumentHash(link = {}, current) {
  const url = interceptableUrl(link)
  if (!url) {
    return null
  }
  if (url.origin !== current.origin || !url.hash || url.pathname !== current.pathname) {
    return null
  }

  return url.hash
}
