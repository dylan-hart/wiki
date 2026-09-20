import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyHelmet from '@fastify/helmet'

import { corsOptions, inlineScriptHashSources, parseCspDirectives } from '../../helpers/security.ts'

/**
 * Every setting below comes from the admin area's security view and is read once, here, so a
 * change takes effect on the next restart.
 */
export function registerSecurity(app: FastifyInstance): void {
  const security = CARDINAL.config.security

  /*
    The app shell (`assets/index.html`) ships inline `<script>` blocks, which a `script-src 'self'`
    policy with no `'unsafe-inline'` refuses outright. `inlineScriptHashSources` turns their exact,
    built content into hash sources that let them through without loosening the policy for anything
    else. Read once rather than per request: the app shell is a build artifact, so a rebuilt
    frontend needs the same restart a changed `cspDirectives` does. A missing file (no build yet)
    just means no hash sources.
  */
  const cspDirectives =
    security.enforceCsp && security.cspDirectives
      ? parseCspDirectives(security.cspDirectives)
      : null
  if (cspDirectives?.['script-src']) {
    const cspAppShellPath = path.join(CARDINAL.ROOTPATH, 'assets/index.html')
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

  app.register(fastifyCors, corsOptions(security))
}
