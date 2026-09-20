/**
 * This target owns no external destination: page content and asset bytes already live in the
 * `pages`/`pageHistory`/`assets` tables, written there directly by `models/pages.ts` and
 * `models/assets.ts` rather than through a storage module. So the content-dispatch handlers have
 * nothing to do here and only `purge` is implemented.
 */
import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { assets as assetsTable } from '../../../db/schema.ts'
import { belongsInTarget } from '../../../helpers/blobTarget.ts'
import { DB_MODULE } from '../../../models/storage.ts'
import type { AssetKind } from '../../../models/assets.ts'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'

type PurgeAsset = {
  id: string
  kind: AssetKind
  folderPath: string
  fileName: string
  fileSize: number
}

function copyCandidates(targets: StorageTarget[], asset: PurgeAsset): StorageTarget[] {
  const candidates: StorageTarget[] = []
  const governing = CARDINAL.models.assetServing.governingTargetFrom(targets, asset)
  if (governing && governing.module !== DB_MODULE) {
    candidates.push(governing)
  }
  for (const t of targets) {
    if (
      t.isEnabled &&
      t.module !== DB_MODULE &&
      t.assetDelivery.isReadThroughSupported &&
      t.assetDelivery.readThrough &&
      belongsInTarget(asset, t.contentTypes) &&
      !candidates.includes(t)
    ) {
      candidates.push(t)
    }
  }
  return candidates
}

export async function verifyCopy(
  target: StorageTarget,
  asset: PurgeAsset,
  data: Buffer,
  digest: Buffer
): Promise<boolean> {
  let body: (AsyncIterable<Buffer | string> & { destroy?: () => void }) | undefined
  try {
    const mod = await CARDINAL.models.storage.ensureModule(target.module)
    if (typeof mod?.headAsset !== 'function' || typeof mod?.readAsset !== 'function') {
      return false
    }

    const head = await mod.headAsset(asset, target)
    if (!head || head.size !== asset.fileSize || head.size !== data.length) {
      return false
    }

    const read = await mod.readAsset(asset, target)
    if (!read) {
      return false
    }
    body = read.body
    const hash = createHash('sha256')
    let received = 0
    for await (const chunk of read.body) {
      received += chunk.length
      if (received > data.length) {
        return false
      }
      hash.update(chunk)
    }
    return received === data.length && hash.digest().equals(digest)
  } catch (err: any) {
    CARDINAL.logger.warn('storage', 'verifying an asset copy before purging failed', {
      target: target.id,
      module: target.module,
      asset: asset.id,
      error: err
    })
    return false
  } finally {
    body?.destroy?.()
  }
}

/**
 * The per-asset gate is load-bearing, not an optimisation: `/_files/` can answer only by redirecting
 * to a direct-access target's own URL or by reading the db column this nulls, and `BlobDriver` has no
 * `get`/`head` to refill from — so purging an asset whose kind/size no direct-access target covers
 * would destroy its only copy. Metadata and the `tree` entry are left alone for every asset, which is
 * what the action's `definition.yml` hint promises.
 */
export async function purge(
  target: StorageTarget
): Promise<{ purged: number; skipped: number; unverified: number }> {
  const siteAssets = await CARDINAL.models.assets.listAllForSite(target.siteId)
  if (siteAssets.length < 1) {
    return { purged: 0, skipped: 0, unverified: 0 }
  }

  const targets = await CARDINAL.models.storage.getSiteTargets(target.siteId)
  const purgedIds: string[] = []
  let skipped = 0
  let unverified = 0

  for (const asset of siteAssets) {
    const candidates = copyCandidates(targets, asset)
    if (candidates.length < 1) {
      skipped++
      continue
    }

    const [row] = await CARDINAL.db
      .select({ data: assetsTable.data })
      .from(assetsTable)
      .where(eq(assetsTable.id, asset.id))
      .limit(1)
    if (!row?.data) {
      skipped++
      continue
    }

    const digest = createHash('sha256').update(row.data).digest()
    let verified = false
    for (const candidate of candidates) {
      if (await verifyCopy(candidate, asset, row.data, digest)) {
        verified = true
        break
      }
    }
    if (!verified) {
      unverified++
      continue
    }

    const nulled = await CARDINAL.db
      .update(assetsTable)
      .set({ data: null, preview: null })
      .where(
        and(
          eq(assetsTable.id, asset.id),
          sql`sha256(${assetsTable.data}) = decode(${digest.toString('hex')}, 'hex')`
        )
      )
      .returning({ id: assetsTable.id })
    if (nulled.length > 0) {
      purgedIds.push(asset.id)
    } else {
      unverified++
    }
  }

  if (purgedIds.length > 0) {
    await CARDINAL.models.assetServing.dropCachedContent(purgedIds)
    // -> `hasPreview` changes for every purged asset at once; a bulk change has no single cached path
    //    to invalidate individually.
    CARDINAL.models.assetServing.forgetAllPaths()
  }

  return { purged: purgedIds.length, skipped, unverified }
}

const dbStorageModule: StorageModule = {
  purge
}

export default dbStorageModule
