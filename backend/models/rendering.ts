import * as cheerio from 'cheerio'
import sanitizeHtml from 'sanitize-html'
import { eq, inArray, sql } from 'drizzle-orm'
import { flipFromString, rotateFromString } from '@iconify/utils'
import { jobs as jobsTable, pageRenderQueue as renderQueueTable } from '../db/schema.ts'
import { CustomError } from '../helpers/common.ts'
import {
  assertPuppeteerAvailable,
  closeQuietly,
  isPuppeteerAvailable,
  launchPuppeteerBrowser
} from '../helpers/puppeteer.ts'
import { withTimeout } from '../helpers/timeout.ts'
import type { IconifyIcon } from '@iconify/types'
import type { IconifyIconCustomisations } from '@iconify/utils'
import type { BlockProp } from './blocks.ts'

/**
 * Rendering model
 *
 * Markdown becomes HTML in the browser, not here: the editor renders as you type, and what it shows
 * in its preview is what gets sent up and stored. One renderer, one result — the preview cannot drift
 * from the saved page because they are the same render.
 *
 * What this model does is everything that has to happen *after* that, and cannot be left to the
 * client:
 *
 *  - **Sanitizing.** The HTML arrived from a browser, so it is a user input like any other. What
 *    survives depends on what the author is allowed to do — scripts and styles are permissions.
 *  - **Normalizing.** The editor leaves scaffolding in its output (line markers for preview scroll
 *    sync) that has no business being stored, and headings arrive without the anchors a table of
 *    contents needs.
 *  - **Resolving.** An icon is a reference when it is written and a picture when it is read, and this
 *    is where it stops being the former — drawn into the page once, at save time, rather than fetched
 *    by every reader's browser on every view.
 *  - **Extracting.** The table of contents and the plain text the search index is built from are both
 *    derived from the final HTML, once it is settled.
 *
 * Re-rendering an existing page from its source — which the server needs when the content is there
 * but the render is stale — goes back through the very same frontend pipeline, driven in a headless
 * browser. That is a job rather than part of a request: see `queuePage` and `drainQueue`.
 */

/** How long the renderer bundle gets to load itself in the headless browser, in milliseconds. */
const RENDER_READY_TIMEOUT = 30000

/** How long a single render gets once the bundle is up, in milliseconds. */
const RENDER_TIMEOUT = 30000

/** The task that drains the render queue. One browser, one page at a time. */
const DRAIN_TASK = 'renderPages'

/** The shape `blockAllowances()` needs from a custom block -- see `models/blocks.ts#getCustomBlockDefinitions()`. */
interface CustomBlockAllowance {
  block: string
  props: BlockProp[]
}

/** A heading in the table of contents, shaped for the Quasar tree the page sidebar draws. */
export interface TocNode {
  key: string
  label: string
  /**
   * The heading's own level, 1 to 6.
   *
   * Kept alongside the nesting because the two say different things: a contents list is asked to show
   * "H1 to H2", which is about the tag an author reached for, and an `h3` written under an `h1` is
   * still an `h3` however few levels sit above it.
   */
  level: number
  children: TocNode[]
}

export interface PostProcessResult {
  /** The HTML to store and serve. */
  render: string
  /** The table of contents, derived from the headings. */
  toc: TocNode[]
  /** Plain text, for the search index. */
  text: string
  /** Internal-link target page paths, deduplicated — see `extractInternalLinks`. */
  links: string[]
}

/**
 * A headless browser standing by on the renderer bundle, good for any number of pages.
 *
 * Opening one is the expensive part of rendering, so it is handed out as a handle to be reused and
 * closed by whoever asked for it rather than opened per page.
 */
interface PageRenderer {
  /**
   * Markdown in, the editor's own HTML out — before `postProcess` gets to it.
   *
   * `context` carries what the source cannot say about itself: the page's own path, which a relative
   * image resolves against the folder it sits in, as it would in a repository; and the site's own
   * public origin, which `is-external-link` classification is judged against (OpenProject #1751) —
   * this browser is navigated to its own loopback address, not the site's hostname, so without it
   * every absolute same-site link would come back external here and internal in the editor that saved
   * it.
   */
  render(
    content: string,
    config: Record<string, any>,
    context: Record<string, any>
  ): Promise<string>
  close(): Promise<void>
}

/** What the author is allowed to put in a page, beyond ordinary content. */
export interface RenderPermissions {
  /** `write:scripts` — may embed `<script>` and inline event handlers. */
  scripts: boolean
  /** `write:styles` — may embed `<style>` and any inline `style` declaration, not just the safe
   *  KaTeX-sized subset (`ALLOWED_STYLES`) everyone gets. */
  styles: boolean
}

/**
 * Tags and attributes a page may use whoever wrote it.
 *
 * Deliberately broad: this is a wiki, the markdown renderer is configured with `allowHTML` on by
 * default, and authors are expected to reach for raw HTML. The line being drawn is not "what looks
 * like a document" but "what can execute" — those are the permission-gated parts below.
 */
const BASE_ALLOWED_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'abbr',
  'audio',
  'button',
  'del',
  'details',
  'figcaption',
  'figure',
  /*
    The Iconify element, so a page can carry an icon the way the interface does.

    The only custom element allowed here that is not a block, and it is allowed unconditionally
    because there is nothing to gate: it is inert markup like the rest of this list, and what draws
    it is already on every page — `boot/iconify.js` defines the element and points it at this
    instance's `/_icons`, so an icon in content resolves against the wiki's own store and reaches no
    third party. A block is gated because an administrator installs and enables it; nobody installs
    this one.

    Note it is not self-closing, whatever the author writes: the parser gives `<iconify-icon … />`
    the rest of the paragraph as children, and the element's shadow root has no slot to show them
    with. `</iconify-icon>` belongs on the end of every one.
  */
  'iconify-icon',
  'img',
  'ins',
  'kbd',
  'mark',
  'picture',
  'section',
  'source',
  'sub',
  'summary',
  'sup',
  'track',
  'u',
  'video',
  // -> KaTeX renders to MathML alongside its HTML fallback
  'annotation',
  'math',
  'menclose',
  'mfrac',
  'mi',
  'mn',
  'mo',
  'mover',
  'mpadded',
  'mphantom',
  'mroot',
  'mrow',
  'mspace',
  'msqrt',
  'mstyle',
  'msub',
  'msubsup',
  'msup',
  'mtable',
  'mtd',
  'mtext',
  'mtr',
  'munder',
  'munderover',
  'semantics',
  // -> Inline SVG, which an author may well paste in. Structure and shapes only: `script`,
  //    `foreignObject` and the SMIL animation tags are all left out, since each of them is a way to
  //    get script or arbitrary markup back in through a picture.
  //
  //    Not for MathJax: `block-mathjax` typesets to SVG (liteAdaptor + a local per-formula glyph
  //    cache, `<use xlink:href="#MJX-…">` referencing `<path>`s in its own `<defs>`) entirely inside
  //    its Lit shadow root, in `firstUpdated()` -- a browser lifecycle hook, run at view time. What
  //    gets sanitised and stored is the fenced source inside the inert `<block-mathjax>` custom
  //    element, never the drawing; see `blockAllowances` below for why a block's markup is inert
  //    either way. Task 629 audited this on the assumption an inlining path existed or was coming and
  //    found neither: unlike `block-katex`, whose *literal* `$…$`/`$$…$$` sibling syntax now resolves
  //    to real KaTeX MathML at render time (Task 624, see the MathML block above), nothing resolves
  //    MathJax SVG server-side or at render time. `xlink:href`, `focusable` and `role` are therefore
  //    deliberately absent from `SVG_ATTRIBUTES` below -- there is nothing for them to protect yet. A
  //    future task that inlines `block-mathjax`'s drawing into stored HTML (mirroring `inlineIcons()`
  //    for `<iconify-icon>`) would need to add them there, alongside `<defs>`/`<path>` id-and-d pairs,
  //    which are already covered.
  'svg',
  'circle',
  'clipPath',
  'defs',
  'desc',
  'ellipse',
  'g',
  'line',
  'linearGradient',
  'marker',
  'mask',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialGradient',
  'rect',
  'stop',
  'symbol',
  'text',
  'tspan',
  'use'
]

/** Presentation attributes shared across the SVG subset above. None of them can execute. */
const SVG_ATTRIBUTES = [
  'clip-path',
  'clip-rule',
  'cx',
  'cy',
  'd',
  'fill',
  'fill-opacity',
  'fill-rule',
  'height',
  'href',
  'mask',
  'offset',
  'opacity',
  'points',
  'preserveAspectRatio',
  'r',
  'rx',
  'ry',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'stroke-width',
  'transform',
  'viewBox',
  'width',
  'x',
  'x1',
  'x2',
  'y',
  'y1',
  'y2'
]

const BASE_ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  // -> `style` is here rather than behind `write:styles` because the renderer itself produces it:
  //    KaTeX sizes and positions every piece of a formula with inline styles, and math would come
  //    out mangled for any author without the permission. Presence of the attribute is not gated on
  //    the permission, but which *declarations* survive inside it is -- see `sanitizeOptions()`'s
  //    `allowedStyles`, keyed off `ALLOWED_STYLES` below. The permission still fully
  //    gates the `<style>` tag, which is where a page can restyle everything around it.
  '*': ['id', 'class', 'style', 'title', 'dir', 'lang', 'aria-*', 'role', 'data-*'],
  a: ['href', 'name', 'target', 'rel', 'download'],
  audio: ['controls', 'loop', 'muted', 'preload', 'src'],
  // -> Everything the element reads except `mode`, which picks how it paints (mask/background) and
  //    only matters to an author working around a specific icon set's colouring. Size and colour are
  //    inherited from the surrounding text by default, which is what an icon in a sentence wants;
  //    `inline` shifts it onto the text baseline, `width`/`height` override the 1em box.
  'iconify-icon': ['icon', 'inline', 'width', 'height', 'rotate', 'flip'],
  img: ['src', 'srcset', 'alt', 'width', 'height', 'loading', 'decoding'],
  input: ['type', 'checked', 'disabled'],
  ol: ['start', 'reversed', 'type'],
  source: ['src', 'srcset', 'type', 'media'],
  td: ['colspan', 'rowspan', 'align'],
  th: ['colspan', 'rowspan', 'align', 'scope'],
  track: ['src', 'kind', 'srclang', 'label', 'default'],
  video: ['controls', 'loop', 'muted', 'poster', 'preload', 'src', 'width', 'height'],
  // -> MathML carries its meaning in attributes, and none of them are executable. `mover`,
  //    `munder` and `mi` were unreached until inline `$…$`/`$$…$$` TeX authoring
  //    (`renderers/markdown.js`) started landing literal KaTeX MathML in stored pages -- KaTeX's own
  //    `\vec`, `\overline`, `\underline`, `\binom` and Greek/variable-style commands all write one of
  //    these, and without the entries below the sanitiser silently dropped them, leaving the
  //    (visually hidden, screen-reader-only) MathML copy of the formula missing the marking that says
  //    an accent or a variant applies.
  //
  //    Task 629 re-audited this list against real mhchem (`\ce{}`/`\pu{}`) output specifically,
  //    since chemical notation reaches for MathML shapes a plain formula does not -- `mpadded` and
  //    `mphantom` nested for the isotope-coefficient overlap, `mo[stretchy][minsize]` for a reaction
  //    arrow, `mstyle[scriptlevel][displaystyle]` around a unit fraction. All of it already round-trips
  //    through sanitization untouched (see `rendering.test.ts`'s `\ce{}`/`\pu{}` tests, captured from a
  //    real `katex.renderToString` + `katex/contrib/mhchem` run) -- nothing below needed adding for it.
  //    mhchem itself is not wired into the literal `$…$` path today (only plain `katex` is imported in
  //    `renderers/markdown.js`, so `\ce{}` there throws "Undefined control sequence" and falls to the
  //    error panel), so this is confirmed coverage for if/when that changes, not a currently-live path.
  math: ['xmlns', 'display'],
  annotation: ['encoding'],
  mi: ['mathvariant'],
  mfrac: ['linethickness'],
  mo: ['stretchy', 'fence', 'separator', 'lspace', 'rspace', 'minsize', 'maxsize'],
  mover: ['accent'],
  munder: ['accentunder'],
  munderover: ['accent', 'accentunder'],
  mspace: ['width', 'height', 'depth'],
  mstyle: ['scriptlevel', 'displaystyle', 'mathcolor', 'mathvariant'],
  mpadded: ['width', 'height', 'depth', 'lspace', 'voffset'],
  mtable: ['columnalign', 'rowspacing', 'columnspacing', 'rowlines', 'columnlines'],
  mtd: ['columnalign', 'rowspan', 'columnspan'],
  svg: [...SVG_ATTRIBUTES, 'xmlns', 'xmlns:xlink'],
  circle: SVG_ATTRIBUTES,
  clipPath: SVG_ATTRIBUTES,
  defs: SVG_ATTRIBUTES,
  ellipse: SVG_ATTRIBUTES,
  g: SVG_ATTRIBUTES,
  line: SVG_ATTRIBUTES,
  linearGradient: [...SVG_ATTRIBUTES, 'gradientUnits', 'gradientTransform'],
  marker: [...SVG_ATTRIBUTES, 'markerWidth', 'markerHeight', 'orient', 'refX', 'refY'],
  mask: [...SVG_ATTRIBUTES, 'maskUnits'],
  path: SVG_ATTRIBUTES,
  pattern: [...SVG_ATTRIBUTES, 'patternUnits'],
  polygon: SVG_ATTRIBUTES,
  polyline: SVG_ATTRIBUTES,
  radialGradient: [...SVG_ATTRIBUTES, 'gradientUnits', 'gradientTransform', 'fx', 'fy'],
  rect: SVG_ATTRIBUTES,
  stop: SVG_ATTRIBUTES,
  symbol: SVG_ATTRIBUTES,
  text: [...SVG_ATTRIBUTES, 'dx', 'dy', 'text-anchor', 'font-size', 'font-family'],
  tspan: [...SVG_ATTRIBUTES, 'dx', 'dy'],
  use: SVG_ATTRIBUTES
}

/** A CSS length: an optionally-negative number with a unit KaTeX actually emits, or unitless `0`. */
const CSS_LENGTH = /^(-?\d+(\.\d+)?(em|px|ex|%)|0)$/

/**
 * `vertical-align` accepts a length (what KaTeX always emits) or one of the CSS keyword values, for
 * any future non-KaTeX author of the attribute.
 */
const VERTICAL_ALIGN =
  /^(-?\d+(\.\d+)?(em|px|ex|%)|0|baseline|top|middle|bottom|sub|super|text-top|text-bottom)$/

/**
 * A CSS color: `#hex`, `rgb()`/`rgba()`/`hsl()`/`hsla()`, or a bare CSS keyword (`red`,
 * `transparent`, `currentColor`, …). None of these three shapes can carry `url()`, an expression, or
 * anything else that reads as more than a color.
 */
const CSS_COLOR = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\([\d\s.,%]+\)|[a-zA-Z]+)$/

/**
 * `position`'s value restricted to the two keywords that only ever affect an element relative to its
 * own normal flow position — `fixed`/`absolute`/`sticky` are deliberately excluded, since those are
 * exactly what lets a `position` + `inset`/`top`/`left` + `z-index` combination cover the viewport
 * from inside ordinary page content (security/04-injection-xss.md §3). `relative` is real KaTeX
 * output (verified against `katex.renderToString`, e.g. `\overbrace`/`\underset` constructions), so
 * dropping the `position` property outright — the audit's own first-cut suggestion — would have
 * mangled those formulas for an author without `write:styles`; restricting the *value* instead of
 * the property keeps both properties true.
 */
const SAFE_POSITION = /^(relative|static)$/

/**
 * Inline `style` declarations `sanitizeHtml` keeps for an author *without* `write:styles` — sized to
 * what KaTeX's `output: 'html'` mode actually emits (verified against a real `katex.renderToString`
 * run covering fractions, roots, matrices, super/subscripts, `\color`/`\textcolor`/`\colorbox`,
 * `\overbrace`/`\underset`: `height`, `width`, `min-width`, `top`, `left`, `margin-left`,
 * `margin-right`, `vertical-align`, `border-bottom-width`, `color`, `background-color`, `position`),
 * plus the small set of declaratively-obvious siblings (`margin-top`/`-bottom`, `padding-*`,
 * `border-*`, `font-size`, `text-align`) an author could reasonably expect `style="…"` to cover.
 * Everything actually dangerous is either not a key here at all (`transform`, `opacity`,
 * `pointer-events`, `content`, `z-index`, `inset`) or is present with its value locked down
 * (`position`) — see security/04-injection-xss.md §3, the `position: fixed; inset: 0` full-viewport
 * overlay this closes. An author *with* `write:styles` skips this map entirely (see
 * `sanitizeOptions()` below): the permission already means "may restyle the page", which the `<style>` tag lets them do
 * regardless of what this map allows on the `style` attribute specifically.
 */
const ALLOWED_STYLES: Record<string, Record<string, RegExp[]>> = {
  '*': {
    height: [CSS_LENGTH],
    width: [CSS_LENGTH],
    'min-width': [CSS_LENGTH],
    'min-height': [CSS_LENGTH],
    margin: [CSS_LENGTH],
    'margin-top': [CSS_LENGTH],
    'margin-right': [CSS_LENGTH],
    'margin-bottom': [CSS_LENGTH],
    'margin-left': [CSS_LENGTH],
    padding: [CSS_LENGTH],
    'padding-top': [CSS_LENGTH],
    'padding-right': [CSS_LENGTH],
    'padding-bottom': [CSS_LENGTH],
    'padding-left': [CSS_LENGTH],
    top: [CSS_LENGTH],
    left: [CSS_LENGTH],
    'vertical-align': [VERTICAL_ALIGN],
    'font-size': [CSS_LENGTH],
    'border-width': [CSS_LENGTH],
    'border-style': [/^(none|solid|dashed|dotted|double)$/],
    'border-color': [CSS_COLOR],
    'border-top-width': [CSS_LENGTH],
    'border-right-width': [CSS_LENGTH],
    'border-bottom-width': [CSS_LENGTH],
    'border-left-width': [CSS_LENGTH],
    color: [CSS_COLOR],
    'background-color': [CSS_COLOR],
    'text-align': [/^(left|right|center|justify)$/],
    position: [SAFE_POSITION]
  }
}

/**
 * Which URL schemes may appear in a link or an embed.
 *
 * `javascript:` is absent, which is the point; `data:` is allowed only for images, where it is how a
 * small inline graphic is written and where it cannot script.
 */
const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel', 'ftp']

/** Attributes the editor adds for its own preview and that mean nothing in a stored page. */
const EDITOR_ARTIFACT_ATTRIBUTES = ['data-line']

/**
 * An icon dimension as a CSS length, or nothing when it is not one.
 *
 * Iconify reads a bare `32` as pixels and CSS does not, so the unit has to be spelled out. Anything
 * that is not a plain length is refused rather than passed along: this ends up inside a `style`,
 * where a value carrying a `;` would be a second declaration riding in on the first.
 */
function cssLength(value: string): string {
  const match = /^(\d+(?:\.\d+)?)(px|em|rem|%)?$/.exec(value.trim())
  return match ? `${match[1]}${match[2] ?? 'px'}` : ''
}

/**
 * Turn a heading into an anchor fragment.
 *
 * Kept deliberately plain — lowercase, words joined by hyphens — because these end up in URLs that
 * people copy and share, and because an existing link should keep working when the heading around it
 * is edited in ways that do not change its words.
 */
function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replaceAll(/[^\p{L}\p{N}\s-]/gu, '')
      .replaceAll(/\s+/g, '-')
      .replaceAll(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'section'
  )
}

class Rendering {
  /**
   * Clean up a render that came from a client, and pull out what is derived from it.
   *
   * @param siteId Whose blocks decide which block elements may stay — see `blockAllowances`
   * @param html The HTML the editor produced
   * @param permissions What the author may embed. Anything not granted is stripped rather than
   *                    rejected: an author pasting a snippet with a tracking script should get their
   *                    page saved without it, not an error they cannot act on.
   */
  async postProcess(
    siteId: string,
    html: string,
    permissions: RenderPermissions,
    pagePath: string = ''
  ): Promise<PostProcessResult> {
    const enabledBlocks = await WIKI.models.blocks.getEnabledKeys(siteId)
    const customBlocks = await WIKI.models.blocks.getCustomBlockDefinitions(siteId)
    const options = this.sanitizeOptions(
      permissions,
      this.blockAllowances(enabledBlocks, customBlocks)
    )

    let $ = cheerio.load(sanitizeHtml(html ?? '', options), null, false)

    this.stripEditorArtifacts($)
    this.unwrapOrphanedChildBlocks($)
    this.liftIconChildren($)
    await this.inlineIcons($)

    /*
      `inlineIcons()` just inserted markup the FIRST `sanitizeHtml()` call above never saw — an icon's SVG
      `body`, fetched from the icons model's disk/db/upstream-Iconify tiers and screened only by
      `models/icons.ts#isSafeIconBody`'s denylist regex, is written into the document verbatim by
      `renderInlineSvg()`. A denylist can miss what an allowlist cannot: an entity-encoded scheme
      (`<a href="&#106;avascript:…">`) slips past a literal `on\w+=`/`javascript:` string check and is
      decoded back to a live `javascript:` href once this HTML is parsed at `v-html` time. A second
      pass, against the very same `options` object the first pass used rather than a second,
      independently built one -- so the two calls cannot drift apart from each other -- is what
      actually closes that gap: a compensating control for an upstream icon body, not a fix to
      `isSafeIconBody` itself, which stays as an early, cheap rejection (OpenProject #1360/#2124/#2139,
      2026-08-24 security audit §7).

      `toc`/`text`/`links` are extracted from THIS re-sanitized document, not the pre-icon one, so what
      they describe matches what `render` below actually is.
    */
    $ = cheerio.load(sanitizeHtml($.html(), options), null, false)

    const toc = this.anchorHeadings($)
    const links = this.extractInternalLinks($, pagePath)

    return {
      render: $.html(),
      toc,
      text: this.extractText($),
      links
    }
  }

  /**
   * The block elements a page may carry, and what each of them may be given.
   *
   * A block is the one thing in a page that is not HTML, so sanitising against a list of HTML tags
   * drops every one of them and no block ever survives being saved. Built-in blocks come from the
   * compiled manifest — a block that is installed may be embedded, one that is not may not — and
   * custom blocks (OpenProject #2132) come from `customBlocks`, the site's own `blocks` rows with
   * `isCustom: true` (`models/blocks.ts#getCustomBlockDefinitions()`), which have no manifest entry to
   * be found in otherwise. Either way each tag gets exactly the attributes its component declares as
   * props, which is the same set the editor's block picker offers. The markup is inert either way: what
   * makes a block do anything is the component fetched from `/_blocks` at view time.
   *
   * A custom block's prop names are trusted here without re-checking them: the one thing standing
   * between an uploaded prop name and this allowlist is `helpers/blockDefinition.ts#extractBlockDefinition()`
   * rejecting anything not shaped like a plain attribute name at upload time (`/^[a-z][a-z0-9-]*$/`) --
   * sanitize-html matches attribute names with `*`-glob support, so an unvalidated prop named `on*` or
   * `*` would otherwise widen the sanitizer's allowlist arbitrarily, opening inline event handlers (or
   * every attribute at all) on that element for every page author. `blockDefinition.test.ts` covers the
   * upload-time rejection; this function is not itself a second gate for it.
   *
   * Installed is not sufficient: the block also has to be switched on for this site. Leaving the
   * picker to decide that would only cover the authors who use it — the content is markdown, so
   * `::block-diagram` is a thing anybody can type, and a block an administrator turned off would
   * otherwise render for every reader of that page.
   *
   * Turning a block off does NOT retroactively rewrite pages that already embed it, though (OpenProject
   * #1738, correcting an earlier version of this comment that claimed otherwise).
   * `models/blocks.ts#setBlocksState` only flips the block's own `isEnabled`/`config` row; nothing
   * queues a re-render of pages carrying the tag. A page saved before the toggle keeps `<block-x>` in
   * its stored `render` column until that page is next saved, or explicitly re-rendered
   * (`models/pages.ts#queueRerender`) — this function is what strips it on that next pass, not before.
   * A reader is still protected in the meantime: the reader view resolves each `block-*` tag against
   * `siteStore.blocksIndex`, which `api/sites.ts#siteBlocksInfoFor` populates for enabled blocks only,
   * and skips anything absent from it rather than falling back to a bare tag (`Index.vue`'s block
   * scan, OpenProject #1729) — so disabling a block is effective for every reader immediately. Only the
   * page's own stored HTML (visible to an editor re-opening it, or to anyone with `read:source`) lags
   * behind until it is next rendered. Queuing a bulk re-render of every affected page from
   * `setBlocksState` was considered and deliberately left undone: doing it at bounded cost needs a way
   * to find "pages whose stored render embeds this tag" that does not exist today, plus a `PageActor`
   * for per-page permissions `setBlocksState` has no access to — a distinct, separately-scoped feature
   * if it's ever actually wanted, not a fix folded into a bulk block-state toggle.
   *
   * Child blocks are exempt, having no switch of their own: a tab is part of the tabs it sits in,
   * and is gated by `unwrapOrphanedChildBlocks` once the parent's fate is known.
   *
   * Task 631 verified this generically for `block-katex`/`block-mathjax` specifically, since Feature
   * 366 ("Math Rendering Parity & Engine Selection") originally framed per-site engine choice as
   * "switching" one on and the other off. Confirmed both halves end to end
   * (`rendering-block-toggle.test.ts`): disabling `katex` for a site strips `<block-katex>` from a
   * page's stored render the next time it goes through `postProcess` (a save, or `storeRender` off
   * the back of `drainQueue`) exactly like any other disabled block — unwrapped, not deleted, so the
   * fenced TeX source is left behind as visible text rather than vanishing or lingering as an
   * unstyled custom element. But "switching engines" only ever means the site's enabled-block set;
   * nothing here rewrites markup. A page already authored with `::block-katex` is unaffected by
   * enabling `mathjax` alongside disabling `katex` — it still degrades to inert code, it does not
   * become `::block-mathjax`. That is accepted as expected behaviour, not a gap: this function's job
   * is "what may a stored page carry", not "keep pages current with an admin's block configuration",
   * and rewriting one block's markup into another's is content authorship, not sanitisation — the
   * same reason `postProcess` never rewrites `::block-diagram` into `::block-plantuml` either. A
   * migration path (find pages containing `<block-katex>` for a site, offer to rewrite them to
   * `<block-mathjax>` with equivalent props) is a real feature but a distinct, opt-in one; scope it as
   * its own task if automatic migration is ever actually wanted; nothing here blocks building it.
   */
  private blockAllowances(
    enabledBlocks: Set<string>,
    customBlocks: CustomBlockAllowance[] = []
  ): {
    tags: string[]
    attributes: Record<string, string[]>
  } {
    const tags: string[] = []
    const attributes: Record<string, string[]> = {}
    for (const definition of WIKI.models.blocks.definitions) {
      if (!definition.isChild && !enabledBlocks.has(definition.block)) {
        continue
      }
      const tag = `block-${definition.block}`
      tags.push(tag)
      /*
        `sanitizeOptions()` sets `lowerCaseAttributeNames: false` (kept so SVG/MathML names like
        `viewBox` survive), so it compares attribute names byte-for-byte. A camelCase-declared prop
        (`runKey`) is what the block picker and definition.yml write, but the DOM -- and therefore
        what an author actually types or Lit reflects -- only ever spells it lowercase (`runkey`).
        Emit both spellings so either survives; a prop whose name is already all-lowercase just
        dedupes against itself.
      */
      attributes[tag] = [
        ...new Set((definition.props ?? []).flatMap((prop) => [prop.name, prop.name.toLowerCase()]))
      ]
    }
    // -> Custom blocks are never children of another block (`isChild` is a built-in-only concept, set
    //    from a manifest a custom upload has none of), so the enabled check applies unconditionally.
    for (const custom of customBlocks) {
      if (!enabledBlocks.has(custom.block)) {
        continue
      }
      const tag = `block-${custom.block}`
      tags.push(tag)
      attributes[tag] = (custom.props ?? []).map((prop) => prop.name)
    }
    return { tags, attributes }
  }

  /**
   * Unwrap child blocks that no longer sit inside a block.
   *
   * A child block is allowed through the sanitiser unconditionally, because whether it may stay is
   * not a question about itself: it is part of its parent, and the parent is what an administrator
   * switches on and off. By this point the answer is visible in the document — a parent that was
   * disabled has already been dropped, leaving its children behind as orphans — so a child with no
   * block above it is one whose parent was turned off, or one an author typed on its own.
   *
   * Unwrapped rather than deleted, which is what the sanitiser does to every other tag it refuses:
   * the element goes, the content the author wrote inside it stays.
   */
  private unwrapOrphanedChildBlocks($: cheerio.CheerioAPI): void {
    const definitions = WIKI.models.blocks.definitions
    const childTags = definitions.filter((d) => d.isChild).map((d) => `block-${d.block}`)
    if (childTags.length < 1) {
      return
    }
    /*
      Every non-child block, not merely the enabled ones: a disabled block is not in the document to
      be matched, and naming the full set keeps this a question about nesting rather than a second
      copy of the enabled-block rule that could disagree with the first.
    */
    const parentTags = definitions.filter((d) => !d.isChild).map((d) => `block-${d.block}`)
    $(childTags.join(',')).each((_, el) => {
      if (parentTags.length > 0 && $(el).parents(parentTags.join(',')).length > 0) {
        return
      }
      $(el).replaceWith($(el).contents())
    })
  }

  /**
   * The `sanitize-html` options a page's HTML has to be run through -- whether at the point it arrives
   * from the editor, or a second time after `inlineIcons()` has drawn more markup into the document
   * (see `postProcess`, OpenProject #1360/#2124/#2139, 2026-08-24 security audit §7). Built once, from
   * the same `blocks` allowance and the same `permissions`, and reused for both calls: two
   * independently-built option objects could drift apart from each other in a way one shared object
   * cannot.
   */
  private sanitizeOptions(
    permissions: RenderPermissions,
    blocks: { tags: string[]; attributes: Record<string, string[]> }
  ): sanitizeHtml.IOptions {
    const allowedTags = [...BASE_ALLOWED_TAGS, ...blocks.tags]
    const allowedAttributes: Record<string, string[]> = {
      ...BASE_ALLOWED_ATTRIBUTES,
      ...blocks.attributes,
      '*': [...BASE_ALLOWED_ATTRIBUTES['*']]
    }

    if (permissions.styles) {
      allowedTags.push('style')
    }
    if (permissions.scripts) {
      allowedTags.push('script')
      // -> Inline handlers are only meaningful to someone who may also write a script tag
      allowedAttributes['*'].push('on*')
      allowedAttributes.script = ['src', 'type', 'async', 'defer']
      // -> An iframe runs someone else's page inside this one, which is the same trust decision as
      //    running a script, and it is how an author embeds a video or a live example
      allowedTags.push('iframe')
      allowedAttributes.iframe = [
        'src',
        'width',
        'height',
        'allow',
        'allowfullscreen',
        'loading',
        'referrerpolicy',
        'sandbox'
      ]
    }

    return {
      allowedTags,
      allowedAttributes,
      // -> An author with `write:styles` may already embed a `<style>` tag and restyle the whole
      //    page, so restricting the `style` *attribute* for them specifically would gate the same
      //    capability differently depending on which of two equivalent syntaxes they used. Omitting
      //    `allowedStyles` entirely (rather than passing an unrestricted one) is `sanitize-html`'s own
      //    documented way to say "keep every declaration, unfiltered" for this call. Without the
      //    permission, only `ALLOWED_STYLES` survives; everything else -- `transform`, `opacity`,
      //    `z-index`, ... -- is stripped out of the declaration list, not just the attribute.
      allowedStyles: permissions.styles ? undefined : ALLOWED_STYLES,
      // -> `script` and `style` in the allow list are what `write:scripts` and `write:styles` mean:
      //    the library warns about them on every call, and the warning is the thing to silence, not
      //    the permission
      allowVulnerableTags: permissions.scripts || permissions.styles,
      allowedSchemes: ALLOWED_SCHEMES,
      allowedSchemesByTag: {
        img: [...ALLOWED_SCHEMES, 'data']
      },
      // -> A protocol-relative URL inherits the page's scheme, which is fine and common in embeds
      allowProtocolRelative: true,
      // -> Applies only to tags that were dropped: without it, the body of a rejected `<script>`
      //    would come back out as visible page text
      nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
      parser: {
        // -> SVG and MathML have case-sensitive attribute names (`viewBox`, `preserveAspectRatio`),
        //    which lowercasing would quietly break. Tags stay lowercased, so `<SCRIPT>` is still
        //    matched and dropped.
        lowerCaseAttributeNames: false
      }
    }
  }

  /**
   * Drop the markers the editor injects so its preview pane can follow the cursor.
   */
  private stripEditorArtifacts($: cheerio.CheerioAPI): void {
    for (const attribute of EDITOR_ARTIFACT_ATTRIBUTES) {
      $(`[${attribute}]`).removeAttr(attribute)
    }
    // -> The `line` class rides along with `data-line` and is equally meaningless once stored
    $('.line').each((_, el) => {
      const remaining = ($(el).attr('class') ?? '').split(/\s+/).filter((c) => c && c !== 'line')
      if (remaining.length > 0) {
        $(el).attr('class', remaining.join(' '))
      } else {
        $(el).removeAttr('class')
      }
    })
  }

  /**
   * Move anything nested inside an `<iconify-icon>` back out, after it.
   *
   * `<iconify-icon icon="…" />` is what an author reaches for, and it is not a self-closing tag: the
   * parser hands the element the rest of the paragraph as children, and the element paints a shadow
   * root with no slot in it — so that text is in the document, counted as content, and invisible on
   * the page. Nothing legitimately goes inside an icon, so lifting the children out is the only
   * reading of that markup that keeps what was written.
   *
   * Document order means a nested pair unpicks itself: the outer icon's children include the inner
   * one, which is then reached in its own turn with whatever it swallowed.
   */
  private liftIconChildren($: cheerio.CheerioAPI): void {
    $('iconify-icon').each((_, el) => {
      const icon = $(el)
      const swallowed = icon.contents()
      if (swallowed.length > 0) {
        icon.after(swallowed)
      }
    })
  }

  /**
   * Draw every `<iconify-icon>` into the page as the `<svg>` it stands for.
   *
   * The element is a reference: opening a page that carries one costs a request to `/_icons` per icon
   * set, for every reader, before the icon appears. Resolving it here spends that once, on the person
   * saving the page, and what gets stored is a picture — the page then draws its icons with no second
   * request at all, and goes on drawing them if the set is later deleted or the instance goes offline.
   *
   * An icon that does not resolve is left as the element it was. That is the honest fallback rather
   * than a hole in the page: the set may be one an administrator is about to add, or upstream may be
   * briefly unreachable, and the element still resolves at view time in either case. It also means
   * this is safe to run over a render that has already been through it — there is nothing left to do.
   *
   * The resolve itself is the same call `/_icons` serves readers from, so this inherits its rules
   * whole: a disabled set is not filled from upstream, an unknown name is not asked about twice, and
   * the upstream budget applies. What is stored is therefore never more than a reader could have got.
   */
  private async inlineIcons($: cheerio.CheerioAPI): Promise<void> {
    const elements = $('iconify-icon').toArray()
    if (elements.length < 1) {
      return
    }

    const referenceOf = (element: cheerio.Cheerio<any>) =>
      (element.attr('icon') ?? '').trim().toLowerCase()

    /*
      Gathered per set before anything is resolved, because `resolveIcons` takes a list: a page built
      out of twenty icons of one set is one query and at most one upstream request, not twenty.
    */
    const wanted = new Map<string, Set<string>>()
    for (const el of elements) {
      const parsed = WIKI.models.icons.parseRef(referenceOf($(el)))
      if (parsed) {
        wanted.set(parsed.prefix, (wanted.get(parsed.prefix) ?? new Set()).add(parsed.name))
      }
    }

    const resolved = new Map<string, IconifyIcon>()
    for (const [prefix, names] of wanted) {
      const found = await WIKI.models.icons.resolveIcons(prefix, [...names])
      for (const [name, icon] of Object.entries(found.icons)) {
        resolved.set(`${prefix}:${name}`, icon)
      }
    }

    for (const el of elements) {
      const element = $(el)
      const icon = resolved.get(referenceOf(element))
      if (icon) {
        element.replaceWith(this.iconSvg($, element, icon))
      }
    }
  }

  /**
   * The `<svg>` that stands in for one `<iconify-icon>`, carrying over what the author put on it.
   *
   * `icon`, `width`, `height`, `rotate` and `flip` are spent on the drawing itself — parsed by
   * Iconify's own parsers, so `flip="horizontal"` and `rotate="90deg"` mean here exactly what they
   * mean to the element. Everything else the author wrote is theirs and rides along: a class, a style,
   * an id to link to.
   *
   * `inline` becomes the baseline nudge the element applies through its host style, since a shadow
   * root's `:host` rule is the one thing about it that cannot survive being drawn into the page.
   *
   * The attributes are set through cheerio rather than built into the markup: they are author input,
   * and this is the difference between a value that gets escaped on the way out and one that closes
   * the tag it was written into.
   */
  private iconSvg(
    $: cheerio.CheerioAPI,
    element: cheerio.Cheerio<any>,
    icon: IconifyIcon
  ): cheerio.Cheerio<any> {
    const customisations: IconifyIconCustomisations = {}
    const width = element.attr('width')
    const height = element.attr('height')
    const rotate = element.attr('rotate')
    const flip = element.attr('flip')
    if (width) {
      customisations.width = width
    }
    if (height) {
      customisations.height = height
    }
    if (rotate) {
      customisations.rotate = rotateFromString(rotate)
    }
    if (flip) {
      flipFromString(customisations, flip)
    }

    const svg = $(WIKI.models.icons.renderInlineSvg(icon, customisations))

    const {
      icon: _icon,
      width: _w,
      height: _h,
      rotate: _r,
      flip: _f,
      inline,
      style,
      class: authorClass,
      ...carried
    } = element.attr() ?? {}
    for (const [name, value] of Object.entries(carried)) {
      svg.attr(name, value)
    }
    /*
      `icon` is the hook `_page-contents.scss` styles it by, and it is not decorative: Tailwind's
      Preflight makes every `svg` a block, so an icon left to itself takes a line of its own instead
      of sitting in the sentence it was written in. The element it replaces has no such problem — it
      declares `display: inline-block` on its own `:host` — which is exactly why this only shows up
      once the page is saved, with the editor's preview looking right. The twemoji images the emoji
      shortcodes become are styled there for the same reason.
    */
    svg.attr('class', ['icon', authorClass].filter(Boolean).join(' '))
    /*
      The size goes into the style as well as into the attributes, and only when it was asked for.
      `.page-contents` sizes an icon to 1.4em by default — an icon reads small beside text at the 1em
      Iconify draws at — and a CSS width outranks the `width` attribute, so an author who wrote
      `width="32"` would otherwise be overruled by the default they were overriding.

      Both axes, read back off the drawing rather than from what was asked for: an author who gave
      only `width` had the other worked out for them from the icon's ratio, and pinning theirs alone
      would leave the stylesheet supplying a height that does not go with it.
    */
    const sized: string[] = []
    if (width || height) {
      for (const axis of ['width', 'height'] as const) {
        const length = cssLength(svg.attr(axis) ?? '')
        if (length) {
          sized.push(`${axis}:${length}`)
        }
      }
    }
    // -> Ours first so that an author who set any of these themselves still wins
    const styles = [...sized, inline === undefined ? '' : 'vertical-align:-0.125em', style ?? '']
      .filter(Boolean)
      .join(';')
    if (styles) {
      svg.attr('style', styles)
    }
    // -> An icon is decoration unless the author gave it a name, in which case it is theirs to describe
    if (!('role' in carried) && !('title' in carried) && !('aria-label' in carried)) {
      svg.attr('aria-hidden', 'true')
    }

    return svg
  }

  /**
   * Give every heading an id and build the table of contents out of them.
   *
   * The markdown renderer does not emit heading anchors, so this is where a page becomes deep
   * linkable — and the ids have to exist before the contents tree can point at them.
   */
  private anchorHeadings($: cheerio.CheerioAPI): TocNode[] {
    const used = new Map<string, number>()
    const flat: { level: number; node: TocNode }[] = []

    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      const heading = $(el)
      const label = heading.text().trim()
      let key = heading.attr('id') || slugifyHeading(label)

      // -> Two headings can legitimately read the same; the second one becomes `-1`, as anchors
      //    generally do, so that both remain addressable
      const seen = used.get(key) ?? 0
      used.set(key, seen + 1)
      if (seen > 0) {
        key = `${key}-${seen}`
      }

      heading.attr('id', key)
      const level = Number.parseInt(el.tagName.slice(1), 10)
      flat.push({
        level,
        node: { key: `#${key}`, label, level, children: [] }
      })
    })

    return this.nestHeadings(flat)
  }

  /**
   * Turn a flat run of headings into the nested tree the sidebar renders.
   *
   * Levels are treated as relative rather than absolute: a page whose headings start at `h2`, or that
   * skips from `h2` to `h4`, still produces a sensible tree instead of an empty top level.
   */
  private nestHeadings(flat: { level: number; node: TocNode }[]): TocNode[] {
    const root: TocNode[] = []
    const stack: { level: number; node: TocNode }[] = []

    for (const entry of flat) {
      while (stack.length > 0 && stack[stack.length - 1].level >= entry.level) {
        stack.pop()
      }
      if (stack.length > 0) {
        stack[stack.length - 1].node.children.push(entry.node)
      } else {
        root.push(entry.node)
      }
      stack.push(entry)
    }

    return root
  }

  /**
   * The page as plain text, which is what the search index is built from.
   *
   * Works on a copy: scripts and styles read as text but are not prose, and a page carrying them
   * would otherwise turn up in results for whatever its code happens to mention.
   */
  private extractText($: cheerio.CheerioAPI): string {
    const $copy = cheerio.load($.html(), null, false)
    $copy('script, style').remove()
    return $copy.root().text().replaceAll(/\s+/g, ' ').trim()
  }

  /**
   * Internal link targets on the page, resolved to page paths — what `pages.links`
   * (`db/schema.ts`) stores and the knowledge graph endpoint (`api/graph.ts`, OpenProject #872)
   * reads as `link`-type edges.
   *
   * Ported rather than reused from `frontend/src/renderers/markdown.js`'s
   * `isExternalHref`/`fileSrc`: this runs in Node, with no `document` to resolve a bare-relative
   * href against, and only cares about anchors, not images — an internal image is a file under
   * `/_files/`, never another page.
   */
  private extractInternalLinks($: cheerio.CheerioAPI, pagePath: string): string[] {
    const folder = pagePath.split('/').slice(0, -1).join('/')
    const targets = new Set<string>()

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim()
      if (!href || href.startsWith('#') || href.startsWith('//')) {
        return
      }
      // -> Any other scheme (`http:`, `https:`, `mailto:`, `tel:`, ...) is not a page on this
      //    wiki -- `fileSrc` excludes the same set, for the same reason, for images.
      if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
        return
      }
      try {
        const url = new URL(href, `http://page.invalid/${folder ? `${folder}/` : ''}`)
        const target = url.pathname.replace(/^\/+/, '')
        if (target) {
          targets.add(target)
        }
      } catch {
        // -> Malformed href written by an author; nothing to link.
      }
    })

    return [...targets]
  }

  /**
   * Whether this instance can render a page at all.
   *
   * Puppeteer is an extension, and one that is not installed by default: rendering server-side is the
   * only thing that needs it, and everything else keeps working without it.
   */
  async isAvailable(): Promise<boolean> {
    return isPuppeteerAvailable()
  }

  /**
   * Refuse the caller when a page like this one cannot be rendered here.
   *
   * Asked before anything is queued or written rather than left to the job: a request that joins a
   * queue nothing will ever drain looks like it worked, and an approval that cannot produce a matching
   * render would leave a page's HTML lying about its content.
   */
  async ensureCanRender(editor: string): Promise<void> {
    if (editor !== 'markdown') {
      throw new CustomError(
        'renderUnsupportedEditor',
        `Server-side rendering is not implemented for the ${editor} editor.`
      )
    }
    await assertPuppeteerAvailable(
      'renderPuppeteerMissing',
      'Rendering a page on the server needs the Puppeteer extension, which is not installed.'
    )
  }

  /**
   * Ask for a page to be rendered, and make sure something will come along to do it.
   *
   * The row is the request and there is only ever one per page, so asking repeatedly — a queue of
   * suggestions being approved onto the same page, an impatient author — collapses into one render of
   * whatever the content has become. `createdAt` is left alone on that path, since a repeat request is
   * not a new one and must not overtake pages that have been waiting longer.
   *
   * The drain job is only added when the queue has none pending, and a spare one is harmless anyway:
   * it finds the table empty and returns without so much as launching a browser.
   */
  async queuePage({
    siteId,
    pageId,
    permissions,
    requestedById
  }: {
    siteId: string
    pageId: string
    permissions: RenderPermissions
    requestedById?: string | null
  }): Promise<void> {
    await WIKI.db
      .insert(renderQueueTable)
      .values({
        siteId,
        pageId,
        allowScripts: permissions.scripts,
        allowStyles: permissions.styles,
        requestedById: requestedById ?? null
      })
      .onConflictDoUpdate({
        target: renderQueueTable.pageId,
        set: {
          allowScripts: permissions.scripts,
          allowStyles: permissions.styles,
          requestedById: requestedById ?? null,
          updatedAt: sql`now()`
        }
      })

    const pending = await WIKI.db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.task, DRAIN_TASK))
      .limit(1)
    if (pending.length < 1) {
      // -> No retries: a render nobody can produce is not worth attempting three times, and the row
      //    stays queued for the next drain either way
      await WIKI.scheduler.addJob({ task: DRAIN_TASK, maxRetries: 0 })
    }
  }

  /**
   * Render every queued page, one at a time, through a single browser.
   *
   * This is the whole point of the queue: a browser costs hundreds of megabytes, so there is exactly
   * one, it is opened when the first page is claimed and reused for the rest of the batch, and no two
   * renders overlap. The scheduler cannot promise that on its own — it runs up to
   * `scheduler.workers` jobs at once — so a second call while this is running does not start a second
   * browser. It asks the one already going to look again before it stops, which is what stops a page
   * queued in the moment between the last claim and the end of the drain from waiting for the next
   * request to come along.
   */
  async drainQueue(): Promise<void> {
    if (this.draining) {
      this.drainRequested = true
      return
    }
    this.draining = true
    try {
      do {
        this.drainRequested = false
        await this.renderQueuedPages()
      } while (this.drainRequested)
    } finally {
      this.draining = false
    }
  }

  /** True while `drainQueue` is working, so that a second call joins it instead of duplicating it. */
  private draining = false

  /** Set when a drain is asked for during one, and re-checked before the running drain gives up. */
  private drainRequested = false

  /**
   * The drain itself: claim a page, render it, store it, repeat until the queue is empty.
   *
   * Claiming is a delete, so an instance can never pick up a page another one is already rendering,
   * and a render that fails is a render that was asked for and did not happen — logged, with the page
   * keeping the HTML it had. Re-queueing it here would be a loop, since whatever made it fail is still
   * true.
   *
   * A failure also drops the browser rather than trusting it: the likeliest one is a render that ran
   * out of time, which leaves a page wedged in whatever loop it was in, and the pages behind it in the
   * queue have done nothing to deserve that.
   */
  private async renderQueuedPages(): Promise<void> {
    // -> Asked before anything else so that the common drain — a spare job for a batch already swept —
    //    costs one query and says nothing
    const waiting = await WIKI.db
      .select({ id: renderQueueTable.id })
      .from(renderQueueTable)
      .limit(1)
    if (waiting.length < 1) {
      return
    }
    if (!(await this.isAvailable())) {
      WIKI.logger.warn(
        'Pages are queued for rendering but the Puppeteer extension is not installed. Leaving them queued.'
      )
      return
    }

    let renderer: PageRenderer | null = null
    try {
      while (true) {
        /*
          Deliberately outside the per-page catch below, and ahead of the claim: a browser that will
          not open is not this page's fault and will not be the next one's either. Letting that throw
          ends the drain with the queue untouched, where treating it as a page failure would burn
          through every row in it — and claiming is a delete.
        */
        renderer ??= await this.createRenderer()

        const claimed = await WIKI.db
          .delete(renderQueueTable)
          .where(
            inArray(
              renderQueueTable.id,
              sql`(SELECT id FROM "pageRenderQueue" ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)`
            )
          )
          .returning()
        const entry = claimed[0]
        if (!entry) {
          return
        }

        try {
          const page = await WIKI.models.pages.getPage({
            siteId: entry.siteId,
            id: entry.pageId,
            withContent: true
          })
          if (!page) {
            // -> Deleted while it waited. The cascade takes the row with it, so this is only reachable
            //    for a page that went between the claim and here.
            continue
          }
          if (page.editor !== 'markdown') {
            WIKI.logger.warn(
              `Cannot render page ${page.id}: server-side rendering is not implemented for the ${page.editor} editor.`
            )
            continue
          }
          const html = await renderer.render(
            page.content ?? '',
            {
              ...WIKI.sites[entry.siteId]?.config?.editors?.[page.editor]?.config,
              // -> No specific reader to speak for in a background re-render (OpenProject #1127) --
              //    resolved as an anonymous visitor would be, rather than skipping the check.
              glossaryTerms: await WIKI.models.glossary.getCachedTerms(
                entry.siteId,
                WIKI.models.groups.guestActor()
              )
            },
            { pagePath: page.path, siteOrigin: this.resolveSiteOrigin(entry.siteId) }
          )
          await WIKI.models.pages.storeRender(
            entry.siteId,
            page.id,
            html,
            { scripts: entry.allowScripts, styles: entry.allowStyles },
            page.path
          )
          WIKI.logger.debug(`Rendered page ${page.id} (${page.path}) from its source.`)
        } catch (err: any) {
          WIKI.logger.warn(`Failed to render page ${entry.pageId}: ${err.message}`)
          await this.discardRenderer(renderer)
          renderer = null
        }
      }
    } finally {
      await this.discardRenderer(renderer)
    }
  }

  /**
   * Close a renderer, and keep any trouble doing so to itself.
   *
   * Every close happens on a path that is already finished with the browser — most of them right after
   * a render failed, which is exactly when it is likeliest to be gone already. Letting that failure
   * out would replace the real one, or fail a drain that had otherwise finished its work.
   */
  private async discardRenderer(renderer: PageRenderer | null): Promise<void> {
    await closeQuietly(renderer, 'render browser')
  }

  /**
   * The site's real public origin, for the headless renderer's `is-external-link` classification to
   * match what the same page's own editor save would have produced (OpenProject #1751).
   *
   * `https://<hostname>` is assumed, matching `models/mail.ts`'s `resolveMailBaseURL` — no per-site
   * override setting exists for scheme/port (v1 scope decision, OpenProject #1023). `undefined` for
   * the `*` catch-all site (no hostname of its own) or an unresolvable siteId: `isExternalHref` then
   * falls back to the headless browser's own `location`, exactly the pre-#1751 behavior, since there
   * is no real origin to compare against.
   */
  private resolveSiteOrigin(siteId: string): string | undefined {
    const hostname = WIKI.sites[siteId]?.hostname
    return hostname && hostname !== '*' ? `https://${hostname}` : undefined
  }

  /**
   * Open a headless browser on the renderer bundle and hand back something that renders through it.
   *
   * The markdown pipeline lives in the frontend and stays there — this drives it rather than
   * reimplementing it, so a page rendered by the server comes out identical to one saved from the
   * editor.
   *
   * One tab is enough for any number of pages: `__wikiRender` builds a fresh renderer per call and
   * returns a string, so nothing carries over between them but the bundle's own warm caches.
   */
  private async createRenderer(): Promise<PageRenderer> {
    // -> `helpers/puppeteer.ts` also backs `models/pdfExport.ts`'s PDF export, so both share one
    //    launch path — same flags, same load-failure tracking
    const browser = await launchPuppeteerBrowser('renderPuppeteerMissing')
    try {
      const page = await browser.newPage()
      // -> A shell page whose only job is to load the frontend's renderer bundle. It is served by this
      //    instance, so the bundle it loads is the one this instance's editor uses.
      await page.goto(`http://127.0.0.1:${WIKI.config.port}/_render`, {
        waitUntil: 'networkidle0'
      })
      await page.waitForFunction('window.__wikiRenderReady === true', {
        timeout: RENDER_READY_TIMEOUT
      })

      return {
        async render(
          content: string,
          config: Record<string, any>,
          context: Record<string, any>
        ): Promise<string> {
          /*
            `page.evaluate` has no timeout of its own, and what it calls is a synchronous pass over
            content somebody else wrote: an input that sends one of the markdown plugins into
            catastrophic backtracking would otherwise hold the browser open for as long as it runs, and
            every page behind it in the queue with it. Losing the race throws, and the caller closes
            this renderer rather than reusing a tab that is still busy.
          */
          // -> This callback is serialized and runs in the browser, where `globalThis` is the window
          //    the renderer bundle attached itself to
          return await withTimeout(
            page.evaluate(
              (src: string, cfg: Record<string, any>, ctx: Record<string, any>) =>
                (globalThis as any).__wikiRender(src, cfg, ctx),
              content,
              config,
              context
            ),
            RENDER_TIMEOUT,
            () =>
              new CustomError(
                'renderTimeout',
                `Rendering did not finish within ${RENDER_TIMEOUT / 1000} seconds.`,
                504
              )
          )
        },
        async close(): Promise<void> {
          await browser.close()
        }
      }
    } catch (err: any) {
      // -> The browser is up but unusable, and nothing else holds a reference to it. Whatever went
      //    wrong loading the bundle is the failure worth reporting, not whatever closing says about it.
      try {
        await browser.close()
      } catch {}
      throw err
    }
  }
}

export const rendering = new Rendering()
