/**
 * This target owns no external destination: page content and asset bytes already live in the
 * `pages`/`pageHistory`/`assets` tables, written there directly by `models/pages.ts` and
 * `models/assets.ts` rather than through a storage module. So the content-dispatch handlers have
 * nothing to do here and only `purge` is implemented.
 */
import { inArray } from 'drizzle-orm'
import { assets as assetsTable } from '../../../db/schema.ts'
import { DB_MODULE } from '../../../models/storage.ts'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'

/**
 * The per-asset gate is load-bearing, not an optimisation: `/_files/` can answer only by redirecting
 * to a direct-access target's own URL or by reading the db column this nulls, and `BlobDriver` has no
 * `get`/`head` to refill from — so purging an asset whose kind/size no direct-access target covers
 * would destroy its only copy. Metadata and the `tree` entry are left alone for every asset, which is
 * what the action's `definition.yml` hint promises.
 */
export async function purge(target: StorageTarget): Promise<{ purged: number; skipped: number }> {
  const siteAssets = await CARDINAL.models.assets.listAllForSite(target.siteId)
  if (siteAssets.length < 1) {
    return { purged: 0, skipped: 0 }
  }

  const targets = await CARDINAL.models.storage.getSiteTargets(target.siteId)
  const purgeableIds: string[] = []
  let skipped = 0
  for (const asset of siteAssets) {
    const governingTarget = CARDINAL.models.assetServing.governingTargetFrom(targets, {
      kind: asset.kind,
      fileSize: asset.fileSize
    })
    if (governingTarget && governingTarget.module !== DB_MODULE) {
      purgeableIds.push(asset.id)
    } else {
      skipped++
    }
  }

  if (purgeableIds.length < 1) {
    return { purged: 0, skipped }
  }

  await CARDINAL.db
    .update(assetsTable)
    .set({ data: null, preview: null })
    .where(inArray(assetsTable.id, purgeableIds))

  await CARDINAL.models.assetServing.dropCachedContent(purgeableIds)
  // -> `hasPreview` changes for every purged asset at once; a bulk change has no single cached path
  //    to invalidate individually.
  CARDINAL.models.assetServing.forgetAllPaths()

  return { purged: purgeableIds.length, skipped }
}

const dbStorageModule: StorageModule = {
  purge
}

export default dbStorageModule
