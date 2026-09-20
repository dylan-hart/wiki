import * as cheerio from 'cheerio'
import sanitizeHtml from 'sanitize-html'
import { flipFromString, rotateFromString } from '@iconify/utils'
import {
  applyPermissionPlaceholders,
  blockAllowances,
  sanitizeOptions,
  unwrapOrphanedChildBlocks
} from '../helpers/htmlSanitizePolicy.ts'
import { stripLocalePrefix } from '../helpers/localeRouting.ts'
import type { IconifyIcon } from '@iconify/types'
import type { IconifyIconCustomisations } from '@iconify/utils'
import type { RenderPermissions } from '../helpers/htmlSanitizePolicy.ts'

/**
 * Markdown becomes HTML in the browser — the editor's preview is the render that gets stored, so
 * the two cannot drift apart. This model is what has to happen afterwards and cannot be left to a
 * client: sanitizing HTML that arrived as user input against the author's permissions, stripping
 * the editor's preview scaffolding, anchoring headings, drawing icon references in once at save
 * time rather than per reader, and deriving the toc/text/links from the settled HTML.
 *
 * The allowlists that sanitize step applies are `helpers/htmlSanitizePolicy.ts`'s.
 */

export interface TocNode {
  key: string
  label: string
  /**
   * The heading's own tag level, kept alongside the nesting because the two say different things: a
   * contents list asked to show "H1 to H2" means the tag an author reached for, and an `h3` written
   * under an `h1` is still an `h3` however few levels sit above it.
   */
  level: number
  children: TocNode[]
}

export interface PostProcessResult {
  render: string
  toc: TocNode[]
  text: string
  links: string[]
}

const EDITOR_ARTIFACT_ATTRIBUTES = ['data-line']

/**
 * Iconify reads a bare `32` as pixels and CSS does not, so the unit has to be spelled out. Anything
 * that is not a plain length is refused rather than passed along: this ends up inside a `style`,
 * where a value carrying a `;` would be a second declaration riding in on the first.
 */
function cssLength(value: string): string {
  const match = /^(\d+(?:\.\d+)?)(px|em|rem|%)?$/.exec(value.trim())
  return match ? `${match[1]}${match[2] ?? 'px'}` : ''
}

/**
 * Deliberately plain — lowercase, words joined by hyphens — because these end up in URLs people
 * copy and share, and a shared link should survive edits that do not change the heading's words.
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

const TAB_TAG = 'block-tab'

export function tabHeadingLevel(header: string | undefined): number | null {
  return header !== undefined && /^[1-6]$/.test(header) ? Number.parseInt(header, 10) : null
}

class Rendering {
  /**
   * What the author is not granted is stripped rather than rejected: pasting a snippet carrying a
   * tracking script should save the page without it, not fail with an error nobody can act on.
   */
  async postProcess(
    siteId: string,
    html: string,
    permissions: RenderPermissions,
    pagePath: string = ''
  ): Promise<PostProcessResult> {
    const enabledBlocks = await CARDINAL.models.blocks.getEnabledKeys(siteId)
    const customBlocks = await CARDINAL.models.blocks.getCustomBlockDefinitions(siteId)
    const options = sanitizeOptions(
      permissions,
      blockAllowances(enabledBlocks, customBlocks),
      // -> Additive to the hardcoded `ALLOWED_SCHEMES` floor, never a replacement for it. Both an
      //    unconfigured site and a missing `CARDINAL.sites` (a stub, or a race with a cache reload)
      //    read as absent, which `sanitizeOptions()` treats as an empty list.
      CARDINAL.sites?.[siteId]?.config?.allowedUrlSchemes
    )

    /*
      Gated tags are swapped for their visible callout BEFORE the first `sanitizeHtml()` call: once
      it has run, a tag the author was never allowed to write and one they wrote without the
      permission for it look identical -- both are simply gone. Only against the DOM as the client
      sent it can the two still be told apart.
    */
    const gated = cheerio.load(html ?? '', null, false)
    applyPermissionPlaceholders(gated, permissions)

    let $ = cheerio.load(sanitizeHtml(gated.html(), options), null, false)

    this.stripEditorArtifacts($)
    unwrapOrphanedChildBlocks($)
    this.liftIconChildren($)
    await this.inlineIcons($)

    /*
      `inlineIcons()` just inserted markup the first `sanitizeHtml()` above never saw: an icon body
      screened only by `models/icons.ts#isSafeIconBody`'s denylist. A denylist misses what an
      allowlist cannot -- an entity-encoded scheme (`<a href="&#106;avascript:…">`) passes a literal
      `javascript:` string check and decodes back to a live href once the page is parsed -- so this
      second pass is the compensating control, against the very same `options` object rather than an
      independently built one, so the two calls cannot drift apart.

      `toc`/`text`/`links` come out of THIS document, so what they describe matches what is stored.
    */
    $ = cheerio.load(sanitizeHtml($.html(), options), null, false)

    const toc = this.anchorHeadings($)
    const links = this.extractInternalLinks($, pagePath, siteId)

    return {
      render: $.html(),
      toc,
      text: this.extractText($),
      links
    }
  }

  /** `data-line`/`.line` are the editor's preview scroll-sync markers, meaningless once stored. */
  private stripEditorArtifacts($: cheerio.CheerioAPI): void {
    for (const attribute of EDITOR_ARTIFACT_ATTRIBUTES) {
      $(`[${attribute}]`).removeAttr(attribute)
    }
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
   * `<iconify-icon icon="…" />` is what an author reaches for, but it is not a self-closing tag:
   * the parser hands the element the rest of the paragraph as children, and it paints a shadow
   * root with no slot — so that text is in the document, counted as content, and invisible on the
   * page. Nothing legitimately goes inside an icon, so lifting the children out is the only reading
   * that keeps what was written.
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
   * The element is a reference, costing every reader a request to `/_icons` per set before the icon
   * appears. Resolving it here spends that once, on the person saving, and the stored page goes on
   * drawing its icons if the set is later deleted or the instance goes offline.
   *
   * An icon that does not resolve is left as the element it was — the set may be one an admin is
   * about to add, and the element still resolves at view time — which also makes this safe to run
   * over a render that has already been through it.
   */
  private async inlineIcons($: cheerio.CheerioAPI): Promise<void> {
    const elements = $('iconify-icon').toArray()
    if (elements.length < 1) {
      return
    }

    const referenceOf = (element: cheerio.Cheerio<any>) =>
      (element.attr('icon') ?? '').trim().toLowerCase()

    /*
      Gathered per set before anything is resolved, because `resolveIcons` takes a list: a page full
      of icons from one set is one query and at most one upstream request, not one per icon.
    */
    const wanted = new Map<string, Set<string>>()
    for (const el of elements) {
      const parsed = CARDINAL.models.icons.parseRef(referenceOf($(el)))
      if (parsed) {
        wanted.set(parsed.prefix, (wanted.get(parsed.prefix) ?? new Set()).add(parsed.name))
      }
    }

    const resolved = new Map<string, IconifyIcon>()
    for (const [prefix, names] of wanted) {
      const found = await CARDINAL.models.icons.resolveIcons(prefix, [...names])
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
   * `icon`, `width`, `height`, `rotate` and `flip` are spent on the drawing itself, through
   * Iconify's own parsers, so they mean here what they mean to the element; everything else the
   * author wrote rides along. `inline` becomes the baseline nudge the element applies through its
   * `:host` style, which is the one thing about it that cannot survive being drawn into the page.
   *
   * Attributes are set through cheerio rather than built into a markup string: they are author
   * input, and that is the difference between a value escaped on the way out and one that closes
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

    const svg = $(CARDINAL.models.icons.renderInlineSvg(icon, customisations))

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
      `icon` is the hook `_page-contents.scss` styles it by, and it is load-bearing: Tailwind's
      Preflight makes every `svg` a block, so an icon left to itself takes a line of its own instead
      of sitting in the sentence it was written in. The element it replaces declares
      `display: inline-block` on its own `:host`, so the editor's preview looks right either way and
      the difference shows only once the page is saved.
    */
    svg.attr('class', ['icon', authorClass].filter(Boolean).join(' '))
    /*
      The size goes into the style as well as the attributes, and only when it was asked for: a CSS
      width outranks the `width` attribute, so `.page-contents`'s default sizing would otherwise
      overrule the author who wrote `width="32"` to override it.

      Both axes, read back off the drawing rather than from what was asked for: an author who gave
      only `width` had the other worked out from the icon's ratio, and pinning theirs alone would
      leave the stylesheet supplying a height that does not go with it.
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
    // -> An icon is decoration unless the author named it, in which case it is theirs to describe
    if (!('role' in carried) && !('title' in carried) && !('aria-label' in carried)) {
      svg.attr('aria-hidden', 'true')
    }

    return svg
  }

  /**
   * The markdown renderer emits no heading anchors, so this is where a page becomes deep linkable —
   * and the ids have to exist before the contents tree can point at them.
   */
  private anchorHeadings($: cheerio.CheerioAPI): TocNode[] {
    const used = new Map<string, number>()
    const flat: { level: number; node: TocNode }[] = []

    $(`h1, h2, h3, h4, h5, h6, ${TAB_TAG}[header]`).each((_, el) => {
      const heading = $(el)
      const isTab = el.tagName === TAB_TAG
      const level = isTab
        ? tabHeadingLevel(heading.attr('header'))
        : Number.parseInt(el.tagName.slice(1), 10)
      const label = (isTab ? (heading.attr('label') ?? '') : heading.text()).trim()
      if (level === null || (isTab && label === '')) {
        return
      }
      let key = heading.attr('id') || slugifyHeading(label)

      // -> Two headings can legitimately read the same; the repeat is suffixed, as anchors
      //    generally are, so both stay addressable
      const seen = used.get(key) ?? 0
      used.set(key, seen + 1)
      if (seen > 0) {
        key = `${key}-${seen}`
      }

      heading.attr('id', key)
      flat.push({
        level,
        node: { key: `#${key}`, label, level, children: [] }
      })
    })

    return this.nestHeadings(flat)
  }

  /**
   * Levels are relative, not absolute: a page whose headings start at `h2`, or that skips `h2` to
   * `h4`, still produces a sensible tree rather than an empty top level.
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
   * Works on a copy: scripts and styles read as text but are not prose, and a page carrying them
   * would otherwise turn up in search results for whatever its code happens to mention.
   */
  private extractText($: cheerio.CheerioAPI): string {
    const $copy = cheerio.load($.html(), null, false)
    $copy('script, style').remove()
    return $copy.root().text().replaceAll(/\s+/g, ' ').trim()
  }

  /**
   * Ported rather than reused from `frontend/src/renderers/markdown.js`'s `isExternalHref`/
   * `fileSrc`: this runs in Node, with no `document` to resolve a bare-relative href against, and
   * cares only about anchors — an internal image is a file under `/_files/`, never another page.
   *
   * `LinkPickerDialog.vue` writes a locale-prefixed href (`/fr/guide`) for a target outside the
   * editing page's locale, and for every target on a `forcePrefix` site. The prefix is stripped
   * before storing, since every consumer of `pages.links` assumes the bare path in the linking
   * page's own locale, the same convention a hand-typed same-locale link follows.
   */
  private extractInternalLinks($: cheerio.CheerioAPI, pagePath: string, siteId: string): string[] {
    const folder = pagePath.split('/').slice(0, -1).join('/')
    const targets = new Set<string>()
    const locales = CARDINAL.sites?.[siteId]?.config?.locales

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')?.trim()
      if (!href || href.startsWith('#') || href.startsWith('//')) {
        return
      }
      // -> Any scheme at all (`http:`, `mailto:`, `tel:`, ...) means this is not a page here
      if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
        return
      }
      try {
        const url = new URL(href, `http://page.invalid/${folder ? `${folder}/` : ''}`)
        const stripped = stripLocalePrefix(url.pathname, locales)
        const target = (stripped ? stripped.path : url.pathname).replace(/^\/+/, '')
        if (target) {
          targets.add(target)
        }
      } catch {
        // -> Malformed href; nothing to link
      }
    })

    return [...targets]
  }
}

export const rendering = new Rendering()
