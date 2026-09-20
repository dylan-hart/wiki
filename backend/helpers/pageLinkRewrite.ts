/**
 * Move-time link rewrite: given a page already known to reference `oldPath` (`pages.links`/
 * `pages.relations`), rewrite that reference to `newPath` in place rather than re-deriving the link
 * set.
 *
 * Only the markdown `](path)` and HTML `href="path"` spellings are covered. A source syntax with
 * neither (asciidoc's `link:path[]`) keeps the old path in its raw source until next edited; its
 * `render`, always HTML, is still fixed.
 */

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface RewriteResult {
  text: string
  changed: boolean
}

/**
 * Rewrite every `](oldPath)` / `href="oldPath"` occurrence to `newPath`, leaving a `#fragment` or
 * `?query` after the path untouched. The path must be followed by a hard delimiter, so moving
 * `docs/foo` never touches a link to `docs/foobar`.
 *
 * An empty `oldPath` (the home page) is refused: it would match every bare `]()` and `href=""`.
 *
 * `activeLocales` lets the `href=` branch match, and preserve, a leading locale segment
 * (`href="/fr/docs/old"`): `LinkPickerDialog.vue` writes one, and `extractInternalLinks` strips it
 * before storing `oldPath` bare. The markdown `](` branch does not, so a locale-prefixed markdown
 * link is left unrewritten.
 */
export function rewriteLinkText(
  text: string,
  oldPath: string,
  newPath: string,
  activeLocales: string[] = []
): RewriteResult {
  if (!text || !oldPath || oldPath === newPath) {
    return { text, changed: false }
  }
  const escaped = escapeRegExp(oldPath)
  const localePrefix =
    activeLocales.length > 0 ? `(?:(?:${activeLocales.map(escapeRegExp).join('|')})/)?` : ''
  const pattern = new RegExp(
    `(\\]\\(\\s*/?|href=(?:"|')\\s*/?${localePrefix})${escaped}(?=[)"'#?\\s]|$)`,
    'g'
  )
  let changed = false
  const rewritten = text.replaceAll(pattern, (_match, prefix: string) => {
    changed = true
    return `${prefix}${newPath}`
  })
  return changed ? { text: rewritten, changed: true } : { text, changed: false }
}

/**
 * Rewrite a `redirect`-editor page's stored target (`models/pages.ts#RedirectContent`) when it
 * points at `oldPath`. A page-kind target is a rooted path (`/oldPath`), not the bare `pages.path`
 * form `links`/`relations` use, so the comparison and replacement both add the leading slash back.
 * Unparseable or `url`-kind content is left untouched.
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
