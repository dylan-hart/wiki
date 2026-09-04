import { replicationImportModel as replicationImport } from '../../models/replicationImport.ts'
import { sites } from '../../models/sites.ts'
import { groups } from '../../models/groups.ts'
import { classificationLevels } from '../../models/classificationLevels.ts'
import { glossary } from '../../models/glossary.ts'
import { assetServing } from '../../models/assetServing.ts'
import { jobs } from '../../models/jobs.ts'
import { runReplicationPostImport } from '../../helpers/replicationPostImport.ts'

/**
 * Restore a whole-instance snapshot tarball uploaded through `POST
 * /_api/system/replication/import` — the "wipe-and-replace" half of Feature #2437's scheduled
 * replication. See `docs/decisions/bulk-replication-wire-format.md` for the manifest shape and
 * `models/replicationImport.ts` for the restore itself; this task is only what runs once that
 * restore has actually succeeded, plus upload cleanup.
 *
 * `replicationImport.importSnapshot` writes every covered table directly against the database
 * (bypassing each domain model's own write paths, the same way `siteImport.ts#importSite` already
 * does for its narrower scope), so none of the ordinary post-write cache/index hooks fire on their
 * own. This task is what runs them: reloading (and cluster-broadcasting) the three `ClusterReloaded`
 * caches a snapshot just replaced wholesale (`sites`, `groups`, `classificationLevels`), invalidating
 * every site's cached glossary terms and the asset path-resolution cache (a bulk replacement isn't
 * enumerable path-by-path the way a single move is), and queuing — not running inline — a full search
 * reindex per restored site, so the job's own runtime stays bounded to the restore itself.
 *
 * @param deps Real models (and scheduler) by default; overridable so tests can exercise the
 *   post-import side effects without a database. Each has its own default rather than one default for
 *   the whole object, so a test overriding only one dependency still gets the real implementation of
 *   the rest.
 */
export async function task(
  payload: { filePath: string } = { filePath: '' },
  jobId?: string,
  deps: {
    replicationImport?: typeof replicationImport
    sites?: typeof sites
    groups?: typeof groups
    classificationLevels?: typeof classificationLevels
    glossary?: typeof glossary
    assetServing?: typeof assetServing
    jobs?: typeof jobs
    addJob?: typeof WIKI.scheduler.addJob
  } = {}
): Promise<void> {
  const {
    replicationImport: replicationImportDep = replicationImport,
    sites: sitesDep = sites,
    groups: groupsDep = groups,
    classificationLevels: classificationLevelsDep = classificationLevels,
    glossary: glossaryDep = glossary,
    assetServing: assetServingDep = assetServing,
    jobs: jobsDep = jobs,
    addJob = (opts) => WIKI.scheduler.addJob(opts)
  } = deps

  WIKI.logger.info('Restoring replication snapshot (wipe-and-replace)...')
  try {
    const result = await replicationImportDep.importSnapshot(payload.filePath)

    // -> Post-import side effects: only reached once the restore itself has actually succeeded, so a
    //    failed/partial import never reloads caches as though it had landed. Shared with
    //    `models/replication.ts#pull()`, the other caller of `importSnapshot()` -- see
    //    `helpers/replicationPostImport.ts`.
    await runReplicationPostImport({
      sites: sitesDep,
      groups: groupsDep,
      classificationLevels: classificationLevelsDep,
      glossary: glossaryDep,
      assetServing: assetServingDep,
      addJob
    })

    if (jobId) {
      await jobsDep.setResult(jobId, result)
    }
    WIKI.logger.info('Restoring replication snapshot: [ COMPLETED ]')
  } catch (err: any) {
    WIKI.logger.error('Restoring replication snapshot: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  } finally {
    await replicationImportDep.deleteUpload(payload.filePath)
  }
}
