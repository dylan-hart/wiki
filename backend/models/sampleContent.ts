import { and, eq, sql } from 'drizzle-orm'
import { pages as pagesTable } from '../db/schema.ts'
import { CustomError, escapeLikePattern } from '../helpers/common.ts'
import { WELCOME_SAMPLE_PAGES } from '../helpers/sampleContentPages.ts'
import type { PageActor } from './pages.ts'

export const SAMPLE_CONTENT_TAG = 'cardinal-sample-content'
export const SAMPLE_CONTENT_PATH_PREFIX = 'welcome/'
export const SAMPLE_CONTENT_ALREADY_GENERATED = 'sampleContentAlreadyGenerated'

export interface SamplePage {
  path: string
  title: string
  tags: string[]
  content: string
}

export interface SampleContentGenerateResult {
  created: number
  paths: string[]
}

export interface SampleContentPurgeResult {
  found: number
  deleted: number
}

export const SAMPLE_PAGES: SamplePage[] = WELCOME_SAMPLE_PAGES

function markedPagesWhere(siteId: string) {
  return and(
    eq(pagesTable.siteId, siteId),
    sql`${pagesTable.tags} @> ARRAY[${SAMPLE_CONTENT_TAG}]::text[]`,
    sql`${pagesTable.path} LIKE ${escapeLikePattern(SAMPLE_CONTENT_PATH_PREFIX) + '%'}`
  )
}

async function findMarkedPages(siteId: string) {
  return CARDINAL.db
    .select({ id: pagesTable.id, path: pagesTable.path })
    .from(pagesTable)
    .where(markedPagesWhere(siteId))
}

export function isSampleContentAlreadyGenerated(err: unknown): boolean {
  return err instanceof Error && err.name === SAMPLE_CONTENT_ALREADY_GENERATED
}

export async function generate(
  siteId: string,
  actor: PageActor
): Promise<SampleContentGenerateResult> {
  for (const sample of SAMPLE_PAGES) {
    if (!sample.path.startsWith(SAMPLE_CONTENT_PATH_PREFIX)) {
      throw new Error(
        `Sample page "${sample.path}" is outside the reserved "${SAMPLE_CONTENT_PATH_PREFIX}" prefix.`
      )
    }
  }

  const existing = await findMarkedPages(siteId)
  if (existing.length > 0) {
    throw new CustomError(
      SAMPLE_CONTENT_ALREADY_GENERATED,
      'Sample content has already been generated for this site. Purge it before generating again.',
      409
    )
  }

  const paths: string[] = []
  for (const sample of SAMPLE_PAGES) {
    const page = await CARDINAL.models.pages.createPage(
      siteId,
      {
        path: sample.path,
        title: sample.title,
        editor: 'markdown',
        content: sample.content,
        tags: [...new Set([...sample.tags, SAMPLE_CONTENT_TAG])]
      },
      actor
    )
    paths.push(page.path)
  }

  CARDINAL.logger.info('pages', 'sample content generated', {
    site: siteId,
    created: paths.length,
    user: actor.id
  })
  return { created: paths.length, paths }
}

export async function purge(siteId: string, actor: PageActor): Promise<SampleContentPurgeResult> {
  const candidates = await findMarkedPages(siteId)

  let deleted = 0
  for (const candidate of candidates) {
    if (await CARDINAL.models.pages.deletePage(siteId, candidate.id, actor)) {
      deleted++
    }
  }

  CARDINAL.logger.info('pages', 'sample content purged', {
    site: siteId,
    found: candidates.length,
    deleted,
    user: actor.id
  })
  return { found: candidates.length, deleted }
}
