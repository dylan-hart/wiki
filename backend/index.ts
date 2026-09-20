// ===========================================
// Cardinal.js Server
// Licensed under AGPLv3
// ===========================================

import { existsSync } from 'node:fs'
import path from 'node:path'
import semver from 'semver'

import fastifyFormBody from '@fastify/formbody'
import Emittery from 'emittery'
import { LRUCache } from 'lru-cache'

import collab from './core/collab.ts'
import configSvc from './core/config.ts'
import dbManager from './core/db.ts'
import logger from './core/logger.ts'
import { registerAuthHooks } from './core/http/authHooks.ts'
import { registerErrorHandler } from './core/http/errors.ts'
import { registerOpenApi } from './core/http/openapi.ts'
import { registerRoutes } from './core/http/routes.ts'
import { registerSecurity } from './core/http/security.ts'
import { createHttpApp, registerStaticAssets } from './core/http/server.ts'
import { registerSession } from './core/http/session.ts'
import {
  registerAppShellFallback,
  registerSeoRedirects,
  registerSiteResolution
} from './core/http/siteRouting.ts'
import { registerUnhandledRejectionHandler, runBootPhaseOrExit } from './core/processGuards.ts'
import scheduler from './core/scheduler.ts'
import { ensureTemporal } from './core/temporal.ts'
import { readyFields } from './helpers/bootSummary.ts'
import { randomHexToken } from './helpers/randomToken.ts'

if (!semver.satisfies(process.version, '>=26')) {
  // eslint-disable-next-line no-console -- refused before config, and therefore before `CARDINAL.logger`, exists
  console.error('ERROR: Node.js 26.x or later required!')
  process.exit(1)
}

if (existsSync('./package.json')) {
  // eslint-disable-next-line no-console -- refused before config, and therefore before `CARDINAL.logger`, exists
  console.error('ERROR: Must run server from the parent directory!')
  process.exit(1)
}

// A no-op unless this Node build was compiled without `Temporal` (see `core/temporal.ts`). Must
// resolve before the `CARDINAL` literal below, which calls `Temporal.Now.instant()` synchronously.
await ensureTemporal()

// Assembled progressively, hence the cast: preBoot() and initHTTPServer() fill in the rest.
const CARDINAL = {
  IS_DEBUG: process.env.NODE_ENV === 'development',
  ROOTPATH: process.cwd(),
  INSTANCE_ID: randomHexToken(),
  SERVERPATH: path.join(process.cwd(), 'backend'),
  auth: {
    groups: {},
    strategies: {}
  },
  collab,
  configSvc,
  sites: {},
  sitesMappings: {},
  startedAt: Temporal.Now.instant()
} as unknown as CardinalGlobal
global.CARDINAL = CARDINAL

if (CARDINAL.IS_DEBUG) {
  process.on('warning', (warning: Error) => {
    // eslint-disable-next-line no-console -- registered before `CARDINAL.logger` exists, and a Node process warning can fire before it does
    console.log(warning.stack)
  })
}

// -> Returns its provenance rather than logging it: `CARDINAL.logger` cannot exist yet (it reads
//    `CARDINAL.config.logLevel`), so the `boot starting` line below reports it instead.
const configProvenance = await CARDINAL.configSvc.init()

// -> A thunk, re-read on every line: flipping `sqlLog` or `authDebug` in the admin area applies
//    from the next line with no restart. It also has to be one — `CARDINAL.models` does not exist
//    until `preBoot()` builds it.
CARDINAL.logger = logger.init({
  scopeOverrides: () => CARDINAL.models?.flags?.logScopeOverrides() ?? {}
})

// -> Registered as soon as `CARDINAL.logger` exists, so no stray rejection during the rest of boot
//    can crash the process unlogged. Exits deliberately rather than carrying on in a state some
//    in-flight operation already gave up on.
registerUnhandledRejectionHandler(CARDINAL.logger, {
  exit: (code) => process.exit(code)
})

// -> `config` is the resolved path actually read, and `overrides` names the environment variables
//    that were HONOURED, not merely set. `none` rather than an omitted field, so "no overrides" is
//    distinguishable from a build that does not report them.
CARDINAL.logger.info('boot', 'starting', {
  version: CARDINAL.version,
  node: process.version,
  instance: CARDINAL.INSTANCE_ID,
  config: configProvenance.configPath,
  overrides: configProvenance.overrides.join(',') || 'none'
})

async function preBoot() {
  try {
    CARDINAL.dbManager = (await import('./core/db.ts')).default
    CARDINAL.db = await dbManager.init()
    CARDINAL.models = (await import('./models/index.ts')).default

    await CARDINAL.configSvc.ensureSeeded()
  } catch (err: any) {
    CARDINAL.logger.error('db', 'database initialization failed', { error: err })
    process.exit(1)
  }

  CARDINAL.cache = new LRUCache({ max: 5000 })
  CARDINAL.scheduler = await scheduler.init()
  CARDINAL.events = {
    inbound: new Emittery(),
    outbound: new Emittery()
  }
}

async function postBoot() {
  await CARDINAL.models.locales.refreshFromDisk()

  await CARDINAL.models.authentication.refreshStrategiesFromDisk()

  // -> Analytics providers have no db table of their own, so no per-site sync follows
  await CARDINAL.models.analytics.refreshFromDisk()

  await CARDINAL.models.authentication.activateStrategies()
  await CARDINAL.models.locales.reloadCache()
  await CARDINAL.models.sites.reloadCache()
  // -> Page access is decided from these on every request, so they are in memory from the start
  await CARDINAL.models.groups.reloadCache()
  // -> Likewise: every page view asks whether the page takes suggestions and who reviews it
  await CARDINAL.models.approvalRules.reloadCache()
  // -> The floor invariant is checked on every page create/move, so this is in memory too
  await CARDINAL.models.classificationLevels.reloadCache()

  // -> Must follow the sites cache: every site gets a row per installed block
  await CARDINAL.models.blocks.refreshFromDisk()
  await CARDINAL.models.blocks.syncAllSites()

  // -> Same: every site gets a row per installed storage module
  await CARDINAL.models.storage.refreshFromDisk()
  await CARDINAL.models.storage.syncAllSites()

  // -> Same: every site gets a row per installed comment provider module
  await CARDINAL.models.commentProviders.refreshFromDisk()
  await CARDINAL.models.commentProviders.syncAllSites()

  // -> Definitions only, with no per-site sync: a site names its one active engine in config
  //    (`site.config.search.engine`) rather than keeping a row per installed module
  await CARDINAL.models.search.refreshFromDisk()
  // -> Needs the definitions above loaded first. Runs on every boot: each module's `init()` is
  //    idempotent
  await CARDINAL.models.search.initActiveEngines()

  // -> Optional third-party tooling: report what is available, since features silently degrade
  //    without it
  await CARDINAL.models.extensions.refreshFromDisk()
  await CARDINAL.models.extensions.logState()

  // -> The icon cache is derived from the db and starts empty on a fresh instance
  await CARDINAL.models.icons.ensureCacheDir()
  // -> Icon collections sideloaded under <dataPath>/icons/ are the offline equivalent of the
  //    Iconify API fetch
  await CARDINAL.models.icons.sideloadFromDataPath()

  await CARDINAL.dbManager.subscribeToNotifications()
  // -> Its own postgres listener and channel: collaboration traffic is far heavier than the event
  //    bus's. Must follow the sites cache, which the websocket handshake reads the per-site
  //    feature toggle from.
  await CARDINAL.collab.init()
  await CARDINAL.scheduler.start()

  // -> A page queued for rendering when this instance went down is still queued, and nothing looks at
  //    that table until somebody asks for another render. Costs one query when there is nothing to do.
  await CARDINAL.scheduler.addJob({ task: 'renderPages', maxRetries: 0 })
}

/*
  The wiring itself lives in `core/http/*`, one module per responsibility. The call order below IS
  the behaviour — Fastify runs hooks in the order they were added and plugins in the order they were
  registered — so a `register*` call moved here is a behaviour change, not a tidy-up.
*/
async function initHTTPServer() {
  const app = createHttpApp()

  registerSecurity(app)

  registerStaticAssets(app)

  registerSession(app)

  registerOpenApi(app)

  registerAuthHooks(app)

  registerSeoRedirects(app)

  app.register(fastifyFormBody, {
    bodyLimit: 1048576 // 1mb
  })

  registerSiteResolution(app)

  registerRoutes(app)

  registerAppShellFallback(app)

  registerErrorHandler(app)

  try {
    await app.listen({ port: CARDINAL.config.port, host: CARDINAL.config.bindIP })
    CARDINAL.logger.info('http', 'listening', {
      host: CARDINAL.config.bindIP,
      port: CARDINAL.config.port
    })
    // -> `/_ready` is deliberately NOT flipped here: a bound socket is not an instance that can
    //    serve a request. Readiness is signalled at the bottom of this file, once `postBoot()` has
    //    filled the caches; `/_live` answers from here on regardless.
  } catch (err: any) {
    CARDINAL.logger.error('boot', 'http server failed to bind', {
      host: CARDINAL.config.bindIP,
      port: CARDINAL.config.port,
      error: err
    })
    process.exit(1)
  }
}

await preBoot()
await initHTTPServer()

await runBootPhaseOrExit(postBoot, 'post-boot initialization', CARDINAL.logger)

// -> Emitted BEFORE `setReady()` so that stays the file's final statement (`index.test.ts` asserts
//    it); `setReady()` logs nothing, so this is still the last line written. `ms` is wall time
//    since the `CARDINAL` literal, as close to process start as anything in userland gets.
CARDINAL.logger.info(
  'boot',
  'ready',
  readyFields({
    sites: CARDINAL.sites,
    bindIP: CARDINAL.config.bindIP,
    port: CARDINAL.config.port,
    ms: Temporal.Now.instant().epochMilliseconds - CARDINAL.startedAt.epochMilliseconds
  })
)

// -> Not ready until postBoot() has resolved: it fills every cache a page request reads. Signalled
//    any earlier — e.g. once the listener binds — /_ready would report 200, and a load balancer
//    would route traffic here, while every page request still resolves to not-found.
CARDINAL.server.setReady()
