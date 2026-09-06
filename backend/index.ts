// ===========================================
// Cardinal.js Server
// Licensed under AGPLv3
// ===========================================

import { existsSync } from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import { customAlphabet } from 'nanoid'

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

const nanoid = customAlphabet('1234567890abcdef', 10)

if (!semver.satisfies(process.version, '>=26')) {
  console.error('ERROR: Node.js 26.x or later required!')
  process.exit(1)
}

if (existsSync('./package.json')) {
  console.error('ERROR: Must run server from the parent directory!')
  process.exit(1)
}

// Contrary to this repo's prior assumption, Node does not ship `Temporal` as an unflagged native
// global even on Node 26 -- see `core/temporal.ts`'s doc comment. Must resolve before the `WIKI`
// literal below, which calls `Temporal.Now.instant()` synchronously.
await ensureTemporal()

// The global is assembled progressively: the literal below holds what is known at startup, and
// preBoot()/initHTTPServer() fill in db, models, cache, scheduler, events, app and server.
const WIKI = {
  IS_DEBUG: process.env.NODE_ENV === 'development',
  ROOTPATH: process.cwd(),
  INSTANCE_ID: nanoid(10),
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
} as unknown as WikiGlobal
global.WIKI = WIKI

if (WIKI.IS_DEBUG) {
  process.on('warning', (warning: Error) => {
    console.log(warning.stack)
  })
}

await WIKI.configSvc.init()

// ----------------------------------------
// Init Logger
// ----------------------------------------

// -> The thunk is the LIVE half of the per-scope thresholds (OpenProject #2663): re-read on every
//    line, so flipping `sqlLog` or `authDebug` in the admin area raises that scope from the next
//    line onwards with no restart. `WIKI.models` does not exist yet — `preBoot()` below builds it —
//    which is exactly why this is a thunk and not a value.
WIKI.logger = logger.init({
  scopeOverrides: () => WIKI.models?.flags?.logScopeOverrides() ?? {}
})

// -> Registered as early as `WIKI.logger` exists, so nothing between here and the end of boot can
//    crash the process unlogged via a rejection nobody's `.catch` caught. Exits deliberately rather
//    than carrying on in a state some in-flight operation already gave up on.
registerUnhandledRejectionHandler(WIKI.logger, {
  exit: (code) => process.exit(code)
})

// ----------------------------------------
// Init Server
// ----------------------------------------

// -> One line for what used to be a three-line banner plus two announcements. Everything the banner
//    drew as decoration is a field, so the same facts survive into JSON mode and an operator can
//    grep for `boot starting` rather than for a row of `=`.
WIKI.logger.info('boot', 'starting', {
  version: WIKI.version,
  node: process.version,
  instance: WIKI.INSTANCE_ID,
  config: process.env.CONFIG_FILE ?? 'config.yml'
})

// ----------------------------------------
// Pre-Boot Sequence
// ----------------------------------------

async function preBoot() {
  try {
    WIKI.dbManager = (await import('./core/db.ts')).default
    WIKI.db = await dbManager.init()
    WIKI.models = (await import('./models/index.ts')).default

    // -> The is-empty check and the seed itself are held under one advisory lock so a concurrently
    //    booting instance can never observe a half-seeded database — see `configSvc.ensureSeeded()`.
    await WIKI.configSvc.ensureSeeded()
  } catch (err: any) {
    // -> One record: the message inline and the stack below it, rather than a second `error(err)`
    //    the operator only saw with debug already on.
    WIKI.logger.error('db', 'database initialization failed', { error: err })
    process.exit(1)
  }

  WIKI.cache = new LRUCache({ max: 5000 })
  WIKI.scheduler = await scheduler.init()
  WIKI.events = {
    inbound: new Emittery(),
    outbound: new Emittery()
  }
}

// ----------------------------------------
// Post-Boot Sequence
// ----------------------------------------

async function postBoot() {
  await WIKI.models.locales.refreshFromDisk()

  await WIKI.models.authentication.refreshStrategiesFromDisk()

  // -> Analytics providers have no db table of their own (see `models/analytics.ts`), so this is
  //    the only refresh they need — no per-site sync follows, unlike auth strategies and storage
  await WIKI.models.analytics.refreshFromDisk()

  await WIKI.models.authentication.activateStrategies()
  await WIKI.models.locales.reloadCache()
  await WIKI.models.sites.reloadCache()
  // -> Page access is decided from these on every request, so they are in memory from the start
  await WIKI.models.groups.reloadCache()
  // -> Likewise: every page view asks whether the page takes suggestions and who reviews it
  await WIKI.models.approvalRules.reloadCache()
  // -> The floor invariant (#1080) is checked on every page create/move, so this is in memory too
  await WIKI.models.classificationLevels.reloadCache()

  // -> Must follow the sites cache: every site gets a row per installed block
  await WIKI.models.blocks.refreshFromDisk()
  await WIKI.models.blocks.syncAllSites()

  // -> Same: every site gets a row per installed storage module
  await WIKI.models.storage.refreshFromDisk()
  await WIKI.models.storage.syncAllSites()

  // -> Same: every site gets a row per installed comment provider module
  await WIKI.models.commentProviders.refreshFromDisk()
  await WIKI.models.commentProviders.syncAllSites()

  // -> Definitions only: a site names its one active engine directly in config
  //    (`site.config.search.engine`) rather than keeping a row per installed module, so there is no
  //    per-site sync step to run here the way there is for storage/blocks
  await WIKI.models.search.refreshFromDisk()
  // -> Provisions whatever engine each site currently has active (OpenProject #920) -- covers a site
  //    that selected a non-`db` engine before this existed, and every normal restart after, which each
  //    module's idempotent `init()` is safe to run again for
  await WIKI.models.search.initActiveEngines()

  // -> Optional third-party tooling: report what is available, since features silently degrade
  //    without it
  await WIKI.models.extensions.refreshFromDisk()
  await WIKI.models.extensions.logState()

  // -> The icon cache is derived from the db and starts empty on a fresh instance
  await WIKI.models.icons.ensureCacheDir()

  await WIKI.dbManager.subscribeToNotifications()
  // -> Its own postgres listener, on its own channel: collaboration traffic is far heavier than the
  //    event bus's and has nothing to do with it. Must follow the sites cache, which the websocket
  //    handshake reads the per-site feature toggle from.
  await WIKI.collab.init()
  await WIKI.scheduler.start()

  // -> A page queued for rendering when this instance went down is still queued, and nothing looks at
  //    that table until somebody asks for another render. Costs one query when there is nothing to do.
  await WIKI.scheduler.addJob({ task: 'renderPages', maxRetries: 0 })
}

// ----------------------------------------
// Init HTTP Server
// ----------------------------------------

/*
  The wiring itself lives in `core/http/*`, one module per responsibility. The call order below IS
  the behaviour — Fastify runs hooks in the order they were added and plugins in the order they were
  registered — so a `register*` call moved here is a behaviour change, not a tidy-up.
*/
async function initHTTPServer() {
  // ----------------------------------------
  // Initialize Fastify App
  // ----------------------------------------

  const app = createHttpApp()

  // ----------------------------------------
  // Security
  // ----------------------------------------

  registerSecurity(app)

  // ----------------------------------------
  // Public Assets
  // ----------------------------------------

  registerStaticAssets(app)

  // ----------------------------------------
  // Sessions
  // ----------------------------------------

  registerSession(app)

  // ----------------------------------------
  // API Documentation
  // ----------------------------------------

  registerOpenApi(app)

  // ----------------------------------------
  // Authentication, rate limits and permissions
  // ----------------------------------------

  registerAuthHooks(app)

  // ----------------------------------------
  // SEO
  // ----------------------------------------

  registerSeoRedirects(app)

  app.register(fastifyFormBody, {
    bodyLimit: 1048576 // 1mb
  })

  // ----------------------------------------
  // Site Resolution
  // ----------------------------------------

  registerSiteResolution(app)

  // ----------------------------------------
  // Routing
  // ----------------------------------------

  registerRoutes(app)

  // ----------------------------------------
  // App Shell
  // ----------------------------------------

  registerAppShellFallback(app)

  // ----------------------------------------
  // Error handling
  // ----------------------------------------

  registerErrorHandler(app)

  // ----------------------------------------
  // Bind HTTP Server
  // ----------------------------------------

  try {
    await app.listen({ port: WIKI.config.port, host: WIKI.config.bindIP })
    WIKI.logger.info('http', 'listening', { host: WIKI.config.bindIP, port: WIKI.config.port })
    // -> `/_ready` is deliberately NOT flipped ready here: `app.listen()` only means the socket
    //    accepts connections, not that a request can be served correctly. `WIKI.sites`/
    //    `WIKI.sitesMappings` are still `{}` at this point (see the WIKI literal above), no auth
    //    strategy is active yet, and the groups/locales/approvals/classification caches every
    //    request path reads from are still empty -- all of that is filled in by `postBoot()`, which
    //    runs after this function returns. Reporting ready here would let a rolling update or load
    //    balancer route live traffic onto an instance that 302s every page to
    //    `/_error/unknownsite` and fails every login. The instance is only marked ready once
    //    `postBoot()` has actually populated those caches, at the bottom of this file. `/_live`
    //    (bound by `gracefulServer` above, independent of that readiness flag) answers from here
    //    onward regardless, so liveness probes still see the process as up throughout.
  } catch (err: any) {
    WIKI.logger.error('boot', 'http server failed to bind', {
      host: WIKI.config.bindIP,
      port: WIKI.config.port,
      error: err
    })
    process.exit(1)
  }
}

// ----------------------------------------
// Initialization Sequence
// ----------------------------------------

await preBoot()
await initHTTPServer()

await runBootPhaseOrExit(postBoot, 'post-boot initialization', WIKI.logger)

// -> Not ready until postBoot() has resolved: everything that makes the instance able to answer a
//    page request (site/group/locale/approval/classification caches, storage/search/comment sync,
//    the scheduler, ...) happens there. Signalling ready any earlier — e.g. as the last statement of
//    initHTTPServer(), right after the listener binds — means /_ready reports 200 while every page
//    request would still resolve to not-found (OpenProject #2062).
WIKI.server.setReady()
