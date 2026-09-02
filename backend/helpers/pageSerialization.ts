import { dump, load } from 'js-yaml'

/**
 * Turning a database page row into a file on a filesystem-like storage target.
 *
 * Shared by every target that lays pages out as files rather than keeping them in a blob store —
 * `modules/storage/sftp/` today, `modules/storage/git/` once it lands (Feature 372). Both need the
 * same two things: which extension a page's `contentType` gets written with, and how to prepend its
 * metadata as a front-matter header before the body. Build this once here rather than duplicating it
 * per target.
 */

/**
 * File extension for each value `pages.contentType` can hold (`EDITOR_CONTENT_TYPES` in
 * `models/pages.ts`), without its leading dot. `text` and `redirect` have no dedicated markup of their
 * own, so both fall back to plain text.
 *
 * The one such table in the backend: `models/storage.ts`'s `getFileExtension`, `modules/storage/git`'s
 * extension probe and `modules/storage/disk`'s dump map are all derived from it (disk overriding
 * `redirect` — see there), so a new page content type cannot land in one file-backed target and go
 * missing from the next.
 */
export const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  markdown: 'md',
  asciidoc: 'adoc',
  html: 'html',
  text: 'txt',
  redirect: 'txt'
}

/** Used for a `contentType` the map above doesn't recognize, so a file always gets written. */
export const DEFAULT_CONTENT_TYPE_EXTENSION = 'txt'

/** The bare file extension (no leading dot) a page's `contentType` is written under. */
export function fileExtensionForContentType(contentType: string): string {
  return CONTENT_TYPE_EXTENSIONS[contentType] ?? DEFAULT_CONTENT_TYPE_EXTENSION
}

/**
 * The file extension a page's content should be written with, based on its `contentType` — dotted, as
 * a file name needs it.
 */
export function extensionForContentType(contentType: string): string {
  return `.${fileExtensionForContentType(contentType)}`
}

/** The subset of a page row that goes into its front-matter header. */
export interface PageFrontMatterInput {
  title: string
  description?: string | null
  tags?: string[] | null
  createdAt?: Date | null
  updatedAt?: Date | null
}

/**
 * An instant, formatted the way a front-matter header reads it back: second precision is plenty for
 * a human-authored file, and matches the `smallestUnit` this codebase already truncates to when a
 * `Temporal.Instant` is turned into a string (see the `Temporal` note in CLAUDE.md).
 */
function formatDate(date: Date): string {
  return date.toTemporalInstant().toString({ smallestUnit: 'second' })
}

/**
 * Prepend a YAML front-matter header carrying the page's metadata onto its content.
 *
 * Fields that are empty or absent are left out of the header rather than written as blank/null —
 * `description`, `tags`, `createdAt` and `updatedAt` are all optional on a page. `title` is the only
 * field always present, since every page has one.
 */
export function injectFrontMatter(
  content: string | null | undefined,
  page: PageFrontMatterInput
): string {
  const frontMatter: Record<string, unknown> = {
    title: page.title
  }
  if (page.description) {
    frontMatter.description = page.description
  }
  if (page.tags && page.tags.length > 0) {
    frontMatter.tags = page.tags
  }
  if (page.createdAt) {
    frontMatter.dateCreated = formatDate(page.createdAt)
  }
  if (page.updatedAt) {
    frontMatter.dateModified = formatDate(page.updatedAt)
  }
  // -> `lineWidth: -1` stops js-yaml from wrapping a long title/description onto a second line, which
  //    would otherwise silently corrupt the header for anything past ~80 characters.
  const header = dump(frontMatter, { lineWidth: -1 }).trimEnd()
  return `---\n${header}\n---\n\n${content ?? ''}`
}

/** What `parseFrontMatter` pulls back out of a leading YAML header, plus the body left behind. */
export interface ParsedFrontMatter {
  title?: string
  description?: string
  tags?: string[]
  content: string
}

/**
 * Matches a leading `---\n...\n---\n` block, capturing the header and everything after it. The
 * trailing `\r?\n+` (one or more) rather than `\r?\n?` (at most one) is deliberate: `injectFrontMatter`
 * itself writes a blank line between the closing `---` and the body (`---\n\n${content}`), and a file
 * with no blank separator there is just as valid — either way, none of those newlines belong in the
 * parsed `content`.
 */
const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n+([\s\S]*)$/

/**
 * The inverse of `injectFrontMatter`: pull `title`/`description`/`tags` back out of a file's leading
 * YAML front-matter block, for the markdown import path (OpenProject #1092) where the bytes ARE
 * already a page's content and the only "conversion" left is separating metadata from body — the same
 * shape Hugo, Jekyll and Obsidian all write on export.
 *
 * Only `title`/`description`/`tags` are read back — `dateCreated`/`dateModified` are informational on
 * the way out (`injectFrontMatter` writes them from an existing page row) but an import is creating a
 * brand new page, whose `createdAt`/`updatedAt` are for the database to set, not a file to dictate.
 *
 * A file with no leading `---` block, or one whose header isn't valid YAML or isn't a plain object, is
 * passed through with its content untouched — front matter is an enhancement to detect when present,
 * not a requirement imported markdown must satisfy.
 */
export function parseFrontMatter(raw: string): ParsedFrontMatter {
  const match = FRONT_MATTER_PATTERN.exec(raw)
  if (!match) {
    return { content: raw }
  }

  let data: unknown
  try {
    // -> `maxAliases: 0` (js-yaml's default is -1, unlimited) refuses any `*alias` reference outright
    //    rather than merely capping it: this header is user-uploaded, untrusted content, and a
    //    legitimate title/description/tags block never needs YAML anchors/aliases at all, so there is
    //    no reason to allow the "billion laughs" shape (a handful of nested anchors expanding to
    //    millions of elements) any budget to begin with.
    data = load(match[1], { maxAliases: 0 })
  } catch {
    return { content: raw }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { content: raw }
  }

  const header = data as Record<string, unknown>
  const result: ParsedFrontMatter = { content: match[2] }
  if (typeof header.title === 'string' && header.title.trim()) {
    result.title = header.title
  }
  if (typeof header.description === 'string' && header.description.trim()) {
    result.description = header.description
  }
  if (Array.isArray(header.tags)) {
    const tags = header.tags.filter((tag): tag is string => typeof tag === 'string')
    if (tags.length > 0) {
      result.tags = tags
    }
  }
  return result
}
