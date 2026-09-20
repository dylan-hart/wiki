import { replicationImportModel as replicationImport } from '../../models/replicationImport.ts'
import { sites } from '../../models/sites.ts'
import { groups } from '../../models/groups.ts'
import { classificationLevels } from '../../models/classificationLevels.ts'
import { glossary } from '../../models/glossary.ts'
import { assetServing } from '../../models/assetServing.ts'
import { jobs } from '../../models/jobs.ts'
import { runReplicationPostImport } from '../../helpers/replicationPostImport.ts'
import type { TaskResult } from '../../core/scheduler.ts'

/**
 * The wipe-and-replace half of scheduled replication: a whole-instance snapshot uploaded through
 * `POST /_api/system/replication/import`.
 *
 * `replicationImport.importSnapshot` writes every covered table straight against the database, so
 * none of the ordinary post-write cache and index hooks fire on their own — running them is what the
 * rest of this task is for. The asset path cache is dropped wholesale because a bulk replacement is
 * not enumerable path-by-path the way a single move is, and the search reindex is queued per restored
 * site rather than run inline so this job's runtime stays bounded to the restore itself.
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
    addJob?: typeof CARDINAL.scheduler.addJob
  } = {}
): Promise<TaskResult> {
  const {
    replicationImport: replicationImportDep = replicationImport,
    sites: sitesDep = sites,
    groups: groupsDep = groups,
    classificationLevels: classificationLevelsDep = classificationLevels,
    glossary: glossaryDep = glossary,
    assetServing: assetServingDep = assetServing,
    jobs: jobsDep = jobs,
    addJob = (opts) => CARDINAL.scheduler.addJob(opts)
  } = deps

  // -> Announced at `debug` because a wipe-and-replace restore can take minutes. The `try` exists
  //    only for the `finally` that deletes the upload; a failure propagates, and the scheduler
  //    writes the one record for it.
  CARDINAL.logger.debug('storage', 'restoring replication snapshot, wipe-and-replace')
  try {
    const result = await replicationImportDep.importSnapshot(payload.filePath)

    // -> Only reached once the restore itself succeeded: a failed or partial import must not reload
    //    caches as though it had landed. Shared with `models/replication.ts#pull()`, the other
    //    caller of `importSnapshot()`.
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
    return { summary: 'restored replication snapshot' }
  } finally {
    await replicationImportDep.deleteUpload(payload.filePath)
  }
}
