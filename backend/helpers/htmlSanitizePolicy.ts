import sanitizeHtml from 'sanitize-html'
import type * as cheerio from 'cheerio'
import type { BlockProp } from '../models/blocks.ts'

/**
 * What a page's HTML is allowed to contain, expressed as `sanitize-html` options.
 *
 * The HTML a page is stored as arrives from a browser (see `models/rendering.ts` for why rendering
 * happens there and not here), so it is user input like any other. This file is the whole of the
 * answer to "what may survive that": the tag/attribute/style/scheme allowlists, the permission-gated
 * additions on top of them, and the two block-shaped questions that cannot be answered by a static
 * list — which `block-*` elements this site has switched on, and which child blocks still have a
 * parent to belong to.
 *
 * Kept out of `models/rendering.ts` because it is policy rather than pipeline: given a set of
 * permissions and a site's block definitions it is a pure description of the allowed shape of a
 * document, with no rendering, extraction or queueing around it.
 */

/** The shape `blockAllowances()` needs from a custom block -- see `models/blocks.ts#getCustomBlockDefinitions()`. */
export interface CustomBlockAllowance {
  block: string
  props: BlockProp[]
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
export function blockAllowances(
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
export function unwrapOrphanedChildBlocks($: cheerio.CheerioAPI): void {
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
export function sanitizeOptions(
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
