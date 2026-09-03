import * as cheerio from 'cheerio'
import sanitizeHtml from 'sanitize-html'
import { flipFromString, rotateFromString } from '@iconify/utils'
import {
  blockAllowances,
  sanitizeOptions,
  unwrapOrphanedChildBlocks
} from '../helpers/htmlSanitizePolicy.ts'
import type { IconifyIcon } from '@iconify/types'
import type { IconifyIconCustomisations } from '@iconify/utils'
import type { RenderPermissions } from '../helpers/htmlSanitizePolicy.ts'

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
 * What may survive that sanitize step -- the tag/attribute/style allowlists and the block allowances
 * built on top of them -- is `helpers/htmlSanitizePolicy.ts`; this file is the pipeline that applies
 * it and pulls the derived pieces out afterwards.
 *
 * Re-rendering an existing page from its source — which the server needs when the content is there
 * but the render is stale — goes back through the very same frontend pipeline, driven in a headless
 * browser. That is a job rather than part of a request: see `models/renderQueue.ts`.
 */

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
    const options = sanitizeOptions(permissions, blockAllowances(enabledBlocks, customBlocks))

    let $ = cheerio.load(sanitizeHtml(html ?? '', options), null, false)

    this.stripEditorArtifacts($)
    unwrapOrphanedChildBlocks($)
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
}

export const rendering = new Rendering()
