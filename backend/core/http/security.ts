import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyHelmet from '@fastify/helmet'

import { corsOptions, inlineScriptHashSources, parseCspDirectives } from '../../helpers/security.ts'

/**
 * Helmet (CSP, HSTS, frame options, referrer policy) and CORS.
 *
 * Every setting below comes from the admin area's security view. They are read once, here, so a
 * change takes effect on the next restart — the view says as much.
 */
export function registerSecurity(app: FastifyInstance): void {
  const security = WIKI.config.security

  /*
    The app shell (`assets/index.html`, served by `helpers/appShell.ts`) always ships two inline
    `<script>` blocks with no `src` -- the Temporal-polyfill feature-detect check and
    `temporalPolyfillChunkPlugin`'s substituted chunk-url assignment (see both files' own comments) --
    which a `script-src 'self'` policy with no `'unsafe-inline'` (`base.yml`'s own shipped
    `cspDirectives` default) refuses outright. `inlineScriptHashSources` turns their exact, built
    content into the hash sources that let them through without loosening the policy for anything
    else. Read once here rather than per-request, matching every other setting in this registration:
    the app shell is a build artifact, so a rebuilt frontend needs the same restart a changed
    `cspDirectives` value already does. Missing entirely (no `npm run build` yet, e.g. a fresh dev
    checkout) just means no hash sources -- CSP still registers, the app shell's own inline scripts
    are the only thing that would trip it.
  */
  const cspDirectives =
    security.enforceCsp && security.cspDirectives
      ? parseCspDirectives(security.cspDirectives)
      : null
  if (cspDirectives?.['script-src']) {
    const cspAppShellPath = path.join(WIKI.ROOTPATH, 'assets/index.html')
    if (existsSync(cspAppShellPath)) {
      const appShellHtml = readFileSync(cspAppShellPath, 'utf8')
      cspDirectives['script-src'] = [
        ...cspDirectives['script-src'],
        ...inlineScriptHashSources(appShellHtml)
      ]
    }
  }

  app.register(fastifyHelmet, {
    contentSecurityPolicy: cspDirectives
      ? { directives: cspDirectives, useDefaults: false }
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
}
