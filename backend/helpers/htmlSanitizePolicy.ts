import sanitizeHtml from 'sanitize-html'
import type * as cheerio from 'cheerio'
import type { BlockProp } from '../models/blocks.ts'

/**
 * What a page's HTML may contain, as `sanitize-html` options. The stored HTML arrives from a
 * browser (rendering happens there, see `models/rendering.ts`), so it is user input like any other.
 * Policy, not pipeline: pure functions of permissions and a site's block definitions.
 */

export interface CustomBlockAllowance {
  block: string
  props: BlockProp[]
}

export interface RenderPermissions {
  /** `write:scripts` — `<script>`, `<iframe>` and inline event handlers. */
  scripts: boolean
  /** `write:styles` — `<style>` and any inline `style` declaration, not just `ALLOWED_STYLES`. */
  styles: boolean
}

/**
 * Deliberately broad: this is a wiki, the markdown renderer has `allowHTML` on by default, and
 * authors are expected to reach for raw HTML. The line being drawn is not "what looks like a
 * document" but "what can execute" — those are the permission-gated parts below.
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
    The one custom element here that is not a block, and ungated: it is inert markup, and the
    frontend's `boot/iconify.js` points the element at this instance's `/_icons`, so an icon in
    content reaches no third party.

    Not self-closing, whatever the author writes: the parser gives `<iconify-icon … />` the rest of
    the paragraph as children, and the element's shadow root has no slot to show them with.
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
  //    Not for MathJax: `block-mathjax` draws its SVG inside its shadow root at view time, so only
  //    its fenced source is ever sanitised and stored, and `SVG_ATTRIBUTES` deliberately omits what
  //    that drawing uses (`xlink:href`, `focusable`).
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
  //    KaTeX sizes and positions every piece of a formula with inline styles. What the permission
  //    gates is which *declarations* survive inside it -- see `ALLOWED_STYLES`.
  '*': ['id', 'class', 'style', 'title', 'dir', 'lang', 'aria-*', 'role', 'data-*'],
  a: ['href', 'name', 'target', 'rel', 'download'],
  audio: ['controls', 'loop', 'muted', 'preload', 'src'],
  // -> Everything the element reads except `mode`, which picks how it paints (mask/background) and
  //    only matters to an author working around a specific icon set's colouring.
  'iconify-icon': ['icon', 'inline', 'width', 'height', 'rotate', 'flip'],
  img: ['src', 'srcset', 'alt', 'width', 'height', 'loading', 'decoding'],
  input: ['type', 'checked', 'disabled'],
  ol: ['start', 'reversed', 'type'],
  source: ['src', 'srcset', 'type', 'media'],
  td: ['colspan', 'rowspan', 'align'],
  th: ['colspan', 'rowspan', 'align', 'scope'],
  track: ['src', 'kind', 'srclang', 'label', 'default'],
  video: ['controls', 'loop', 'muted', 'poster', 'preload', 'src', 'width', 'height'],
  // -> MathML carries its meaning in attributes, and none of them are executable. Dropping one
  //    (`mover[accent]`, `mi[mathvariant]`, …) leaves the screen-reader-only MathML copy of a KaTeX
  //    formula missing the marking that says an accent or a variant applies.
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

/** The units are the ones KaTeX emits. */
const CSS_LENGTH = /^(-?\d+(\.\d+)?(em|px|ex|%)|0)$/

/** KaTeX only ever emits a length; the keywords are for a hand-written `vertical-align`. */
const VERTICAL_ALIGN =
  /^(-?\d+(\.\d+)?(em|px|ex|%)|0|baseline|top|middle|bottom|sub|super|text-top|text-bottom)$/

/** `#hex`, `rgb()`/`hsl()` or a bare keyword: nothing that can carry `url()` or an expression. */
const CSS_COLOR = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\([\d\s.,%]+\)|[a-zA-Z]+)$/

/**
 * `fixed`/`absolute`/`sticky` are excluded: with `inset`/`top`/`left` and `z-index` they let
 * ordinary page content cover the viewport. The value is restricted, rather than the property
 * dropped, because `relative` is real KaTeX output (`\overbrace`/`\underset` constructions).
 */
const SAFE_POSITION = /^(relative|static)$/

/**
 * Inline `style` declarations kept for an author *without* `write:styles`: what KaTeX's
 * `output: 'html'` mode emits, plus the obvious siblings (`margin-*`, `padding-*`, `border-*`,
 * `font-size`, `text-align`) an author could expect `style="…"` to cover. Anything that can overlay
 * or hide content is either not a key at all (`transform`, `opacity`, `pointer-events`, `content`,
 * `z-index`, `inset`) or has its value locked down (`position`).
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
 * The floor, not the ceiling: a site's `allowedUrlSchemes` config adds custom schemes (`discord:`,
 * `obsidian:`, …) through `mergeAllowedSchemes()`.
 */
const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel', 'ftp']

/** These run script outright, so they are refused on every tag, `img` included. */
const FORBIDDEN_SCHEMES = new Set(['javascript', 'vbscript'])

/**
 * `data:` has one legitimate, non-executable use: a small inline image in `img src`. Anywhere else
 * -- an `<a href>`, an `<iframe src>` -- it can carry a `data:text/html,<script>…` document that
 * scripts like a `javascript:` URL would. `sanitizeOptions()` passes `allowData: true` for the
 * `img` scheme list only.
 */
const NON_IMG_FORBIDDEN_SCHEMES = new Set(['data'])

/** `sanitize-html` expects a bare, lower-case scheme with no trailing `:`. */
function normalizeScheme(raw: string): string {
  return raw.trim().toLowerCase().replace(/:$/, '')
}

/**
 * The only function allowed to produce a `sanitize-html` `allowedSchemes`/`allowedSchemesByTag`
 * value, so the forbidden-scheme refusal cannot be routed around by a future caller. Site-settings
 * validation is a UX nicety; this is the security boundary.
 */
export function mergeAllowedSchemes(
  additionalSchemes: string[] = [],
  { allowData = false }: { allowData?: boolean } = {}
): string[] {
  const merged = new Set(ALLOWED_SCHEMES)
  if (allowData) {
    merged.add('data')
  }
  for (const raw of additionalSchemes) {
    const scheme = normalizeScheme(raw)
    if (!scheme || FORBIDDEN_SCHEMES.has(scheme)) {
      continue
    }
    if (NON_IMG_FORBIDDEN_SCHEMES.has(scheme) && !allowData) {
      continue
    }
    merged.add(scheme)
  }
  return [...merged]
}

/**
 * The block elements a page may carry, each with exactly the attributes its component declares as
 * props. A block is not HTML, so without this the sanitiser would drop every one. The markup is
 * inert: what makes a block do anything is the component fetched from `/_blocks` at view time.
 *
 * A custom block's prop names are trusted here without re-checking. sanitize-html matches attribute
 * names with `*` globs, so a prop named `on*` or `*` would open inline event handlers (or every
 * attribute) on that element; `helpers/blockDefinition.ts#extractBlockDefinition()` rejecting such
 * names at upload time is the only gate.
 *
 * Installed is not sufficient: the block also has to be switched on for this site. Leaving that to
 * the editor's picker would only cover authors who use it — the content is markdown, so
 * `::block-diagram` is a thing anybody can type.
 *
 * Turning a block off does NOT rewrite pages that already embed it: the stored render keeps
 * `<block-x>` until the page is next saved or re-rendered, which is when this strips it. Readers
 * are covered meanwhile, since the reader view only mounts blocks the site reports as enabled.
 *
 * Child blocks are exempt, having no switch of their own: a tab is part of the tabs it sits in,
 * and is gated by `unwrapOrphanedChildBlocks` once the parent's fate is known.
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
  for (const definition of CARDINAL.models.blocks.definitions) {
    if (!definition.isChild && !enabledBlocks.has(definition.block)) {
      continue
    }
    const tag = `block-${definition.block}`
    tags.push(tag)
    /*
      `sanitizeOptions()` sets `lowerCaseAttributeNames: false`, so attribute names compare
      byte-for-byte. A prop is declared camelCase (`runKey`), but the DOM -- what an author types or
      Lit reflects -- only ever spells it lowercase (`runkey`). Emit both so either survives.
    */
    attributes[tag] = [
      ...new Set((definition.props ?? []).flatMap((prop) => [prop.name, prop.name.toLowerCase()]))
    ]
  }
  // -> A custom block is never a child (`isChild` comes from the built-in manifest), so the enabled
  //    check applies unconditionally.
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
 * A child block passes the sanitiser unconditionally, because its fate is its parent's. By this
 * point a disabled parent has already been dropped, so a child with no block above it is one whose
 * parent was turned off, or one an author typed on its own.
 *
 * Unwrapped rather than deleted, which is what the sanitiser does to every other tag it refuses:
 * the element goes, the content the author wrote inside it stays.
 */
export function unwrapOrphanedChildBlocks($: cheerio.CheerioAPI): void {
  const definitions = CARDINAL.models.blocks.definitions
  const childTags = definitions.filter((d) => d.isChild).map((d) => `block-${d.block}`)
  if (childTags.length < 1) {
    return
  }
  /*
    Every non-child block, not merely the enabled ones: a disabled block is not in the document to
    be matched, and this stays a question about nesting rather than a second copy of the
    enabled-block rule that could disagree with the first.
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
 * Shaped like what a `> [!CAUTION]` admonition renders (`github-alerts.js`'s `caution` kind:
 * `is-danger` / "Caution"), so a reader sees the same object either way.
 *
 * Mirrored by the frontend's own `gatedContentPlaceholder()` in `renderers/markdown.js` for the
 * editor's live preview -- the workspaces share no module, so keep the two in sync. Each side's
 * test pins the exact string.
 */
export function gatedContentPlaceholder(permission: 'write:scripts' | 'write:styles'): string {
  return `<blockquote class="is-danger"><p class="alert-title">Caution</p><p>This content requires the ${permission} permission and was not rendered.</p></blockquote>`
}

/**
 * Must run over the DOM BEFORE `sanitizeHtml()` sees it: the library has no hook that fires only
 * for a tag it is about to strip, so afterwards "never written" and "written but not permitted"
 * look identical. The placeholder survives that pass because `blockquote`/`p` are on
 * `BASE_ALLOWED_TAGS` unconditionally. Mutates `$`.
 */
export function applyPermissionPlaceholders(
  $: cheerio.CheerioAPI,
  permissions: RenderPermissions
): void {
  if (!permissions.scripts) {
    $('iframe, script').each((_, el) => {
      $(el).replaceWith(gatedContentPlaceholder('write:scripts'))
    })
  }
  if (!permissions.styles) {
    $('style').each((_, el) => {
      $(el).replaceWith(gatedContentPlaceholder('write:styles'))
    })
  }
}

/**
 * `models/rendering.ts#postProcess` sanitises twice -- as the HTML arrives from the editor, and
 * again after `inlineIcons()` has drawn more markup into the document -- and builds this once for
 * both: two independently-built option objects could drift apart in a way one shared object cannot.
 */
export function sanitizeOptions(
  permissions: RenderPermissions,
  blocks: { tags: string[]; attributes: Record<string, string[]> },
  additionalSchemes: string[] = []
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
    //    running a script
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
    // -> An author with `write:styles` may already embed a `<style>` tag, so filtering their
    //    `style` *attribute* would gate one capability two ways. Omitting `allowedStyles` is
    //    `sanitize-html`'s documented way to say "keep every declaration, unfiltered".
    allowedStyles: permissions.styles ? undefined : ALLOWED_STYLES,
    // -> `script` and `style` in the allow list are what `write:scripts` and `write:styles` mean:
    //    the library's per-call warning is the thing to silence, not the permission
    allowVulnerableTags: permissions.scripts || permissions.styles,
    allowedSchemes: mergeAllowedSchemes(additionalSchemes),
    allowedSchemesByTag: {
      img: mergeAllowedSchemes(additionalSchemes, { allowData: true })
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
