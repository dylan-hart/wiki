import { importModel as siteImport } from '../../models/siteImport.ts'
import { groups } from '../../models/groups.ts'
import { glossary } from '../../models/glossary.ts'
import { assetServing } from '../../models/assetServing.ts'
import { jobs } from '../../models/jobs.ts'

/**
 * Restore a tarball uploaded through `POST /_api/system/import` into a target site.
 *
 * Queued from the route rather than run inline, mirroring `exportContent`: reading a whole archive
 * back apart and restoring it inside a transaction is not something a request thread should be
 * blocked on. The uploaded file is a working file rather than a downloadable product (unlike an
 * export's tarball), so it is deleted once this task is done with it — success or failure alike.
 *
 * `siteImport.importSite` writes `pages`/`tree`/`assets`/`groups` directly against the database
 * (bypassing `models/groups.ts`'s own write paths for the group upsert, in particular — see its own
 * class doc), so none of the ordinary post-write cache/index hooks fire on their own. This task is
 * what runs them, once `importSite` has actually succeeded: reloading (and cluster-broadcasting) the
 * page-rule cache imported/updated groups are now part of, invalidating the glossary's cached terms
 * for the target site, dropping the asset path-resolution cache wholesale (a bulk content replacement
 * isn't enumerable path-by-path the way a single move is), and queuing — not running inline — a full
 * search-index rebuild for the target site, so the job's own runtime stays bounded to the restore
 * itself rather than also paying for a synchronous reindex.
 *
 * @param deps Real models (and scheduler) by default; overridable so tests can exercise the
 *   post-import side effects without a database. Each has its own default rather than one default for
 *   the whole object, so a test overriding only one dependency still gets the real implementation of
 *   the rest.
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
    addJob?: typeof WIKI.scheduler.addJob
  } = {}
): Promise<void> {
  const {
    siteImport: siteImportDep = siteImport,
    groups: groupsDep = groups,
    glossary: glossaryDep = glossary,
    assetServing: assetServingDep = assetServing,
    jobs: jobsDep = jobs,
    addJob = (opts) => WIKI.scheduler.addJob(opts)
  } = deps

  // -> Announced at `debug` because a whole site's restore can take minutes. The `try` stays for the
  //    `finally` that deletes the upload; the failure itself is not logged here, it propagates and
  //    the scheduler writes the one record for it.
  WIKI.logger.debug('pages', 'importing site content', { site: payload.targetSiteId })
  try {
    const result = await siteImportDep.importSite(
      payload.filePath,
      payload.targetSiteId,
      payload.importedById
    )

    // -> Post-import side effects: only reached once the restore itself has actually succeeded, so a
    //    failed/partial import never reloads caches as though it had landed.
    await groupsDep.broadcastReload()
    glossaryDep.invalidateCache(payload.targetSiteId)
    assetServingDep.forgetAllPaths()
    await addJob({ task: 'rebuildSearchIndex', payload: { siteId: payload.targetSiteId } })

    if (jobId) {
      await jobsDep.setResult(jobId, result)
    }
    WIKI.logger.info('pages', 'imported site content', { site: payload.targetSiteId })
  } finally {
    await siteImportDep.deleteUpload(payload.filePath)
  }
}
