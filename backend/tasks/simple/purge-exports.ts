import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Sweep `<dataPath>/exports/` of tarballs nobody came back to download.
 *
 * A successful download deletes its own file (see `GET /_api/system/export/:jobId/download`), so this
 * only ever finds the ones that were queued and abandoned — still cheap to run daily.
 */
export async function task(): Promise<TaskResult | void> {
  const count = await WIKI.models.export.purgeExpired()
  if (count > 0) {
    return { summary: 'purged expired content exports', purged: count }
  }
}
