import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import OidcAuthentication from './authentication.ts'

/**
 * `authorizationUrl` is exercised for real here (no `OidcAuthentication.prototype` mocking) via the
 * `useDiscovery: false` branch of `configuration()`, which builds a `client.Configuration` directly
 * from the endpoints given rather than fetching a discovery document — so this needs no network and
 * still runs the actual `openid-client` `buildAuthorizationUrl` call.
 */
describe('OidcAuthentication#authorizationUrl', () => {
  const manualConf = {
    clientId: 'abc',
    clientSecret: 'xyz',
    issuer: 'https://issuer.example',
    useDiscovery: false,
    authorizationURL: 'https://issuer.example/authorize',
    tokenURL: 'https://issuer.example/token',
    jwksURL: 'https://issuer.example/jwks'
  }
  const flow = {
    redirectUri: 'https://wiki.example/_api/auth/strategy-1/callback',
    state: 's',
    nonce: 'n',
    codeVerifier: 'v'
  }

  test('carries no extra query params when the config sets none', async () => {
    const auth = new OidcAuthentication('strategy-1', manualConf)
    const url = new URL(await auth.authorizationUrl(flow))
    assert.equal(url.searchParams.get('claims'), null)
  })

  test('extraAuthParams from conf are merged onto the built authorization URL', async () => {
    const claims = JSON.stringify({ id_token: { email: null }, userinfo: { email: null } })
    const auth = new OidcAuthentication('strategy-1', {
      ...manualConf,
      extraAuthParams: { claims }
    })
    const url = new URL(await auth.authorizationUrl(flow))
    assert.equal(url.searchParams.get('claims'), claims)
    // -> The generic params this module has always sent are still present alongside it
    assert.equal(url.searchParams.get('redirect_uri'), flow.redirectUri)
    assert.equal(url.searchParams.get('state'), flow.state)
  })
})
