import type { sites } from '../models/sites.ts'
import type { groups } from '../models/groups.ts'
import type { classificationLevels } from '../models/classificationLevels.ts'
import type { glossary } from '../models/glossary.ts'
import type { assetServing } from '../models/assetServing.ts'

/**
 * Everything a whole-instance replication restore (`models/replicationImport.ts#importSnapshot()`)
 * needs run against it once it has actually succeeded (OpenProject #2517): every `ClusterReloaded`
 * cache a wipe-and-replace just invalidated wholesale (`sites`, `groups`, `classificationLevels`),
 * the glossary term cache and the asset path-resolution cache, plus a queued -- not inline -- full
 * search reindex per restored site.
 *
 * There are two callers of `importSnapshot()`: the manual-upload path
 * (`tasks/simple/replication-import.ts`) and the scheduled cron-driven pull
 * (`models/replication.ts#pull()`). Both call this same function rather than each keeping its own
 * copy of the side-effect list, which is exactly what let the two drift apart in the first place —
 * `pull()` shipped with no post-import step at all until this WP.
 *
 * All five model types are `import type`-only, so this file carries no runtime dependency on any of
 * them -- a caller hands over whichever concrete (or stubbed, in a test) instances it already has.
 */
export interface ReplicationPostImportDeps {
  sites: Pick<typeof sites, 'broadcastReload' | 'getAllSites'>
  groups: Pick<typeof groups, 'broadcastReload'>
  classificationLevels: Pick<typeof classificationLevels, 'broadcastReload'>
  glossary: Pick<typeof glossary, 'invalidateCache'>
  assetServing: Pick<typeof assetServing, 'forgetAllPaths'>
  addJob: (opts: {
    task: string
    payload: Record<string, any>
  }) => Promise<{ id?: string } | undefined>
}

export async function runReplicationPostImport(deps: ReplicationPostImportDeps): Promise<void> {
  await deps.sites.broadcastReload()
  await deps.groups.broadcastReload()
  await deps.classificationLevels.broadcastReload()
  deps.assetServing.forgetAllPaths()

  const restoredSites = await deps.sites.getAllSites()
  for (const site of restoredSites) {
    deps.glossary.invalidateCache(site.id)
    await deps.addJob({ task: 'rebuildSearchIndex', payload: { siteId: site.id } })
  }
}
