import { eq } from 'drizzle-orm'
import { assets as assetsTable } from '../../db/schema.ts'
import { queueAssetJob, storeAssetText } from '../../helpers/assetText.ts'
import { ocrBytes, ocrKindOf } from '../../helpers/ocr.ts'

export async function ocrAsset(assetId: string): Promise<void> {
  const rows = await CARDINAL.db
    .select({
      data: assetsTable.data,
      fileExt: assetsTable.fileExt,
      mimeType: assetsTable.mimeType,
      searchContent: assetsTable.searchContent
    })
    .from(assetsTable)
    .where(eq(assetsTable.id, assetId))
    .limit(1)
  const row = rows[0]
  if (!row?.data) {
    return
  }
  const kind = ocrKindOf(row.fileExt, row.mimeType)
  if (!kind) {
    return
  }
  if (kind === 'pdf' && row.searchContent) {
    return
  }

  const result = await ocrBytes(kind, row.data)
  if (result.outcome === 'skipped') {
    CARDINAL.logger.debug('worker', 'asset OCR skipped', {
      asset: assetId,
      reason: result.reason
    })
    return
  }
  if (result.outcome === 'failed') {
    CARDINAL.logger.warn('worker', 'asset OCR did not complete', {
      asset: assetId,
      reason: result.reason
    })
    return
  }

  const stored = await storeAssetText(CARDINAL.db, assetId, row.data, result.text)
  if (!stored) {
    CARDINAL.logger.debug('worker', 'asset changed during OCR, result discarded', {
      asset: assetId
    })
    return
  }

  CARDINAL.logger.debug('worker', 'recognized asset text', {
    asset: assetId,
    chars: result.text.length,
    truncated: result.truncated,
    outcome: result.outcome
  })

  if (result.outcome === 'ok' && CARDINAL.capabilities?.semanticSearch) {
    await queueAssetJob('embedAsset', assetId)
  }
}

export async function task(job: { payload: { assetId: string } }): Promise<void> {
  await CARDINAL.ensureDb!()
  await ocrAsset(job.payload.assetId)
}
