// ===========================================
// Wiki.js Server
// Licensed under AGPLv3
// ===========================================

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import { customAlphabet } from 'nanoid'
import { uniq } from 'es-toolkit/array'

import fastify from 'fastify'
import fastifyCompress from '@fastify/compress'
import fastifyCors from '@fastify/cors'
import fastifyCookie from '@fastify/cookie'
import fastifyFavicon from 'fastify-favicon'
import fastifyFormBody from '@fastify/formbody'
import fastifyHelmet from '@fastify/helmet'
import fastifySensible from '@fastify/sensible'
import fastifySession from '@fastify/session'
import fastifyStatic from '@fastify/static'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import fastifyWebsocket from '@fastify/websocket'
import gracefulServer from '@gquittet/graceful-server'
import ajvFormats from 'ajv-formats'
import Emittery from 'emittery'
import { LRUCache } from 'lru-cache'

import collab from './core/collab.ts'
import configSvc from './core/config.ts'
import dbManager from './core/db.ts'
import logger from './core/logger.ts'
import scheduler from './core/scheduler.ts'
import { apiKeySitePinPreHandler } from './helpers/apiKeySite.ts'
import { resolveAppShellLocale, templateAppShell } from './helpers/appShell.ts'
import { assertValidAuthSecret } from './helpers/authSecret.ts'
import {
  localePrefixRedirectTarget,
  localePrefixStripTarget,
  normalizeHostname,
  resolveRequestSite,
  stripPageExtension
} from './helpers/common.ts'
import { OPENAPI_SECURITY, OPENAPI_SECURITY_SCHEMES } from './helpers/openapi.ts'
import { limitApiKey, limitApiRequests } from './helpers/rateLimit.ts'
import { corsOptions, parseCspDirectives } from './helpers/security.ts'

// -> `Temporal` is not yet a real native global on any currently-shipping Node 26.x build (V8 has not
//    landed it even behind `--harmony-temporal`, despite the flag existing) — every call site in this
//    codebase assumes otherwise, per this repo's own CLAUDE.md. `@js-temporal/polyfill` is already a
//    dependency for exactly this gap, but until now it was only ever installed inside individual test
//    files' own local guards, never on the real boot path — so every real `node backend` start throws
//    `ReferenceError: Temporal is not defined` the moment `WIKI.startedAt` below is assembled. Installed
//    here, before anything else runs, once native support actually lands this becomes a no-op.
if (typeof Temporal === 'undefined') {
  const { Temporal: TemporalPolyfill } = await import('@js-temporal/polyfill')
  ;(globalThis as any).Temporal = TemporalPolyfill
}

const nanoid = customAlphabet('1234567890abcdef', 10)

/**
 * Files a browser or a crawler asks for at the root by convention, rather than because the wiki has a
 * page there. Kept out of the page URL rules below — `txt` is a page extension on a default site, and
 * answering `/robots.txt` with a redirect to `/robots` would be answering the wrong question.
 *
 * `metrics` rides along for the same reason despite not being a "file": `controllers/metrics.ts`
 * registers an unprefixed `/metrics` for Prometheus's fixed scrape convention, which without this
 * entry `isPageUrl()` below reads as a page navigation — a scrape against a hostname mapping to no
 * site (or a disabled one) would 302 to `/_error/unknownsite` / `/_error/disabled` before ever
 * reaching the registered route, and Prometheus follows redirects by default, so it would fail
 * parsing the SPA shell instead of getting a scrape failure that says why (OpenProject #938).
 */
const RESERVED_ROOT_FILES = new Set(['favicon.ico', 'robots.txt', 'sitemap.xml', 'metrics'])

/**
 * First path segments the SERVER itself answers — every prefix registered in `initHTTPServer`.
 *
 * Spelled out rather than tested with `isPageUrl`, because a leading underscore does not mean the
 * server: the frontend router owns `/_admin`, `/_profile`, `/_inbox`, `/_search`, `/_create`, `/_edit`
 * and `/_error` too, and those have to reach the app shell like any page path. The distinction the
 * shell needs is "does something here serve this", which is this list, and it has to be kept in step
 * with the registrations below.
 */
const SERVER_ROUTE_SEGMENTS = new Set([
  '_api',
  '_assets',
  '_blocks',
  '_collab',
  '_files',
  '_icons',
  '_mcp',
  '_render',
  '_site',
  '_terminal',
  '_thumb',
  '_user'
])

/**
 * Whether a URL addresses the page tree rather than the server itself.
 *
 * Everything the server mounts sits under a leading-underscore segment — `/_api`, `/_assets`,
 * `/_files`, and the rest registered in `initHTTPServer` — which is what makes the distinction a
 * prefix test rather than a list to keep in step with the routes.
 */
function isPageUrl(urlPath: string): boolean {
  const firstSegment = urlPath.split('/')[1] ?? ''
  return !firstSegment.startsWith('_') && !RESERVED_ROOT_FILES.has(firstSegment.toLowerCase())
}

/**
 * `isPageUrl` first segments that must reach the app shell even when the hostname resolves to no
 * site, or to one with `isEnabled === false` — the fix path for either state has to survive the very
 * thing it exists to correct, or a disabled site locks its own administrator out of re-enabling it.
 *
 * `login` is the only entry: everything else an operator needs — `/_admin` itself, and the
 * `/_api/sites/*` route `manage:sites` calls to flip `isEnabled` back on — already sits under a
 * leading-underscore segment, which `isPageUrl` excludes before this list is ever consulted. `/login`
 * is the one page-shaped exception, since (unlike `/_admin`) it is owned by the SPA router rather than
 * mounted here, and it is the only way to obtain the session `/_admin` requires in the first place.
 */
const SITE_RESOLUTION_EXEMPT_SEGMENTS = new Set(['login'])

if (!semver.satisfies(process.version, '>=26')) {
  console.error('ERROR: Node.js 26.x or later required!')
  process.exit(1)
}

if (existsSync('./package.json')) {
  console.error('ERROR: Must run server from the parent directory!')
  process.exit(1)
}

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
  WIKI.dbManager = (await import('./core/db.ts')).default
  WIKI.db = await dbManager.init()
  WIKI.models = (await import('./models/index.ts')).default

  try {
    if (await WIKI.configSvc.loadFromDb()) {
      WIKI.logger.info('Settings merged with DB successfully [ OK ]')
    } else {
      WIKI.logger.warn('No settings found in DB. Initializing with defaults...')
      await WIKI.configSvc.initDbValues()

      if (!(await WIKI.configSvc.loadFromDb())) {
        throw new Error('Settings table is empty! Could not initialize [ ERROR ]')
      }
    }
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

async function initHTTPServer() {
  // ----------------------------------------
  // Load core modules
  // ----------------------------------------

  // WIKI.auth = auth.init()
  // WIKI.mail = mail.init()
  // WIKI.system = system.init()

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
    logger: {
      level: 'error'
    },
    // -> `securityTrustProxy` was the 2.x name: the setting is `trustProxy`, so this read never
    //    matched and the option was permanently off no matter what the admin area showed.
    //    `trustProxy` is boolean-or-string -- see `models/security.ts#validateTrustProxySpec` and
    //    `api/schemas/security.ts` -- and Fastify's own `getTrustProxyFn` (`fastify/lib/request.js`)
    //    is what turns a string into a compiled `proxy-addr` trust function, so it is passed through
    //    verbatim rather than coerced. A trusted-proxy address/CIDR list (not the bare `true` this
    //    admin toggle used to send) is what keeps `req.ip`/`req.hostname` from trusting
    //    `X-Forwarded-For`/`X-Forwarded-Host` sent by an untrusted client -- see `docs/tls-termination.md`.
    trustProxy: WIKI.config.security.trustProxy ?? false,
    routerOptions: {
      ignoreTrailingSlash: true
    }
  })
  WIKI.app = app
  WIKI.server = gracefulServer(app.server, {
    livenessEndpoint: '/_live',
    readinessEndpoint: '/_ready',
    kubernetes: Boolean(process.env.KUBERNETES_SERVICE_HOST)
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
  */
  app.register(fastifyWebsocket, { options: { maxPayload: 5242880 } })

  // ----------------------------------------
  // Handle graceful server shutdown
  // ----------------------------------------

  WIKI.server.on(gracefulServer.SHUTTING_DOWN, () => {
    WIKI.logger.info('Shutting down HTTP Server... [ STOPPING ]')
    WIKI.dbManager.unsubscribeFromNotifications()
    // -> Closes every editing socket with a going-away code, so the editors reconnect to whichever
    //    instance takes over rather than sitting on a dead connection
    WIKI.collab.shutdown()
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

  // -> Every setting below comes from the admin area's security view. They are read once, here, so a
  //    change takes effect on the next restart — the view says as much.
  const security = WIKI.config.security

  app.register(fastifyHelmet, {
    contentSecurityPolicy:
      security.enforceCsp && security.cspDirectives
        ? { directives: parseCspDirectives(security.cspDirectives), useDefaults: false }
        : false,
    strictTransportSecurity:
      security.enforceHsts && security.hstsDuration > 0
        ? {
            maxAge: security.hstsDuration,
            includeSubDomains: true
          }
        : false,
    // -> Helmet's own default is `sameorigin`, which is also what this setting turned off means
    xFrameOptions: { action: security.disallowIframe ? 'deny' : 'sameorigin' },
    referrerPolicy: security.enforceSameOriginReferrerPolicy
      ? { policy: 'same-origin' }
      : { policy: 'no-referrer' }
  })

  // -> One global registration rather than a separate policy for `/_api`: see the doc comment on
  //    `corsOptions()` for why the method list has to cover the full API CRUD surface even though
  //    this same registration also fronts asset-serving routes like `/_render` and `/_thumb`.
  app.register(fastifyCors, corsOptions(security))

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
    decorateReply: false
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

  // Fail closed rather than silently register the session/cookie plugins with a missing or
  // too-short secret -- see `helpers/authSecret.ts` for why this exists.
  assertValidAuthSecret(WIKI.config.auth.secret)

  // FIXME: `WIKI.config.auth.secret` is read once, here, at plugin registration — not re-read per
  // request the way `WIKI.config.auth.certs` is in `models/apiKeys.ts#verify`. That means
  // `models/sessions.ts#rotateSecret()` (verified under a real two-instance HA setup for task 589)
  // only stops working cookies on an instance once that instance is later restarted; every other
  // still-running instance keeps signing *new* cookies with the secret that was just invalidated, for
  // as long as it stays up. If the secret was rotated because it leaked, that gap is the whole point
  // of the action failing to close on a live instance. `WIKI.events.inbound` already carries
  // `reloadConfig` to every instance the moment the row saves — the missing piece is handing
  // @fastify/cookie / @fastify/session a secret they re-read (or re-registering the plugin) instead of
  // one captured by value here, and there is no instance registry (see `core/maintenance.ts`'s file
  // header) to prompt an operator to restart the others in the meantime.
  app.register(fastifyCookie, {
    secret: WIKI.config.auth.secret,
    hook: 'onRequest'
  })
  app.register(fastifySession, {
    secret: WIKI.config.auth.secret,
    cookieName: 'wikiSession',
    cookie: {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      secure: 'auto'
    },
    saveUninitialized: false,
    store: {
      async get(sessionId: string, clb: (err: any, result?: any) => void) {
        try {
          clb(null, await WIKI.models.sessions.get(sessionId))
        } catch (err: any) {
          clb(err, null)
        }
      },
      async set(sessionId: string, sessionData: any, clb: (err: any, result?: any) => void) {
        try {
          clb(null, await WIKI.models.sessions.set(sessionId, sessionData))
        } catch (err: any) {
          clb(err, null)
        }
      },
      async destroy(sessionId: string, clb: (err: any, result?: any) => void) {
        try {
          clb(null, await WIKI.models.sessions.destroy(sessionId))
        } catch (err: any) {
          clb(err, null)
        }
      }
    }
  })

  // ----------------------------------------
  // Cookie Security Diagnostic (task 833)
  // ----------------------------------------

  // -> Feeds `Security#observeRequest` so the admin area's security view can warn about the
  //    reverse-proxy cookie misconfiguration described on that method -- see its doc comment.
  //    Registered after the session cookie is parsed but does not depend on it; placement here is
  //    just "grouped with the rest of the cookie/session wiring it explains".
  app.addHook('onRequest', (req, reply, done) => {
    WIKI.models.security.observeRequest(req.headers, req.protocol)
    done()
  })

  // ----------------------------------------
  // API Routes
  // ----------------------------------------

  app.register(fastifySwagger, {
    hideUntagged: true,
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Wiki.js API',
        version: WIKI.version
      },
      components: {
        securitySchemes: OPENAPI_SECURITY_SCHEMES
      },
      security: OPENAPI_SECURITY
    },
    transform: ({ schema, url, route }: any) => {
      // Add permissions to the route schema description
      const permissions = route?.config?.permissions ?? []
      const transformedSchema = { ...schema }
      const currentDescription = transformedSchema.description || ''

      if (permissions?.length > 0) {
        const nestedPermissions: string[] = []
        for (const perm of permissions) {
          if (Array.isArray(perm)) {
            nestedPermissions.push(`\`${perm.join(' + ')}\``)
          } else {
            nestedPermissions.push(`\`${perm}\``)
          }
        }
        nestedPermissions.push('`manage:system`')
        transformedSchema.description =
          `${currentDescription}\n\n**Required Permissions:** ${uniq(nestedPermissions).join(' or ')}`.trim()
        transformedSchema['x-permissions'] = permissions
      } else if (route?.config?.publicAccess) {
        transformedSchema.description =
          `${currentDescription}\n\n**This API is public.** No special permissions required.`.trim()
      } else {
        /*
          No fixed permission is not the same as public, and saying so was wrong for most of these.
          A route without one is usually a route whose answer depends on the caller: the page rules of
          their groups, their own account, or the queue they happen to be a reviewer for. What it
          serves is scoped, not unrestricted.
        */
        transformedSchema.description =
          `${currentDescription}\n\n**No fixed permission.** What this returns, and what it acts on, is limited to what the caller is entitled to — their session, their groups' page rules, or their own account. A request that is entitled to nothing gets an empty answer or a refusal rather than an error about permissions.`.trim()
      }

      return { schema: transformedSchema, url }
    }
  })
  app.register(fastifySwaggerUi, {
    routePrefix: '/_api',
    /*
      Swagger UI's own sorters, applied in the browser: tags down the page, and the operations inside
      each tag by path. Neither is on by default — the order is otherwise the order the routes were
      registered in, which is meaningful to `api/index.ts` and arbitrary to anyone reading the docs.

      `operationsSorter: 'alpha'` sorts on the path, not the summary, so the several methods of one
      path stay together and keep their registration order relative to each other.
    */
    uiConfig: {
      tagsSorter: 'alpha',
      operationsSorter: 'alpha'
    },
    // -> Left empty so the plugin inlines neither its own logo nor one of ours; the stylesheet below
    //    is what puts the site's logo in the topbar
    logo: {} as any,
    theme: {
      css: [
        {
          filename: 'wiki.css',
          /*
            The site's own logo in the topbar, as a background on the link swagger draws its wordmark
            in.

            A stylesheet rather than the plugin's `logo` option, which takes a buffer and base64-inlines
            it into the page when the server boots. This documentation is served for whichever site the
            request arrived at, and an administrator can change that site's logo at any time — a URL
            resolves both of those per request, and a buffer chosen at boot resolves neither.

            `contain` in a box wider than it is tall, so a square mark and a wordmark both sit sensibly
            without the logo being distorted to fit.
          */
          content: `
            .swagger-ui .topbar-wrapper a.link > * {
              display: none;
            }
            .swagger-ui .topbar-wrapper a.link {
              display: block;
              width: 160px;
              height: 40px;
              background: url('/_site/current/logo') left center / contain no-repeat;
            }
          `
        }
      ]
    }
  })

  // ----------------------------------------
  // API Key Authentication
  // ----------------------------------------

  app.decorateRequest('apiKey', null)

  app.addHook('onRequest', async (req, reply) => {
    // -> Bearer tokens authenticate API calls only; everything else is cookie-authenticated. Note
    //    that the session is deliberately left untouched: writing to it would have @fastify/session
    //    persist a session row for every scraped request.
    if (!req.url.startsWith('/_api/')) {
      return
    }
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return
    }
    const token = header.slice('Bearer '.length).trim()
    if (!token) {
      return
    }
    try {
      req.apiKey = await WIKI.models.apiKeys.verify(token)
    } catch (err: any) {
      // -> Say why: the caller holds the credential and can act on "revoked" or "expired"
      WIKI.logger.debug(`Rejected an API key: ${err.message}`)
      return reply.unauthorized(err.message)
    }
    // -> Global, not per-route: a compromised key has to be caught on whichever endpoint it hits,
    //    not only the ones that remembered to attach a limiter. See helpers/rateLimit.ts for why
    //    this one specifically has no manage:system exemption.
    return limitApiKey(req, reply)
  })

  // ----------------------------------------
  // General API Rate Limit
  // ----------------------------------------

  app.addHook('onRequest', async (req, reply) => {
    // -> After the API-key hook above, so `req.apiKey` is populated for the key it builds its
    //    counter from. See `helpers/rateLimit.ts#limitApiRequests` for the key/exemption/double-count
    //    reasoning.
    if (!req.url.startsWith('/_api/')) {
      return
    }
    return limitApiRequests(req, reply)
  })

  // ----------------------------------------
  // API Key Site Pin
  // ----------------------------------------

  /*
    OpenProject #2189/#2194: `apiKeys.siteId` pins a key to one site, but only 2 of the 117
    `/sites/:siteId/...` routes ever checked it before this -- the other 115 evaluated the key's
    group rules against whatever `:siteId` the URL named, with nothing stopping a key deliberately
    narrowed to site A from reading, writing or deleting content on site B. One global preHandler
    covers the whole surface at once, rather than each route remembering its own call -- see
    `helpers/apiKeySite.ts`'s doc comments for the full reasoning and for the couple of routes that
    resolve their site from somewhere other than `req.params.siteId` and still have to call
    `enforceApiKeySite()` directly.
  */
  app.addHook('preHandler', apiKeySitePinPreHandler)

  // ----------------------------------------
  // Permissions
  // ----------------------------------------

  /*
    Global-vs-page-rule audit (task 551, Feature 377): every `session.permissions` /
    `apiKey.permissions` read under `backend/` was re-grepped and confirmed to check a genuinely-global
    permission name (this hook's own `routePermissions`, `models/users.ts`'s login flattening,
    `models/approvals.ts`, `api/navigation.ts`'s `canManageNavigation()`, `controllers/terminal.ts`,
    `helpers/rateLimit.ts`, `models/groups.ts`'s `actorForRequest()`, `api/users.ts`'s `whoAmI()`), not
    one of the fourteen page-rule `PAGE_PERMISSIONS` strings — those may only be decided by
    `groups.checkAccess()` / `mayOnPage()` against a page's rules. One further instance turned up in
    this pass and was fixed here: `api/pages.ts`'s search route was scanning the GLOBAL list for
    `write:pages`/`manage:pages`, which a group's `permissions` column never legitimately carries — see
    `models/groups.ts`'s `mayHoldPermissionSomewhere()`. A future permission check added near any of
    the above should keep asking the same question this comment does, not assume `session.permissions`
    covers page-scoped names.
  */
  app.addHook('preHandler', (req, reply, done) => {
    const routePermissions = req.routeOptions.config?.permissions
    if (routePermissions && routePermissions.length > 0) {
      // -> A verified API key stands in for a session, carrying the permissions of the groups it was
      //    issued for
      const permissions = req.apiKey
        ? req.apiKey.permissions
        : req.session?.authenticated
          ? req.session.permissions
          : null
      // Unauthenticated / No Permissions
      if (!permissions || permissions.length < 1) {
        return reply.unauthorized()
      }
      // Is Root Admin?
      if (!permissions.includes('manage:system')) {
        // Check for at least 1 permission
        const isAllowed = routePermissions.some((perms) => {
          // Check for all permissions
          if (Array.isArray(perms)) {
            return perms.every((perm) => permissions.some((p) => p === perm))
          } else {
            return permissions.some((p) => p === perms)
          }
        })
        // Forbidden
        if (!isAllowed) {
          return reply.forbidden()
        }
      }
    }
    done()
  })

  // ----------------------------------------
  // SEO
  // ----------------------------------------

  app.addHook('onRequest', (req, reply, done) => {
    const [urlPath, urlQuery] = req.raw.url!.split('?')
    const withQuery = (newPath: string) => (urlQuery ? `${newPath}?${urlQuery}` : newPath)

    const trimmed = urlPath!.length > 1 && urlPath!.endsWith('/') ? urlPath!.slice(0, -1) : urlPath!

    if (isPageUrl(trimmed)) {
      // -> Straight off the site caches rather than through the model: this runs on every request, and
      //    both lookups are the ones `getSiteByHostname` would do, minus its optional reload
      const siteId = WIKI.sitesMappings[normalizeHostname(req.hostname)] || WIKI.sitesMappings['*']
      const siteConfig = WIKI.sites[siteId]?.config
      const withoutExtension = stripPageExtension(trimmed, siteConfig?.pageExtensions)
      if (withoutExtension) {
        // -> Answers a trailing slash as well, rather than sending the client back for a second
        //    round trip to be told about the extension.
        //
        //    Not a 301: which extensions resolve this way is a setting, and a browser that cached a
        //    permanent redirect would go on applying it after an administrator had changed it
        reply.redirect(withQuery(withoutExtension), 302)
        return
      }

      // -> `SERVER_ROUTE_SEGMENTS` and `RESERVED_ROOT_FILES` are already excluded by `isPageUrl`
      //    above, so a locale code can never collide with one of those first segments here.
      const localeRedirect = localePrefixRedirectTarget(trimmed, siteConfig?.locales)
      if (localeRedirect) {
        // -> Same reasoning as the extension redirect above: `forcePrefix` is a setting, not a
        //    permanent fact about the URL, so a 301 here would outlive an admin turning it off.
        reply.redirect(withQuery(localeRedirect), 302)
        return
      }

      // -> The mirror image: an explicit prefix the site's rules leave bare (`/en/page`) 302s to
      //    the one canonical URL (`/page`), and a mis-cased prefix re-cases. 302 for the same
      //    reason as above — which locales are active, and forcePrefix, are settings.
      const localeStrip = localePrefixStripTarget(trimmed, siteConfig?.locales)
      if (localeStrip) {
        reply.redirect(withQuery(localeStrip), 302)
        return
      }
    }

    if (trimmed !== urlPath) {
      reply.redirect(withQuery(trimmed), 301)
      return
    }

    done()
  })

  app.register(fastifyFormBody, {
    bodyLimit: 1048576 // 1mb
  })

  // ----------------------------------------
  // Site Resolution
  // ----------------------------------------

  app.decorateRequest('site', null)

  app.addHook('onRequest', (req, reply, done) => {
    const urlPath = req.raw.url!.split('?')[0]!
    const trimmed = urlPath.length > 1 && urlPath.endsWith('/') ? urlPath.slice(0, -1) : urlPath

    // -> Not in scope for the server's own routes, static assets, etc. — see `isPageUrl`
    if (!isPageUrl(trimmed)) {
      return done()
    }

    const firstSegment = trimmed.split('/')[1] ?? ''
    const resolution = resolveRequestSite({
      firstSegment,
      hostname: req.hostname,
      sitesMappings: WIKI.sitesMappings,
      sites: WIKI.sites,
      exemptSegments: SITE_RESOLUTION_EXEMPT_SEGMENTS
    })

    switch (resolution.outcome) {
      case 'exempt':
        return done()
      case 'ok':
        req.site = resolution.site
        return done()
      case 'disabled':
        // -> Distinguishable from "not-found" below: this hostname does address a real site, it is
        //    just switched off, which is a different message (and a different fix) for whoever hits it
        req.site = resolution.site
        // -> A 302, not a 301: `isEnabled` is a setting an administrator can flip back, and a browser
        //    that cached a permanent redirect would keep bouncing here after they did
        reply.redirect('/_error/disabled', 302)
        return
      case 'not-found':
        reply.redirect('/_error/unknownsite', 302)
        return
    }
  })

  // ----------------------------------------
  // Routing
  // ----------------------------------------

  app.register(import('./api/index.ts'), { prefix: '/_api' })
  app.register(import('./controllers/blocks.ts'), { prefix: '/_blocks/custom' })
  app.register(import('./controllers/collab.ts'), { prefix: '/_collab' })
  app.register(import('./controllers/files.ts'), { prefix: '/_files' })
  app.register(import('./controllers/site.ts'), { prefix: '/_site' })
  app.register(import('./controllers/icons.ts'), { prefix: '/_icons' })
  // -> The MCP server's HTTP/SSE transport (`mcp/http.ts`) — see that file's doc comment for the
  //    session/auth model. `mcp/stdio.ts` is the other transport, run as its own OS process.
  app.register(import('./mcp/http.ts'), { prefix: '/_mcp' })
  // -> Deliberate exception to the leading-underscore convention every other line here follows:
  //    Prometheus scrapes a fixed, unprefixed `/metrics`. See `controllers/metrics.ts` for the full
  //    scope decision (task 594).
  app.register(import('./controllers/metrics.ts'), { prefix: '/metrics' })
  app.register(import('./controllers/render.ts'), { prefix: '/_render' })
  // -> No prefix: `/robots.txt` and `/sitemap.xml` are root-level files, not part of the `_`-prefixed
  //    server namespace the rest of these occupy. See `RESERVED_ROOT_FILES` / `isPageUrl()` above.
  app.register(import('./controllers/seo.ts'))
  app.register(import('./controllers/terminal.ts'), { prefix: '/_terminal' })
  app.register(import('./controllers/thumb.ts'), { prefix: '/_thumb' })
  app.register(import('./controllers/user.ts'), { prefix: '/_user' })

  // ----------------------------------------
  // App Shell
  // ----------------------------------------

  const appShellPath = path.join(WIKI.ROOTPATH, 'assets/index.html')

  /*
    The compiled SPA, for every path no route above claimed.

    It has to be the fallback rather than a route of its own: a wiki page lives at any path a user cares
    to give it, and the frontend's router -- not this server -- is what resolves one. Which is also why
    the only paths held back are the segments the server itself mounts, so a mistyped `/_api/...` still
    answers as the API rather than handing back a page of HTML, and the root files a crawler asks for by
    convention, which are absent here rather than being the app.

    `no-store`: the bundles this pulls in are hashed and immutable under `/_assets`, but the document
    naming them must never be held, or a rebuilt frontend would keep booting the previous one. Read per
    request for the same reason -- `npm run build` while the server is up should be enough. It also
    means a cache never has to be told the templated `lang`/`dir` below vary per site, since nothing
    is cached at all.

    `lang`/`dir` are filled in here rather than left to `App.vue` (which also sets them, from
    `siteStore.locales`, the moment it boots): that only happens once its JS has loaded, parsed and
    run, so an RTL locale would flash LTR for however long that takes. Templating them into the shell
    itself closes that window -- see `helpers/appShell.ts`.
  */
  app.setNotFoundHandler(async (req, reply) => {
    const [urlPath, urlSearch] = req.raw.url!.split('?')
    const firstSegment = urlPath!.split('/')[1] ?? ''
    const isSystemPath = SERVER_ROUTE_SEGMENTS.has(firstSegment)
    const isReservedRootFile = RESERVED_ROOT_FILES.has(firstSegment.toLowerCase())
    // -> HEAD as well as GET: it has to answer what GET would, or a monitor pointed at the wiki reads a
    //    404 for a page the browser beside it loads. Node drops the body for HEAD on its own.
    const isReadRequest = req.method === 'GET' || req.method === 'HEAD'
    if (!isReadRequest || isSystemPath || isReservedRootFile) {
      return reply.notFound()
    }
    try {
      const shell = await readFile(appShellPath, 'utf8')
      // -> Same site resolution as the SEO hook above: straight off the caches, since this also
      //    runs on every request that reaches the shell.
      const siteId = WIKI.sitesMappings[normalizeHostname(req.hostname)] || WIKI.sitesMappings['*']
      const siteConfig = WIKI.sites[siteId]?.config
      const lang = resolveAppShellLocale(urlPath!, urlSearch, siteConfig?.locales)
      const locales = await WIKI.models.locales.getLocales()
      const isRTL = locales.find((l: any) => l.code === lang)?.isRTL ?? false
      const templated = templateAppShell(shell, { lang, isRTL })
      return reply
        .header('Cache-Control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(templated)
    } catch (err: any) {
      // -> Nothing to serve means the frontend was never built, which is a setup step rather than a
      //    fault of this request: say which one, since a bare 500 sends people looking in the server
      WIKI.logger.error(`Cannot serve the app shell from ${appShellPath}: ${err.message}`)
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send('The frontend has not been built yet. Run `npm run build` in frontend/.\n')
    }
  })

  // ----------------------------------------
  // Error handling
  // ----------------------------------------

  app.setErrorHandler((error: any, req, reply) => {
    if (req.url.includes('/_api/')) {
      if (error.statusCode) {
        reply.code(error.statusCode).type('application/json').send({
          ok: false,
          error: error.name,
          statusCode: error.statusCode,
          message: error.message
        })
      } else {
        WIKI.logger.warn(error)
        reply.code(500).type('application/json').send({
          ok: false,
          error: 'Internal Server Error',
          statusCode: 500,
          message: 'Internal Server error'
        })
      }
    } else {
      reply.send(error)
    }
  })

  // ----------------------------------------
  // Bind HTTP Server
  // ----------------------------------------

  try {
    WIKI.logger.info(`Starting HTTP Server on port ${WIKI.config.port} [ STARTING ]`)
    await app.listen({ port: WIKI.config.port, host: WIKI.config.bindIP })
    WIKI.logger.info('HTTP Server: [ RUNNING ]')
    WIKI.server.setReady()
  } catch (err: any) {
    WIKI.logger.error(err)
    process.exit(1)
  }
}

// ----------------------------------------
// Register exit handler
// ----------------------------------------

// process.on('SIGINT', () => {
//   WIKI.kernel.shutdown()
// })
// process.on('message', (msg) => {
//   if (msg === 'shutdown') {
//     WIKI.kernel.shutdown()
//   }
// })

// ----------------------------------------
// Initialization Sequence
// ----------------------------------------

await preBoot()
await initHTTPServer()
await postBoot()
