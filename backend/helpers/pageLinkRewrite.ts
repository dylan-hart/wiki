/**
 * Move-time link rewrite (OpenProject #2452).
 *
 * `models/rendering.ts#extractInternalLinks` already tells us, per page, which stored `content`/
 * `render` blob contains a link resolving to a given target path — that is `pages.links`/
 * `pages.relations` (see `db/schema.ts`), read by `models/pages.ts#relinkReferencingPages`. What
 * this module adds is the other half: given a page ALREADY KNOWN to reference `oldPath`, rewrite
 * that reference to `newPath` in place, without re-deriving the link set from scratch the way
 * `extractInternalLinks` does. Two shapes are handled:
 *
 *  - `rewriteLinkText`: the two link syntaxes this app's own editors and sanitizer ever produce —
 *    a markdown destination (`](path)`) and an HTML `href="path"` attribute (what `content` holds
 *    for the `wysiwyg`/`code` editors, and what `render` always holds regardless of source editor,
 *    since it is sanitized HTML by the time `models/rendering.ts#postProcess` is done with it).
 *    Applied to both `content` and `render` unconditionally rather than branching on editor/content
 *    type — a pattern that finds nothing just matches nothing, and a markdown body that embeds a
 *    raw inline `<a href>` (allowed by the sanitizer) gets that occurrence fixed too. A source
 *    syntax with no `](`/`href="` spelling of a link (asciidoc's `link:path[]`, for one) is not
 *    covered by this pass — the page's `render` still gets fixed, since that is always plain HTML
 *    by the time it is stored, but the raw source will still read the old path until next edited.
 *  - `rewriteRedirectTarget`: a `redirect`-editor page's own `content` is a JSON blob naming where
 *    it sends a reader (`models/pages.ts#RedirectContent`) — a page redirect target is exactly as
 *    much an internal link as a body one, and it 404s hard (not merely "the wrong place") once the
 *    page it names moves out from under it.
 */

/** Escape a literal string for embedding in a `RegExp` source. */
function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface RewriteResult {
  text: string
  changed: boolean
}

/**
 * Rewrite every `](oldPath)` / `href="oldPath"` (single or double quoted, with or without a leading
 * `/`) occurrence of `oldPath` in `text` to `newPath`, leaving anything after the path itself —
 * a `#fragment`, a `?query`, the closing delimiter — untouched.
 *
 * Bounded to the two link-opening markers this codebase's editors and sanitizer ever emit
 * (see the module doc comment), each followed by a hard delimiter (`)`, a quote, `#`, `?`,
 * whitespace, or end of string) — so moving `docs/foo` never touches a link to `docs/foobar`.
 *
 * `oldPath` empty (the home page — `pages.path` is `''` for it) is refused rather than matched:
 * `extractInternalLinks` never records a link to the home page in the first place (an empty
 * resolved target fails its own truthiness guard), so there is never a real occurrence to find, and
 * an empty `oldPath` would otherwise turn this into "match every empty link opener" — every bare
 * `]()` and `href=""` in the text, which is not what a mover of the home page's page (kept at some
 * other path) would want touched.
 */
export function rewriteLinkText(text: string, oldPath: string, newPath: string): RewriteResult {
  if (!text || !oldPath || oldPath === newPath) {
    return { text, changed: false }
  }
  const escaped = escapeRegExp(oldPath)
  const pattern = new RegExp(`(\\]\\(\\s*/?|href=(?:"|')\\s*/?)${escaped}(?=[)"'#?\\s]|$)`, 'g')
  let changed = false
  const rewritten = text.replaceAll(pattern, (_match, prefix: string) => {
    changed = true
    return `${prefix}${newPath}`
  })
  return changed ? { text: rewritten, changed: true } : { text, changed: false }
}

/**
 * Rewrite a `redirect`-editor page's stored target (`models/pages.ts#RedirectContent`) when it
 * points at `oldPath`, exactly as `normalizeRedirectContent` re-serializes it — a page-kind target
 * is always a rooted path (`/oldPath`, never the bare `pages.path` form `links`/`relations` use), so
 * the comparison and replacement both add the leading slash back.
 *
 * Malformed content (fails to parse, or is a `url`-kind redirect) is left untouched — this is not
 * `normalizeRedirectContent`'s validator, only its targeted-replacement counterpart.
 */
export function rewriteRedirectTarget(
  content: string,
  oldPath: string,
  newPath: string
): RewriteResult {
  if (!oldPath || oldPath === newPath) {
    return { text: content, changed: false }
  }
  let parsed: any
  try {
    parsed = JSON.parse(content)
  } catch {
    return { text: content, changed: false }
  }
  if (parsed?.kind !== 'page' || parsed?.target !== `/${oldPath}`) {
    return { text: content, changed: false }
  }
  return { text: JSON.stringify({ ...parsed, target: `/${newPath}` }), changed: true }
}
