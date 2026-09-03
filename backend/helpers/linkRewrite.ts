import path from 'node:path'
import * as cheerio from 'cheerio'

/**
 * Move-time link rewrite (OpenProject #2424/#2452): when a page's path changes, every OTHER page on
 * the same site whose content links to it needs that link updated too, or the move leaves a dead
 * link behind.
 *
 * This deliberately does not parse markdown/asciidoc/HTML source to find links -- the Epic's own
 * scope decision is to reuse the link data `models/rendering.ts#extractInternalLinks` already
 * derives on every save (the same `pages.links` column `listBacklinks` -- OpenProject #1914 --
 * already indexes) rather than build new per-format parsing. Concretely:
 *
 *  - `render` (the sanitized HTML actually served to a reader) is walked with the same href
 *    resolution `extractInternalLinks` uses, so "does this anchor point at the moved page" is
 *    answered identically to how it was indexed in the first place.
 *  - Raw `content` is never parsed by format either. A page path may only contain
 *    `[A-Za-z0-9_-]` and `/` (`models/pages.ts`'s `rePagePath`), so there is no HTML-entity
 *    encoding difference between an anchor's literal `href="…"` text and the same target as it
 *    appears in markdown/asciidoc/HTML/plain-text source -- a literal, global string swap of the
 *    anchor's own href text is exactly the same edit a per-format parser would have made, without
 *    writing one. This does not catch every possible authoring shape (a markdown reference-style
 *    link's definition line uses the same href text and IS caught; a link built by string
 *    concatenation inside a block is not), which is why `render` is authoritative for "no dead
 *    links left behind" and `content` is a best-effort sync for the next time the page is edited.
 */

/**
 * Resolve an anchor's `href` to the in-site page path it targets, exactly as
 * `models/rendering.ts#extractInternalLinks` resolves it when populating `pages.links` -- so a
 * candidate found via `listBacklinks` (which is keyed off that same column) is re-confirmed here
 * against the identical rule, not a second, possibly-diverging one.
 *
 * @returns null for anything that isn't an in-site page link: an anchor, `//`-protocol-relative,
 *          another scheme (`https:`, `mailto:`, …), or a malformed href.
 */
function resolveInternalTarget(href: string, folder: string): string | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) {
    return null
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    return null
  }
  try {
    const url = new URL(href, `http://page.invalid/${folder ? `${folder}/` : ''}`)
    const target = url.pathname.replace(/^\/+/, '')
    return target || null
  } catch {
    return null
  }
}

/**
 * The href text to write in place of one that resolved to the moved page, preserving whether the
 * original was root-relative (`/old/path`) or folder-relative (`sibling`, `../sibling`) -- a
 * root-relative original stays root-relative, and a folder-relative original is recomputed relative
 * to the SAME referencing folder, landing on an equivalent (if not byte-identical) relative
 * reference that still resolves correctly.
 */
function replacementHref(originalHref: string, folder: string, newPath: string): string {
  if (originalHref.startsWith('/')) {
    return `/${newPath}`
  }
  return path.posix.relative(folder, newPath)
}

export interface LinkRewriteResult {
  render: string
  content: string
}

/**
 * Rewrite every anchor in `render` (and, best-effort, the matching literal text in `content`) whose
 * resolved target is `oldPath`, to point at `newPath` instead.
 *
 * @param render The page's current stored render (sanitized HTML).
 * @param content The page's current raw source, in whatever format its editor uses.
 * @param pagePath This page's OWN path (its folder is the base every relative href on it resolves
 *                 against -- unaffected by the move unless this IS the moved page itself, in which
 *                 case the caller passes its NEW path, matching where its content now actually
 *                 lives).
 * @param oldPath The moved page's path before the move.
 * @param newPath The moved page's path after the move.
 * @returns The rewritten render/content, or null when nothing on this page referenced `oldPath` at
 *          all (a `listBacklinks` candidate whose `links` column is stale, or whose only reference
 *          was through something other than an `<a href>` — e.g. `relations`, out of scope here).
 */
export function rewriteInternalLinkReferences(
  render: string,
  content: string,
  pagePath: string,
  oldPath: string,
  newPath: string
): LinkRewriteResult | null {
  const folder = pagePath.split('/').slice(0, -1).join('/')
  const $ = cheerio.load(render ?? '', null, false)
  let changed = false
  let nextContent = content

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')?.trim()
    if (!href) {
      return
    }
    if (resolveInternalTarget(href, folder) !== oldPath) {
      return
    }
    const newHref = replacementHref(href, folder, newPath)
    $(el).attr('href', newHref)
    if (nextContent.includes(href)) {
      nextContent = nextContent.replaceAll(href, newHref)
    }
    changed = true
  })

  if (!changed) {
    return null
  }
  return { render: $.html(), content: nextContent }
}
