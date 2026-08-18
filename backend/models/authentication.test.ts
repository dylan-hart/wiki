import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { authentication } from './authentication.ts'

/**
 * `refreshStrategiesFromDisk()` reads real `definition.yml` files under `modules/authentication/` —
 * no database involved — so this is a pure unit test against the actual files shipped in this repo,
 * not a mock of them. It exists to catch exactly the gap an integration pass is for: a redirect-based
 * module (SAML, CAS) that never declares the `refs` block telling an administrator what URL to
 * register with the provider, mirroring the `refs.callbackUrl` convention every other redirect-based
 * module (Google, GitHub, OIDC) already follows. A form-based module (LDAP) has no callback URL at
 * all, so it correctly declares no `refs`.
 */

// -> A minimal WIKI global: `refreshStrategiesFromDisk()` only touches SERVERPATH, logger and data.
;(globalThis as any).WIKI = {
  SERVERPATH: path.join(import.meta.dirname, '..'),
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  data: {}
}

describe('authentication module definitions: refs guidance', () => {
  test('SAML declares an ACS URL ref pointing at the shared callback route', async () => {
    await authentication.refreshStrategiesFromDisk()
    const mod = authentication.getModule('saml')
    assert.ok(mod, 'saml module definition should load from disk')
    assert.ok(mod!.refs?.acsUrl, 'saml should declare a refs.acsUrl entry')
    assert.equal(mod!.refs!.acsUrl.value, '{host}/_api/auth/{id}/callback')
  })

  test('CAS declares a service URL ref pointing at the shared callback route', async () => {
    await authentication.refreshStrategiesFromDisk()
    const mod = authentication.getModule('cas')
    assert.ok(mod, 'cas module definition should load from disk')
    assert.ok(mod!.refs?.serviceUrl, 'cas should declare a refs.serviceUrl entry')
    assert.equal(mod!.refs!.serviceUrl.value, '{host}/_api/auth/{id}/callback')
  })

  test('LDAP declares no refs at all — it is form-based, with no callback URL to register', async () => {
    await authentication.refreshStrategiesFromDisk()
    const mod = authentication.getModule('ldap')
    assert.ok(mod, 'ldap module definition should load from disk')
    assert.ok(!mod!.refs, 'ldap should not declare a refs block')
  })
})
