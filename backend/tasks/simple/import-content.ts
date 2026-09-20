import { importModel as siteImport } from '../../models/siteImport.ts'
import { groups } from '../../models/groups.ts'
import { glossary } from '../../models/glossary.ts'
import { assetServing } from '../../models/assetServing.ts'
import { jobs } from '../../models/jobs.ts'
import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Queued from `POST /_api/system/import` rather than run inline: reading a whole archive back apart
 * and restoring it inside a transaction is not something a request thread should be blocked on. The
 * uploaded file is a working file rather than a downloadable product, so it is deleted once this
 * task is done with it, success or failure alike.
 *
 * `siteImport.importSite` writes `pages`/`tree`/`assets`/`groups` straight against the database, so
 * none of the ordinary post-write cache and index hooks fire on their own — running them is what the
 * rest of this task is for. The asset path cache is dropped wholesale because a bulk replacement is
 * not enumerable path-by-path the way a single move is, and the search-index rebuild is queued rather
 * than run inline so this job's runtime stays bounded to the restore itself.
 */
export async function task(
  payload: { filePath: string; targetSiteId: string; importedById: string } = {
    filePath: '',
    targetSiteId: '',
    importedById: ''
  },
  jobId?: string,
  deps: {
    siteImport?: typeof siteImport
    groups?: typeof groups
    glossary?: typeof glossary
    assetServing?: typeof assetServing
    jobs?: typeof jobs
    addJob?: typeof CARDINAL.scheduler.addJob
  } = {}
): Promise<TaskResult> {
  const {
    siteImport: siteImportDep = siteImport,
    groups: groupsDep = groups,
    glossary: glossaryDep = glossary,
    assetServing: assetServingDep = assetServing,
    jobs: jobsDep = jobs,
    addJob = (opts) => CARDINAL.scheduler.addJob(opts)
  } = deps

  // -> Announced at `debug` because a whole site's restore can take minutes. The `try` exists only
  //    for the `finally` that deletes the upload; a failure propagates, and the scheduler writes the
  //    one record for it.
  CARDINAL.logger.debug('pages', 'importing site content', { site: payload.targetSiteId })
  try {
    const result = await siteImportDep.importSite(
      payload.filePath,
      payload.targetSiteId,
      payload.importedById
    )

    // -> Only reached once the restore itself succeeded: a failed or partial import must not reload
    //    caches as though it had landed.
    await groupsDep.broadcastReload()
    glossaryDep.invalidateCache(payload.targetSiteId)
    assetServingDep.forgetAllPaths()
    await addJob({ task: 'rebuildSearchIndex', payload: { siteId: payload.targetSiteId } })

    if (jobId) {
      await jobsDep.setResult(jobId, result)
    }
    return { summary: 'imported site content', site: payload.targetSiteId }
  } finally {
    await siteImportDep.deleteUpload(payload.filePath)
  }
}
