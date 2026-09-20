import type { sites } from '../models/sites.ts'
import type { groups } from '../models/groups.ts'
import type { classificationLevels } from '../models/classificationLevels.ts'
import type { glossary } from '../models/glossary.ts'
import type { assetServing } from '../models/assetServing.ts'

/**
 * What must run once a whole-instance replication restore (`importSnapshot()`) has succeeded: the
 * wipe-and-replace leaves every in-memory cache of the replaced tables stale, and the search
 * reindex is queued rather than run inline. Every `importSnapshot()` caller runs this one function
 * so their side-effect lists cannot drift apart.
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
