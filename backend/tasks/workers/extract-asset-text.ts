import { eq, sql } from 'drizzle-orm'
import { assets as assetsTable, jobs as jobsTable } from '../../db/schema.ts'
import { extractPdfText, storeAssetText } from '../../helpers/assetText.ts'

export async function extractAssetText(assetId: string): Promise<void> {
  const rows = await CARDINAL.db
    .select({
      data: assetsTable.data,
      fileExt: assetsTable.fileExt,
      mimeType: assetsTable.mimeType,
      updatedAt: sql<string>`${assetsTable.updatedAt}::text`
    })
    .from(assetsTable)
    .where(eq(assetsTable.id, assetId))
    .limit(1)
  const row = rows[0]
  if (!row?.data) {
    return
  }
  if (row.fileExt !== 'pdf' && row.mimeType !== 'application/pdf') {
    return
  }

  const result = await extractPdfText(row.data)
  if (result.outcome === 'failed' || result.outcome === 'skipped') {
    CARDINAL.logger.warn('worker', 'asset text extraction did not complete', {
      asset: assetId,
      outcome: result.outcome,
      reason: result.reason
    })
    return
  }

  const stored = await storeAssetText(CARDINAL.db, assetId, row.updatedAt, result.text)
  if (!stored) {
    CARDINAL.logger.debug('worker', 'asset changed during text extraction, result discarded', {
      asset: assetId
    })
    return
  }

  CARDINAL.logger.debug('worker', 'extracted asset text', {
    asset: assetId,
    chars: result.text.length,
    truncated: result.truncated,
    outcome: result.outcome
  })

  if (result.outcome === 'ok' && CARDINAL.capabilities?.semanticSearch) {
    await CARDINAL.db.insert(jobsTable).values({
      id: crypto.randomUUID(),
      task: 'embedAsset',
      useWorker: true,
      payload: { assetId },
      maxRetries: CARDINAL.config.scheduler.maxRetries,
      createdBy: CARDINAL.INSTANCE_ID
    })
  }
}

export async function task(job: { payload: { assetId: string } }): Promise<void> {
  await CARDINAL.ensureDb!()
  await extractAssetText(job.payload.assetId)
}
