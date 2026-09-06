import { ThreadWorker } from 'poolifier'
import { kebabCase } from 'es-toolkit/string'
import path from 'node:path'
import configSvc from './core/config.ts'
import logger from './core/logger.ts'
import dbManager from './core/db.ts'
import { ensureTemporal } from './core/temporal.ts'

// ----------------------------------------
// Init Minimal Core
// ----------------------------------------

await ensureTemporal()

const WIKI = {
  IS_DEBUG: process.env.NODE_ENV === 'development',
  ROOTPATH: process.cwd(),
  INSTANCE_ID: 'worker',
  SERVERPATH: path.join(process.cwd(), 'backend'),
  configSvc,
  ensureDb: async () => {
    if (WIKI.db) {
      return true
    }

    WIKI.db = await dbManager.init(true)
    /*
      Only the settings model, which is what `loadFromDb` reads through — not the whole registry.
      A worker thread pays the import cost of everything it pulls in, and importing all of them
      brings cheerio, sanitize-html, bcrypt and the rest into a thread that wanted one `select`.
      A task that needs another model imports that model itself.
    */
    WIKI.models = {
      settings: (await import('./models/settings.ts')).settings
    } as WikiGlobal['models']

    try {
      await WIKI.configSvc.loadFromDb()
    } catch (err: any) {
      // -> One record: the message inline and the stack below it, rather than a second `error(err)`
      //    the operator only saw with debug already on.
      WIKI.logger.error('db', 'database initialization failed', { error: err })
      process.exit(1)
    }
  }
} as unknown as WikiGlobal
global.WIKI = WIKI

await WIKI.configSvc.init(true)

// ----------------------------------------
// Init Logger
// ----------------------------------------

WIKI.logger = logger.init()

// ----------------------------------------
// Execute Task
// ----------------------------------------

export default new ThreadWorker(async (job: any) => {
  WIKI.INSTANCE_ID = job.INSTANCE_ID
  const task = (await import(`./tasks/workers/${kebabCase(job.task)}.ts`)).task
  await task(job)
  return true
})
