#!/usr/bin/env node
// Drives an already-running instance's own REST API to force a genuine headless Chromium PDF export,
// then confirms the response is a real PDF. Its sibling `verify-sandboxed-puppeteer.sh` builds the
// image and boots the instance this script is pointed at.
//
// Chromium's own process sandbox is an in-container concern this script cannot observe from outside,
// so a returned PDF stands in for it: with `security.allowPuppeteerNoSandbox` left at its `base.yml`
// default of false, `helpers/puppeteer.ts#getPuppeteerLaunchArgs()` launches with no `--no-sandbox`
// fallback and a sandbox-init failure kills the browser process outright. The sibling script
// separately checks the container's logs never carried the `--no-sandbox` warning.

const baseUrl = process.argv[2]
if (!baseUrl) {
  console.error('Usage: node dev/build/verify-sandboxed-puppeteer.mjs <base-url>')
  process.exit(1)
}

/**
 * The name depends on `security.cookieSecure` (`helpers/security.ts#sessionCookieName`):
 * `__Host-wikiSession` at the production default, `wikiSession` under the plain-HTTP
 * `config.verify.yml` overlay. Matching either is simpler than importing the real logic here.
 */
const SESSION_COOKIE_NAMES = ['__Host-wikiSession', 'wikiSession']

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com'
const ADMIN_PASS = process.env.ADMIN_PASS
if (!ADMIN_PASS) {
  console.error('ADMIN_PASS must be set to the password the container was booted with.')
  process.exit(1)
}

/** The same-origin check on state-changing requests
 * (`helpers/security.ts#shouldBlockCrossOriginApiRequest`) refuses a request carrying a session
 * cookie and no `Origin`, which is what a bare `fetch` sends. */
const origin = new URL(baseUrl).origin

/** This script's own cookie jar: `fetch` does not persist `Set-Cookie` between calls. */
let sessionCookie

function withCookie(headers = {}) {
  return sessionCookie ? { ...headers, cookie: sessionCookie } : headers
}

function captureCookie(res) {
  // -> `Headers#get('set-cookie')` folds multiple Set-Cookie headers into one comma-joined string,
  //    which is unparseable when a cookie's own `Expires` attribute contains a comma.
  //    `getSetCookie()` returns each raw header separately instead.
  const setCookies = res.headers.getSetCookie?.() ?? []
  const sessionSet = setCookies.find((c) =>
    SESSION_COOKIE_NAMES.some((name) => c.startsWith(`${name}=`))
  )
  if (sessionSet) {
    sessionCookie = sessionSet.split(';')[0]
  }
}

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}/_api${path}`, {
    method,
    headers: withCookie({
      'content-type': 'application/json',
      origin,
      accept: 'application/json'
    }),
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  captureCookie(res)
  return res
}

async function main() {
  console.log(`==> Reading site info from ${baseUrl} ...`)
  const bootstrap = await (await api('GET', '/bootstrap')).json()
  const siteId = bootstrap?.site?.id
  if (!siteId) {
    throw new Error(
      `Could not read a site id from the bootstrap response: ${JSON.stringify(bootstrap)}`
    )
  }
  console.log(`    site id: ${siteId}`)

  console.log('==> Finding the local auth strategy ...')
  const strategies = await (await api('GET', `/sites/${siteId}/auth/strategies`)).json()
  const localStrategy = strategies.find((s) => s.activeStrategy?.strategy?.key === 'local')
  if (!localStrategy) {
    throw new Error(`No local auth strategy found: ${JSON.stringify(strategies)}`)
  }

  console.log(`==> Logging in as ${ADMIN_EMAIL} ...`)
  const loginRes = await api('PUT', `/sites/${siteId}/auth/login`, {
    strategyId: localStrategy.id,
    username: ADMIN_EMAIL,
    password: ADMIN_PASS
  })
  const loginBody = await loginRes.json()
  if (!loginRes.ok || !loginBody.authenticated) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginBody)}`)
  }
  if (!sessionCookie) {
    throw new Error('Login reported success but set no session cookie.')
  }
  console.log('    logged in')

  console.log('==> Creating a page to export ...')
  const path = `sandboxed-puppeteer-verify-${Date.now()}`
  const createRes = await api('POST', `/sites/${siteId}/pages`, {
    path,
    title: 'Sandboxed Puppeteer verification',
    editor: 'markdown',
    content: '# Sandboxed Puppeteer verification\n\nOpenProject #3214.',
    // -> Supplied explicitly so page creation never launches Puppeteer itself
    //    (`models/pages.ts#createPage`'s `ensureCanRender` guard only fires with no `render` given),
    //    leaving the export below as the one browser launch this measures.
    render: '<h1>Sandboxed Puppeteer verification</h1><p>OpenProject #3214.</p>',
    publishState: 'published'
  })
  const createBody = await createRes.json()
  if (!createRes.ok || !createBody.page?.id) {
    throw new Error(`Page creation failed: ${createRes.status} ${JSON.stringify(createBody)}`)
  }
  const pageId = createBody.page.id
  console.log(`    page id: ${pageId} (path: ${path})`)

  console.log('==> Requesting the PDF export (this is the real sandboxed Chromium launch) ...')
  const exportRes = await fetch(`${baseUrl}/_api/sites/${siteId}/pages/${pageId}/export/pdf`, {
    headers: withCookie({ origin, accept: 'application/pdf' })
  })
  if (!exportRes.ok) {
    const errBody = await exportRes.text()
    throw new Error(`PDF export failed: ${exportRes.status} ${errBody}`)
  }
  const pdfBytes = Buffer.from(await exportRes.arrayBuffer())
  const magic = pdfBytes.subarray(0, 5).toString('latin1')
  if (magic !== '%PDF-') {
    throw new Error(
      `Export succeeded (${exportRes.status}) but the response is not a PDF (magic bytes: ${JSON.stringify(magic)}, ${pdfBytes.length} bytes).`
    )
  }

  console.log(
    `PASS: exported a real PDF (${pdfBytes.length} bytes, magic bytes ${JSON.stringify(magic)}).`
  )
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`)
  process.exit(1)
})
