import { eq } from 'drizzle-orm'
import { assets as assetsTable } from '../../db/schema.ts'
import { extractPdfText, queueAssetJob, storeAssetText } from '../../helpers/assetText.ts'
import { ocrAvailable } from '../../helpers/ocr.ts'

export async function extractAssetText(assetId: string): Promise<void> {
  const rows = await CARDINAL.db
    .select({
      data: assetsTable.data,
      fileExt: assetsTable.fileExt,
      mimeType: assetsTable.mimeType
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

  const stored = await storeAssetText(CARDINAL.db, assetId, row.data, result.text)
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
    await queueAssetJob('embedAsset', assetId)
  }

  if (result.outcome === 'empty' && (await ocrAvailable('pdf'))) {
    await queueAssetJob('ocrAsset', assetId)
  }
}

export async function task(job: { payload: { assetId: string } }): Promise<void> {
  await CARDINAL.ensureDb!()
  await extractAssetText(job.payload.assetId)
}
