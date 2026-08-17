import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Regression guard for the AdminSsl.vue removal (Task 599, Feature 388).
 *
 * `AdminSsl.vue` was unrouted dead code: a pre-migration Options-API/Pug page wired to
 * `$apollo.mutate` calls (`system.setHTTPSRedirection`, `system.renewHTTPSCertificate`) that have no
 * backend implementation, reachable only through a `disabled` nav item this file rendered behind
 * `flagsStore.experimental` -- `frontend/src/router/routes.js` never defined an `ssl` route, so the
 * link never resolved to anything even with the flag on.
 *
 * 3.0's TLS posture is termination at a reverse proxy/ingress (see the `trustProxy` setting in
 * `AdminSecurity.vue` and the Docker/Helm assets under `dev/`), not in-app certificate management --
 * so the page, its nav entry, and its locale strings were deleted outright rather than rebuilt, per
 * this repo's CLAUDE.md ("change the shape, change the callers, and delete the old path"). These
 * assertions exist to keep that dead surface from quietly growing back.
 */

const adminLayoutPath = join(import.meta.dirname, 'AdminLayout.vue')
const adminSslPagePath = join(import.meta.dirname, '../pages/AdminSsl.vue')
const sslIconPath = join(import.meta.dirname, '../../public/_assets/icons/fluent-security-ssl.svg')
const localesPath = join(import.meta.dirname, '../../../backend/locales/en.json')

describe('AdminLayout SSL dead-code removal', () => {
  it('does not reference the removed /_admin/ssl route or AdminSsl.vue', () => {
    const source = readFileSync(adminLayoutPath, 'utf-8')
    expect(source).not.toContain('/_admin/ssl')
    expect(source).not.toContain('admin.ssl.')
    expect(source).not.toContain('fluent-security-ssl')
  })

  it('no longer ships frontend/src/pages/AdminSsl.vue', () => {
    expect(existsSync(adminSslPagePath)).toBe(false)
  })

  it('no longer ships the now-unreferenced SSL nav icon asset', () => {
    expect(existsSync(sslIconPath)).toBe(false)
  })

  it('no longer carries any admin.ssl.* locale keys', () => {
    const locales = JSON.parse(readFileSync(localesPath, 'utf-8'))
    const sslKeys = Object.keys(locales).filter((key) => key.startsWith('admin.ssl.'))
    expect(sslKeys).toEqual([])
  })
})
