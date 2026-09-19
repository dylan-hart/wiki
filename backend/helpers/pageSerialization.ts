import { dump, load } from 'js-yaml'

/**
 * One extension per `pages.contentType` value (`EDITOR_CONTENT_TYPES` in `models/pages.ts`), without
 * the leading dot. The one such table in the backend: every file-backed storage target derives its
 * extension from here, so a new content type cannot reach one target and go missing from the next.
 */
export const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  markdown: 'md',
  asciidoc: 'adoc',
  html: 'html',
  text: 'txt',
  redirect: 'txt'
}

export const DEFAULT_CONTENT_TYPE_EXTENSION = 'txt'

export function fileExtensionForContentType(contentType: string): string {
  return CONTENT_TYPE_EXTENSIONS[contentType] ?? DEFAULT_CONTENT_TYPE_EXTENSION
}

export function extensionForContentType(contentType: string): string {
  return `.${fileExtensionForContentType(contentType)}`
}

export interface PageFrontMatterInput {
  title: string
  description?: string | null
  tags?: string[] | null
  createdAt?: Date | null
  updatedAt?: Date | null
}

/** Second precision: a human-authored front-matter header has no use for sub-second detail. */
function formatDate(date: Date): string {
  return date.toTemporalInstant().toString({ smallestUnit: 'second' })
}

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
  // -> `lineWidth: -1` stops js-yaml wrapping a long title or description onto a second line, which
  //    would silently corrupt the header.
  const header = dump(frontMatter, { lineWidth: -1 }).trimEnd()
  return `---\n${header}\n---\n\n${content ?? ''}`
}

export interface ParsedFrontMatter {
  title?: string
  description?: string
  tags?: string[]
  content: string
}

/**
 * The trailing `\r?\n+` rather than `\r?\n?` is deliberate: `injectFrontMatter` writes a blank line
 * between the closing `---` and the body, and a file with no blank separator is equally valid —
 * neither's newlines belong in the parsed content.
 */
const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n+([\s\S]*)$/

/**
 * The inverse of `injectFrontMatter`, for the markdown import path — the same header shape Hugo,
 * Jekyll and Obsidian write on export. `dateCreated`/`dateModified` are deliberately NOT read back:
 * an import creates a new page, whose `createdAt`/`updatedAt` belong to the database, not to a file.
 * A missing, invalid or non-object header passes the content through untouched — front matter is
 * detected when present, never required.
 */
export function parseFrontMatter(raw: string): ParsedFrontMatter {
  const match = FRONT_MATTER_PATTERN.exec(raw)
  if (!match) {
    return { content: raw }
  }

  let data: unknown
  try {
    // -> `maxAliases: 0` refuses any `*alias` outright (js-yaml's default is unlimited): this header
    //    is untrusted upload, and a legitimate title/description/tags block never needs anchors, so
    //    the "billion laughs" expansion gets no budget at all.
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
