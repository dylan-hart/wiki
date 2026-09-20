import crypto from 'node:crypto'
import { isValidUuid } from '../helpers/common.ts'
import { guardSiteEnabled } from '../helpers/siteResolution.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import { requireReadablePage } from '../helpers/pageAccess.ts'
import type { FastifyInstance } from 'fastify'

/**
 * `immutable` because the frontend appends the page's `updatedAt` as `?v=`
 * (`composables/pageScripts.js`), so an edit mints a new URL. `private`, not `public`: the reply
 * depends on `read:pages` for this requester on this page, so a shared cache must never hand one
 * reader's copy to the next.
 */
const PAGE_SCRIPT_CACHE = 'private, max-age=31536000, immutable'

/**
 * Wraps a page's `scriptJsLoad`/`scriptJsUnload` as a module the frontend can `import()` and call:
 * the shipped `script-src 'self'` (`core/http/security.ts`) allows a same-origin file like this one,
 * but never an inline `<script>` or a `new Function(...)` eval of the stored text.
 */
function wrapPageScript(jsLoad: string, jsUnload: string): string {
  const exportedFns: string[] = []
  if (jsLoad) {
    exportedFns.push(`export function load() {\n${jsLoad}\n}`)
  }
  if (jsUnload) {
    exportedFns.push(`export function unload() {\n${jsUnload}\n}`)
  }
  return exportedFns.length > 0 ? `${exportedFns.join('\n\n')}\n` : ''
}

/**
 * Hostname-resolved and reachable without a session, but not unguarded. Two independent gates, the
 * cheap one first: `features.pageScripts` is the site-wide execution kill switch -- holding
 * `write:scripts` never lets a script run while it is off -- then `read:pages` on the page itself,
 * since a script is part of a page's content.
 *
 * `allowLocked: true`: `models/pages.ts#toPage()` already blanks both fields for a locked page, so it
 * is answered with 200 and an empty body rather than needing a second locked-page code path here.
 *
 * No `enforceApiKeySite()` call: `requireReadablePage` goes through `groups.checkAccess()`, which
 * applies an API key's site pin itself. That relies on this prefix being in
 * `helpers/apiKeySite.ts`'s `BEARER_AUTH_PREFIXES` -- without it `req.apiKey` is never populated here
 * and the pin check is a silent no-op.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { pageId: string } }>('/:pageId/script.js', async (req, reply) => {
    if (!isValidUuid(req.params.pageId)) {
      return reply.notFound('Page not found')
    }

    const site = await CARDINAL.models.sites.getSiteByHostname({ hostname: req.hostname })
    if (!site) {
      return reply.notFound('Page not found')
    }
    if (guardSiteEnabled(site, reply)) {
      return reply
    }

    if (!site.config?.features?.pageScripts) {
      return reply.forbidden('Page scripts are disabled for this site.')
    }

    const page = await requireReadablePage(req, reply, site.id, req.params.pageId, {
      allowLocked: true
    })
    if (!page) {
      return reply
    }

    const body = wrapPageScript(page.scriptJsLoad ?? '', page.scriptJsUnload ?? '')
    const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`
    if (notModifiedOrPrepare(req, reply, { etag, cacheControl: PAGE_SCRIPT_CACHE })) {
      return reply
    }

    return reply.type('application/javascript; charset=utf-8').send(body)
  })
}

export default routes
