import { kebabCase } from 'es-toolkit/string'
import path from 'node:path'
import { threadId, workerData } from 'node:worker_threads'
import configSvc from './core/config.ts'
import logger from './core/logger.ts'
import dbManager from './core/db.ts'
import { ensureTemporal } from './core/temporal.ts'
import { workerInstanceId } from './helpers/bootSummary.ts'

// ----------------------------------------
// Init Minimal Core
// ----------------------------------------

await ensureTemporal()

const CARDINAL = {
  IS_DEBUG: process.env.NODE_ENV === 'development',
  ROOTPATH: process.cwd(),
  // -> Settled before the logger below is built, so every line this thread ever emits — its boot
  //    lines included — carries the same id. It used to be the literal `'worker'` here and was
  //    overwritten with the parent's id on the first job, which meant a worker's own startup was
  //    filed under a different identity than the work it then did (audit N8). The parent id comes
  //    through piscina's `workerData` (`core/scheduler.ts`'s pool construction); the ordinal is this
  //    thread's own `threadId`, since one `workerData` object is shared by the whole pool.
  INSTANCE_ID: workerInstanceId(
    (workerData as { parentInstanceId?: unknown } | null)?.parentInstanceId,
    threadId
  ),
  // -> Same transport as `INSTANCE_ID` above, and settled at the same module-scope timing: the
  //    parent process forwards its already-settled `CARDINAL.capabilities` into `workerData`
  //    (`core/scheduler.ts`'s pool construction) once, at pool-creation time, since a worker thread never
  //    calls `syncSchemas()` itself to learn it (OpenProject #3124). A task run in this thread that
  //    reads `CARDINAL.capabilities?.semanticSearch` now sees the real boot-time value instead of always
  //    `undefined`.
  capabilities: (workerData as { capabilities?: CardinalGlobal['capabilities'] } | null)
    ?.capabilities,
  SERVERPATH: path.join(process.cwd(), 'backend'),
  configSvc,
  ensureDb: async () => {
    if (CARDINAL.db) {
      return true
    }

    CARDINAL.db = await dbManager.init(true)
    /*
      Only the models a worker thread's tasks actually need, not the whole registry. A worker thread
      pays the import cost of everything it pulls in, and importing all of them brings cheerio,
      sanitize-html, bcrypt and the rest into a thread that wanted one `select`. A task that needs
      another model imports that model itself.

      `extensions` is here (mirroring `backend/migration/bootstrap.ts#loadModels()`, which includes it
      deliberately for its own Sharp/Puppeteer checks) because `helpers/embeddings.ts#getExtractor()`'s
      failure path calls `CARDINAL.models.extensions.noteLoadFailure()` to record a failed local
      embedding-model load — without it that call throws `Cannot read properties of undefined` before
      the intended warn log ever runs, turning a job meant to degrade gracefully into a hard crash
      (OpenProject #3295). It only touches an in-memory `Set` (`noteLoadFailure`/`hasLoadFailed`), so
      no `refreshFromDisk()` call is needed here.
    */
    CARDINAL.models = {
      settings: (await import('./models/settings.ts')).settings,
      extensions: (await import('./models/extensions.ts')).extensions
    } as CardinalGlobal['models']

    try {
      await CARDINAL.configSvc.loadFromDb()
    } catch (err: any) {
      // -> One record: the message inline and the stack below it, rather than a second `error(err)`
      //    the operator only saw with debug already on.
      CARDINAL.logger.error('db', 'database initialization failed', { error: err })
      process.exit(1)
    }
  }
} as unknown as CardinalGlobal
global.CARDINAL = CARDINAL

await CARDINAL.configSvc.init(true)

// ----------------------------------------
// Init Logger
// ----------------------------------------

CARDINAL.logger = logger.init()

// ----------------------------------------
// Execute Task
// ----------------------------------------

export default async (job: any) => {
  // -> No `CARDINAL.INSTANCE_ID` assignment here any more: the id is settled at boot, above, so a job
  //    can no longer rename the thread it is running on halfway through its life.
  const task = (await import(`./tasks/workers/${kebabCase(job.task)}.ts`)).task
  await task(job)
  return true
}
