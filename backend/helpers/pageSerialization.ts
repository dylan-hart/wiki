import { dump } from 'js-yaml'

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
 * `models/pages.ts`). `text` and `redirect` have no dedicated markup of their own, so both fall back
 * to plain text.
 */
export const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  markdown: '.md',
  asciidoc: '.adoc',
  html: '.html',
  text: '.txt',
  redirect: '.txt'
}

/** Used for a `contentType` the map above doesn't recognize, so a file always gets written. */
const DEFAULT_EXTENSION = '.txt'

/**
 * The file extension a page's content should be written with, based on its `contentType`.
 */
export function extensionForContentType(contentType: string): string {
  return CONTENT_TYPE_EXTENSIONS[contentType] ?? DEFAULT_EXTENSION
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
