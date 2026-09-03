import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fastify, { type FastifyInstance } from 'fastify'
import fastifyCompress from '@fastify/compress'
import fastifyFavicon from 'fastify-favicon'
import fastifySensible from '@fastify/sensible'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import gracefulServer from '@gquittet/graceful-server'
import ajvFormats from 'ajv-formats'

import { isHashedAssetFilename, isSameOriginWebSocketHandshake } from '../../helpers/common.ts'

/**
 * The Fastify instance itself, everything wrapped around it that is not routing, and the static
 * mounts that answer straight off disk — the part of `initHTTPServer()` that builds a server rather
 * than wiring behaviour onto one.
 *
 * `createHttpApp()` assigns `WIKI.app` and `WIKI.server` as it goes, in the same order `index.ts`
 * did: the graceful-shutdown handlers below are registered on `WIKI.server`, so the object and its
 * handlers cannot be separated from the construction that produces them, and a single
 * `FastifyInstance` return value has nowhere to carry the second one back. `index.ts` keeps the boot
 * sequence and the `listen()` that ends it.
 */
export function createHttpApp(): FastifyInstance {
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
    //    `api/auth/provider.ts`) reads `req.hostname`, so narrowing this one setting closes the
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

  return app
}

/**
 * The three static mounts served straight off disk: the root favicon, the frontend's build output
 * under `/_assets/`, and the compiled blocks under `/_blocks/`.
 *
 * Registered between `registerSecurity` and `registerSession` — where the mounts already sat, and
 * where they have to stay: Fastify runs plugins in registration order, so moving this call is a
 * behaviour change rather than a tidy-up.
 */
export function registerStaticAssets(app: FastifyInstance): void {
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
}
