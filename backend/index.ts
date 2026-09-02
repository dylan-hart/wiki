// ===========================================
// Wiki.js Server
// Licensed under AGPLv3
// ===========================================

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import semver from 'semver'
import { customAlphabet } from 'nanoid'

import fastify from 'fastify'
import fastifyCompress from '@fastify/compress'
import fastifyFavicon from 'fastify-favicon'
import fastifyFormBody from '@fastify/formbody'
import fastifySensible from '@fastify/sensible'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import gracefulServer from '@gquittet/graceful-server'
import ajvFormats from 'ajv-formats'
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
import { registerSession } from './core/http/session.ts'
import {
  registerAppShellFallback,
  registerSeoRedirects,
  registerSiteResolution
} from './core/http/siteRouting.ts'
import { registerUnhandledRejectionHandler, runBootPhaseOrExit } from './core/processGuards.ts'
import scheduler from './core/scheduler.ts'
import { ensureTemporal } from './core/temporal.ts'
import { isHashedAssetFilename, isSameOriginWebSocketHandshake } from './helpers/common.ts'

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

WIKI.logger = logger.init()

// -> Registered as early as `WIKI.logger` exists, so nothing between here and the end of boot can
//    crash the process unlogged via a rejection nobody's `.catch` caught. Exits deliberately rather
//    than carrying on in a state some in-flight operation already gave up on.
registerUnhandledRejectionHandler(WIKI.logger, {
  debug: WIKI.IS_DEBUG,
  exit: (code) => process.exit(code)
})

// ----------------------------------------
// Init Server
// ----------------------------------------

WIKI.logger.info('=======================================')
WIKI.logger.info(`= Wiki.js ${(WIKI.version + ' ').padEnd(29, '=')}`)
WIKI.logger.info('=======================================')
WIKI.logger.info('Initializing...')
WIKI.logger.info(`Running node.js ${process.version} [ OK ]`)

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
    WIKI.logger.error('Database Initialization Error: ' + err.message)
    if (WIKI.IS_DEBUG) {
      WIKI.logger.error(err)
    }
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
  await WIKI.models.approvals.reloadCache()
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

  const app = fastify({
    ajv: {
      // -> `ajv-formats` is CJS: the default import resolves to `module.exports`, so the callable
      //    plugin is reached via `.default` (verified identical at runtime: `f === f.default`).
      //    The tuple assertion is load-bearing twice over: it stops the element from widening
      //    (which makes fastify's overload resolution fall through to the HTTP/2 signature), and
      //    it bridges an upstream variance mismatch — @fastify/ajv-compiler declares plugin
      //    options as `unknown`, while ajv-formats declares its own narrower options type, and the
      //    two are contravariantly incompatible. (`ajv` itself is only a nested dependency here, so
      //    its `Plugin` type is not importable to state this more precisely.)
      plugins: [[ajvFormats.default, {}] as any],
      onCreate: (ajv: any) => {
        // -> Accepts the shorthand, alpha and full forms a color picker can produce:
        //    #RGB, #RGBA, #RRGGBB and #RRGGBBAA
        ajv.addFormat('hexcolor', (data: unknown) => {
          return (
            typeof data === 'string' &&
            /^#(?:[a-fA-F0-9]{3,4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/.test(data)
          )
        })
      }
    },
    bodyLimit: WIKI.config.bodyParserLimit || 5242880, // 5mb
    // -> `level: 'error'` used to suppress pino's own request/response logging entirely (emitted at
    //    `info`) — no access log, no per-request latency, no status code, no correlation id
    //    (OpenProject #1937). `genReqId` gives every request one; in `logFormat: 'json'` mode the
    //    `formatters`/`messageKey`/`timestamp`/`base` options below reshape pino's own JSON line into
    //    the exact `{ timestamp, instance, level, message, ... }` shape `core/logger.ts`'s JSON branch
    //    already emits, so an aggregator sees one format across both loggers instead of two. Text mode
    //    is left as Fastify's own default pino output — the audit note this WP implements only scopes
    //    shape-matching to JSON mode.
    logger: {
      level: 'info',
      genReqId: () => randomUUID(),
      ...(WIKI.config.logFormat === 'json'
        ? {
            messageKey: 'message',
            timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
            base: { instance: WIKI.INSTANCE_ID },
            formatters: {
              level: (label: string) => ({ level: label })
            }
          }
        : {})
    },
    // -> `securityTrustProxy` was the 2.x name: the setting is `trustProxy`, so this read never
    //    matched and the option was permanently off no matter what the admin area showed.
    //    `trustProxy` is boolean-or-string -- see `models/security.ts#validateTrustProxySpec` and
    //    `api/schemas/security.ts` -- and Fastify's own `getTrustProxyFn` (`fastify/lib/request.js`)
    //    is what turns a string into a compiled `proxy-addr` trust function, so it is passed through
    //    verbatim rather than coerced. A trusted-proxy address/CIDR list (not the bare `true` this
    //    admin toggle used to send) is what keeps `req.ip`/`req.hostname` from trusting
    //    `X-Forwarded-For`/`X-Forwarded-Host` sent by an untrusted client -- see
    //    `docs/tls-termination.md`. Every hostname-keyed site lookup (`core/http/siteRouting.ts`'s
    //    SEO hook, site-resolution hook and app-shell fallback, `models/sites.ts#getSiteByHostname`,
    //    and the hostname reads in `controllers/files.ts`/`seo.ts`/`site.ts` and
    //    `api/authentication.ts`) reads `req.hostname`, so narrowing this one setting closes the
    //    cross-site `X-Forwarded-Host` steering gap for all of them (task 2085).
    trustProxy: WIKI.config.security.trustProxy ?? false,
    routerOptions: {
      ignoreTrailingSlash: true
    }
  })
  WIKI.app = app
  WIKI.server = gracefulServer(app.server, {
    livenessEndpoint: '/_live',
    readinessEndpoint: '/_ready',
    kubernetes: Boolean(process.env.KUBERNETES_SERVICE_HOST),
    // -> Awaited via `Promise.allSettled` by the library once the pre-close delay below has
    //    elapsed — each one is itself internally bounded (`scheduler.stop()`'s own drain timeout,
    //    `collab.shutdown()`/`dbManager.shutdown()`'s bounded socket/pool teardown), so a hung
    //    routine here cannot hold the process open indefinitely. Previously empty, so every deploy,
    //    restart or pod eviction abandoned an in-flight job, a live collab socket and the pg pool's
    //    LISTEN client rather than draining them (OpenProject #2018/#2028). `dbManager.shutdown()`
    //    is one call rather than its two steps listed separately here, because those two steps have
    //    an order dependency (`unsubscribeFromNotifications()`'s own drain needs a live pool) that
    //    `Promise.allSettled` running sibling entries concurrently would not preserve.
    closePromises: [
      () => WIKI.scheduler.stop(),
      () => WIKI.collab.shutdown(),
      () => WIKI.dbManager.shutdown()
    ],
    // -> Library default is 1000ms, spent entirely as a pre-close delay *before* `closePromises`
    //    run (not a timeout wrapping them) — barely enough for a readiness probe to notice
    //    `isReady()` has flipped and stop routing new traffic here. Raised well above that, while
    //    staying comfortably under a typical 30s Kubernetes `terminationGracePeriodSeconds` once
    //    added to `scheduler.stop()`'s own drain bound above.
    timeout: 5000
  })

  app.register(fastifySensible)
  app.register(fastifyCompress, { global: true })
  /*
    Websocket upgrades, for live collaborative editing (`controllers/collab.ts`) and the admin
    terminal's log stream (`controllers/terminal.ts`). Registered on the root instance because the
    upgrade handler is installed on the HTTP server itself, and before the routes below because a
    route declaring `websocket: true` needs it already there.

    `maxPayload` bounds a single frame: these carry keystrokes and cursor positions, and the largest
    legitimate one is a client handing over a document it edited while offline.

    `verifyClient` (task 2120 / WP 2105 §5) is the cross-origin gate for every current and future
    `websocket: true` route: a WebSocket handshake is not subject to the same-origin policy and is
    not preflighted, so CORS governs neither it nor the frames that follow — unlike a form POST, the
    response is fully readable by whichever origin opened the socket, and each route's own
    session/permission check runs against whatever cookie the browser attached regardless of which
    page attached it. One `verifyClient` here closes that for both current routes
    (`controllers/terminal.ts`, `controllers/collab.ts`) and any future one, rather than each handler
    re-deriving its own origin check. See `helpers/common.ts#isSameOriginWebSocketHandshake` --
    passed `WIKI.sitesMappings`' own hostnames too, so a handshake between two sites this same
    instance actually serves is also accepted, not only a request whose Origin matches the exact Host
    it landed on.
  */
  app.register(fastifyWebsocket, {
    options: {
      maxPayload: 5242880,
      verifyClient: (info: {
        origin: string
        secure: boolean
        req: import('node:http').IncomingMessage
      }) =>
        isSameOriginWebSocketHandshake(
          info.origin,
          info.req.headers.host,
          Object.keys(WIKI.sitesMappings)
        )
    }
  })

  // ----------------------------------------
  // Handle graceful server shutdown
  // ----------------------------------------

  WIKI.server.on(gracefulServer.SHUTTING_DOWN, () => {
    // -> The actual teardown (scheduler drain, collab socket close, db unsubscribe + pool end) now
    //    runs via `closePromises` above, awaited by the library before it closes the server — this
    //    handler is logging only.
    WIKI.logger.info('Shutting down HTTP Server... [ STOPPING ]')
  })

  WIKI.server.on(gracefulServer.SHUTDOWN, (err: Error) => {
    WIKI.logger.info(`HTTP Server has exited: [ STOPPED ] (${err.message})`)
    if (err.message !== 'SIGINT') {
      WIKI.logger.warn(err)
    }
  })

  // ----------------------------------------
  // Security
  // ----------------------------------------

  registerSecurity(app)

  // ----------------------------------------
  // Public Assets
  // ----------------------------------------

  app.register(fastifyFavicon, {
    path: path.join(WIKI.ROOTPATH, 'assets'),
    name: 'favicon.ico'
  })
  app.register(fastifyStatic, {
    prefix: '/_assets/',
    root: path.join(WIKI.ROOTPATH, 'assets/_assets'),
    index: false,
    maxAge: '7d',
    decorateReply: false,
    // -> Most of what's under `assets/_assets` is a vite build output named `[name]-[hash].[ext]`,
    //    whose bytes can never change under a given URL — those get the same far-future immutable
    //    header `controllers/thumb.ts`'s THUMB_CACHE already uses. The handful of unhashed entries
    //    (renderer.js, and the hand-authored bg/fonts/icons/illustrations/logo-wikijs.svg/storage/svg
    //    trees) fall through to the `maxAge: '7d'` default above instead.
    setHeaders(reply, filePath) {
      if (isHashedAssetFilename(path.basename(filePath))) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      }
    }
  })

  // ----------------------------------------
  // Blocks
  // ----------------------------------------

  app.register(fastifyStatic, {
    prefix: '/_blocks/',
    root: path.join(WIKI.ROOTPATH, 'blocks/compiled'),
    index: false,
    maxAge: '1h'
  })
  // -> A custom block's code is a database row, not a file under `blocks/compiled` — served by
  //    `controllers/blocks.ts` instead, registered below with the other controllers. Its route has a
  //    literal `custom` segment, which the router matches ahead of this mount's wildcard.

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
    WIKI.logger.info(`Starting HTTP Server on port ${WIKI.config.port} [ STARTING ]`)
    await app.listen({ port: WIKI.config.port, host: WIKI.config.bindIP })
    WIKI.logger.info('HTTP Server: [ RUNNING ]')
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
    WIKI.logger.error(err)
    process.exit(1)
  }
}

// ----------------------------------------
// Initialization Sequence
// ----------------------------------------

await preBoot()
await initHTTPServer()

await runBootPhaseOrExit(postBoot, 'Post-Boot Initialization Error', WIKI.logger, {
  debug: WIKI.IS_DEBUG
})

// -> Not ready until postBoot() has resolved: everything that makes the instance able to answer a
//    page request (site/group/locale/approval/classification caches, storage/search/comment sync,
//    the scheduler, ...) happens there. Signalling ready any earlier — e.g. as the last statement of
//    initHTTPServer(), right after the listener binds — means /_ready reports 200 while every page
//    request would still resolve to not-found (OpenProject #2062).
WIKI.server.setReady()
