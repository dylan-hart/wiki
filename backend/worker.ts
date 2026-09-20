import { kebabCase } from 'es-toolkit/string'
import path from 'node:path'
import { threadId, workerData } from 'node:worker_threads'
import configSvc from './core/config.ts'
import logger from './core/logger.ts'
import dbManager from './core/db.ts'
import { ensureTemporal } from './core/temporal.ts'
import { workerInstanceId } from './helpers/bootSummary.ts'

await ensureTemporal()

const CARDINAL = {
  IS_DEBUG: process.env.NODE_ENV === 'development',
  ROOTPATH: process.cwd(),
  // -> Settled before the logger below is built, so every line this thread emits — its boot lines
  //    included — carries the same id. The parent id comes through piscina's `workerData`
  //    (`core/scheduler.ts`'s pool construction); the ordinal is this thread's own `threadId`,
  //    since one `workerData` object is shared by the whole pool.
  INSTANCE_ID: workerInstanceId(
    (workerData as { parentInstanceId?: unknown } | null)?.parentInstanceId,
    threadId
  ),
  // -> Forwarded by the parent through `workerData` too: a worker thread never calls
  //    `syncSchemas()` itself to learn them.
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
      Only the models a worker thread's tasks actually need, not the whole registry: a thread pays
      the import cost of everything it pulls in, and all of them would bring cheerio, sanitize-html,
      bcrypt and the rest into a thread that wanted one `select`. A task that needs another model
      imports that model itself.

      `extensions` is here so `helpers/embeddings.ts#getExtractor()`'s failure path can record a
      failed local embedding-model load (`noteLoadFailure()`). That only touches an in-memory `Set`,
      so no `refreshFromDisk()` call is needed here.
    */
    CARDINAL.models = {
      settings: (await import('./models/settings.ts')).settings,
      extensions: (await import('./models/extensions.ts')).extensions
    } as CardinalGlobal['models']

    try {
      await CARDINAL.configSvc.loadFromDb()
    } catch (err: any) {
      CARDINAL.logger.error('db', 'database initialization failed', { error: err })
      process.exit(1)
    }
  }
} as unknown as CardinalGlobal
global.CARDINAL = CARDINAL

await CARDINAL.configSvc.init(true)

CARDINAL.logger = logger.init()

export default async (job: any) => {
  const task = (await import(`./tasks/workers/${kebabCase(job.task)}.ts`)).task
  await task(job)
  return true
}
