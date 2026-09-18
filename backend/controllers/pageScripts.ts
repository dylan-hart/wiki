import crypto from 'node:crypto'
import { isValidUuid } from '../helpers/common.ts'
import { guardSiteEnabled } from '../helpers/siteResolution.ts'
import { notModifiedOrPrepare } from '../helpers/httpCache.ts'
import { requireReadablePage } from '../helpers/pageAccess.ts'
import type { FastifyInstance } from 'fastify'

/**
 * Content-addressed by the `?v=` the frontend appends (`composables/pageScripts.js` uses the page's
 * own `updatedAt`) -- a fresh edit mints a new URL, so the previous one's bytes never need to change
 * out from under a cached copy. `private`, not `public`: unlike a custom block (`controllers/blocks.ts`),
 * what comes back here depends on `read:pages` for THIS requester on THIS page, so a shared cache
 * holding one reader's copy must never hand it to the next reader along -- the same reasoning
 * `controllers/thumb.ts`'s `THUMB_CACHE` documents, just with `immutable` added since the URL itself
 * changes whenever the content would.
 */
const PAGE_SCRIPT_CACHE = 'private, max-age=31536000, immutable'

/**
 * Wraps a page's `scriptJsLoad`/`scriptJsUnload` as a module the frontend can `import()` and call —
 * the CSP-aware mechanism Feature #3389's spec bullet calls for ("stored scripts are served as
 * external same-origin files"): `script-src 'self'` (the shipped default, `core/http/security.ts`)
 * allows a same-origin file like this one, but never an inline `<script>` or a `new Function(...)`
 * eval of the stored text.
 *
 * Either field, or both, may be blank — an author who only wants a load hook, or only a cleanup one,
 * writes just that field, and a page with neither (the common case, and every locked page once
 * `models/pages.ts#toPage()` has blanked both) gets an empty string back rather than a module with two
 * empty function bodies.
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
 * _pages Routes
 *
 * `GET /_pages/:pageId/script.js` -- the JS half of per-page scripts (OpenProject #3389/#3405), the
 * CSS half's sibling in `controllers/thumb.ts`'s style of hostname-resolved, unauthenticated-reachable
 * route (no session required, but not unguarded either).
 *
 * Two independent gates, checked in this order because the first is cheap and the second is not:
 * `features.pageScripts` is the site-wide execution kill switch (Task #3403; off by default) -- a
 * page's own author having `write:scripts` never lets a script run when the site has this off, the
 * same "authoring is not the same as executing" split `helpers/htmlSanitizePolicy.ts`'s
 * `RenderPermissions` draws for inline HTML. Then `read:pages` on the page itself, via
 * `helpers/pageAccess.ts#requireReadablePage` -- a script is part of a page's content, so whoever may
 * not read the page may not run its script either.
 *
 * `allowLocked: true`: a locked page is not refused outright the way an ordinary unreadable page is
 * (`requireReadablePage`'s default 403). It is answered with 200 and an empty body instead, because
 * `models/pages.ts#toPage()` already blanks `scriptJsLoad`/`scriptJsUnload` to `''` for a locked page
 * (the same treatment `render`/`toc` get) -- `wrapPageScript` on two empty strings is itself `''`, so
 * there is no second locked-page code path to write here at all.
 *
 * No `enforceApiKeySite()` call: `requireReadablePage` runs `mayOnPage()` through
 * `CARDINAL.models.groups.checkAccess()`, which folds an API key's own site pin in before any rule is
 * even consulted -- the same reasoning `controllers/thumb.ts`'s `mayOnAsset()` call documents. That
 * only works because this prefix is also in `helpers/apiKeySite.ts#BEARER_AUTH_PREFIXES` -- without
 * it, `index.ts`'s Bearer-verification hook would never populate `req.apiKey` here at all (OpenProject
 * #2339), and the site-pin check above would be a silent no-op for every API-key caller.
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
