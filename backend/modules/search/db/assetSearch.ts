import { sql } from 'drizzle-orm'
import { decodeTreePath } from '../../../helpers/common.ts'
import { mayActorOnAsset } from '../../../helpers/pageAccess.ts'
import { HL_START, HL_STOP, normalizeMarkers } from '../shared.ts'
import { OVERFETCH_GROWTH_FACTOR, OVERFETCH_HARD_CAP, OVERFETCH_MARGIN } from './search.ts'
import type { AccessActor } from '../../../models/groups.ts'

export interface SearchAssetsParams {
  siteId: string
  query: string
  actor: AccessActor
  offset?: number
  limit?: number
}

export interface AssetSearchHit {
  id: string
  fileName: string
  fileExt: string
  kind: 'document' | 'image' | 'other'
  mimeType: string
  fileSize: number
  folderPath: string
  title: string
  locale: string
  hasPreview: boolean
  createdAt: string
  updatedAt: string
  relevancy: number
  highlight: string | null
}

export interface SearchAssetsResult {
  results: AssetSearchHit[]
  totalHits: number
  totalHitsApproximate: boolean
}

function emptyResult(): SearchAssetsResult {
  return { results: [], totalHits: 0, totalHitsApproximate: false }
}

export async function searchAssets({
  siteId,
  query,
  actor,
  offset = 0,
  limit = 25
}: SearchAssetsParams): Promise<SearchAssetsResult> {
  const terms = query.trim()
  if (!terms) {
    return emptyResult()
  }
  if (!CARDINAL.models.groups.mayHoldPermissionSomewhere(actor, ['read:assets'], siteId)) {
    return emptyResult()
  }

  const tsQuery = sql`websearch_to_tsquery('simple', ${terms})`
  const rowsQuery = (queryLimit: number) => sql`
    SELECT
      a.id,
      a."fileName",
      a."fileExt",
      a.kind,
      a."mimeType",
      a."fileSize",
      t."folderPath",
      t.title,
      t.locale,
      (a.preview IS NOT NULL) AS "hasPreview",
      to_char(a."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
      to_char(a."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
      ts_rank(a.ts, ${tsQuery}) AS relevancy,
      ts_headline('simple', coalesce(a."searchContent", ''), ${tsQuery},
        ${`StartSel=${HL_START},StopSel=${HL_STOP},MaxWords=25,MinWords=10,MaxFragments=1`}) AS highlight
    FROM assets a
    INNER JOIN tree t ON t.id = a.id
    WHERE a."siteId" = ${siteId} AND a.ts @@ ${tsQuery}
    ORDER BY relevancy DESC, a."updatedAt" DESC, a.id
    LIMIT ${queryLimit}
  `

  const folderOf = (row: any) => decodeTreePath((row.folderPath as string | null) ?? '') ?? ''

  const needed = offset + limit
  let candidateLimit = Math.min(needed + OVERFETCH_MARGIN, OVERFETCH_HARD_CAP)
  let rawRows: any[]
  let visibleRows: any[]
  for (;;) {
    const fetched = await CARDINAL.db.execute(rowsQuery(candidateLimit))
    rawRows = fetched.rows as any[]
    visibleRows = rawRows.filter((row) =>
      mayActorOnAsset(actor, 'read:assets', siteId, {
        folderPath: folderOf(row),
        fileName: row.fileName as string,
        locale: row.locale as string
      })
    )
    const exhausted = rawRows.length < candidateLimit
    if (visibleRows.length >= needed || exhausted || candidateLimit >= OVERFETCH_HARD_CAP) {
      break
    }
    candidateLimit = Math.min(candidateLimit * OVERFETCH_GROWTH_FACTOR, OVERFETCH_HARD_CAP)
  }

  return {
    results: visibleRows.slice(offset, offset + limit).map((row) => ({
      id: row.id as string,
      fileName: row.fileName as string,
      fileExt: row.fileExt as string,
      kind: row.kind,
      mimeType: row.mimeType as string,
      fileSize: Number(row.fileSize ?? 0),
      folderPath: folderOf(row),
      title: row.title as string,
      locale: row.locale as string,
      hasPreview: Boolean(row.hasPreview),
      createdAt: row.createdAt as string,
      updatedAt: row.updatedAt as string,
      relevancy: Number(row.relevancy ?? 0),
      highlight: normalizeMarkers(row.highlight as string | null)
    })),
    totalHits: visibleRows.length,
    totalHitsApproximate: rawRows.length !== visibleRows.length
  }
}
