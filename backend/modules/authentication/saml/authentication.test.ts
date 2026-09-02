import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { after, before, test } from 'node:test'
import SamlAuthentication from './authentication.ts'
import { installTestWiki } from '../../../test/mocks.ts'
// -> A deep import into `@node-saml/node-saml`'s own compiled output, not the package's public entry
//    point: `signXml` is the low-level XML-signing primitive its own test suite uses to build signed
//    fixtures, and is the most direct way to hand this suite a genuinely, cryptographically signed
//    SAMLResponse to validate against — rather than a hand-typed one that only looks like one.
import { signXml } from '@node-saml/node-saml/lib/xml.js'

/**
 * This module talks SAML to a real identity provider, so — per the task's own suggestion — this suite
 * stands up a throwaway self-signed certificate (via `openssl`, the same tool a real deployment's own
 * admin would use) as a one-off test IdP, and signs its own SAMLResponse fixtures against it. What is
 * exercised is genuinely `@node-saml/node-saml`'s signature/audience/clock-skew validation — not a
 * mock standing in for it — covering exactly the four scenarios the task calls out: a valid assertion
 * with claim extraction, a tampered one, an expired one, and both AuthnRequest bindings.
 */

let tmpDir: string
let certPem: string
let keyPem: string

before(() => {
  installTestWiki({ models: { flags: { authDebug: () => {} } } })
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-saml-test-'))
  const keyPath = path.join(tmpDir, 'idp-key.pem')
  const certPath = path.join(tmpDir, 'idp-cert.pem')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=wiki-test-idp'
  ])
  keyPem = fs.readFileSync(keyPath, 'utf8')
  certPem = fs.readFileSync(certPath, 'utf8')
})

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const AUDIENCE = 'urn:wiki:test'
const ASSERTION_XPATH =
  '//*[local-name(.)="Assertion" and namespace-uri(.)="urn:oasis:names:tc:SAML:2.0:assertion"]'

/**
 * Stands in for the id `api/auth/provider.ts`'s `/auth/:strategyId/authorize` route would have
 * generated and carried on `req.session.authFlow` — every fixture below is signed as if it were
 * answering an AuthnRequest with this `InResponseTo`, and every `profile()` call hands the matching
 * `authnRequestId` back, the same round trip the real callback route performs.
 */
const REQUEST_ID = '_test-authn-request-1'

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z')
}

/** A hand-built, unsigned SAMLResponse, with a full attribute statement and a controllable validity window. */
function buildResponseXml({
  notBefore,
  notOnOrAfter,
  issueInstant,
  audience = AUDIENCE,
  nameId = 'alice@example.com',
  groups = ['editors', 'admins'],
  inResponseTo = REQUEST_ID
}: {
  notBefore: string
  notOnOrAfter: string
  issueInstant: string
  audience?: string
  nameId?: string
  groups?: string[]
  /** Omit entirely (`null`) to build a response with no `InResponseTo` attribute at all. */
  inResponseTo?: string | null
}): string {
  const groupValues = groups.map((g) => `<saml:AttributeValue>${g}</saml:AttributeValue>`).join('')
  const inResponseToAttr = inResponseTo ? ` InResponseTo="${inResponseTo}"` : ''
  return `<?xml version="1.0"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp1" Version="2.0" IssueInstant="${issueInstant}" Destination="https://wiki.example.com/_api/auth/strategy1/callback"${inResponseToAttr}>
<saml:Issuer>https://idp.example.com/saml</saml:Issuer>
<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
<saml:Assertion Version="2.0" ID="_assertion1" IssueInstant="${issueInstant}">
<saml:Issuer>https://idp.example.com/saml</saml:Issuer>
<saml:Subject>
<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>
<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
<saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="https://wiki.example.com/_api/auth/strategy1/callback"/>
</saml:SubjectConfirmation>
</saml:Subject>
<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>
</saml:Conditions>
<saml:AttributeStatement>
<saml:Attribute Name="uid"><saml:AttributeValue>alice</saml:AttributeValue></saml:Attribute>
<saml:Attribute Name="email"><saml:AttributeValue>${nameId}</saml:AttributeValue></saml:Attribute>
<saml:Attribute Name="name"><saml:AttributeValue>Alice Example</saml:AttributeValue></saml:Attribute>
<saml:Attribute Name="groups">${groupValues}</saml:Attribute>
</saml:AttributeStatement>
</saml:Assertion>
</samlp:Response>`
}

/** Signs the `<Assertion>` element only, the way most real identity providers do by default. */
function signAssertion(xml: string): string {
  return signXml(
    xml,
    ASSERTION_XPATH,
    { reference: ASSERTION_XPATH, action: 'append' },
    {
      privateKey: keyPem,
      publicCert: certPem,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256'
    }
  )
}

function validResponseBase64(
  overrides: Partial<Parameters<typeof buildResponseXml>[0]> = {}
): string {
  const now = new Date()
  const xml = buildResponseXml({
    notBefore: iso(new Date(now.getTime() - 60_000)),
    notOnOrAfter: iso(new Date(now.getTime() + 5 * 60_000)),
    issueInstant: iso(now),
    ...overrides
  })
  return Buffer.from(signAssertion(xml)).toString('base64')
}

const BASE_CONF = {
  entryPoint: 'https://idp.example.com/sso',
  issuer: AUDIENCE,
  get cert() {
    return certPem
  },
  audience: AUDIENCE,
  mappingUID: 'uid',
  mappingEmail: 'email',
  mappingDisplayName: 'name',
  mapGroups: true,
  mappingGroups: 'groups'
}

const REDIRECT_URI = 'https://wiki.example.com/_api/auth/strategy1/callback'

test('authorizationUrl: HTTP-Redirect binding produces a redirect URL carrying RelayState', async () => {
  const auth = new SamlAuthentication('strategy1', {
    ...BASE_CONF,
    authnRequestBinding: 'HTTP-Redirect'
  })
  const result = await auth.authorizationUrl({
    redirectUri: REDIRECT_URI,
    state: 'my-state-value',
    nonce: '',
    codeVerifier: ''
  })
  assert.equal(typeof result, 'string')
  const url = new URL(result as string)
  assert.equal(url.origin + url.pathname, 'https://idp.example.com/sso')
  assert.ok(url.searchParams.get('SAMLRequest'))
  assert.equal(url.searchParams.get('RelayState'), 'my-state-value')
})

test('authorizationUrl: HTTP-POST binding (the default) produces a self-submitting form carrying RelayState', async () => {
  const auth = new SamlAuthentication('strategy1', {
    ...BASE_CONF,
    authnRequestBinding: 'HTTP-POST'
  })
  const result = await auth.authorizationUrl({
    redirectUri: REDIRECT_URI,
    state: 'my-state-value',
    nonce: '',
    codeVerifier: ''
  })
  assert.equal(typeof result, 'object')
  const html = (result as { html: string }).html
  assert.match(html, /<form method="post" action="https:\/\/idp\.example\.com\/sso">/)
  assert.match(html, /name="SAMLRequest"/)
  assert.match(html, /name="RelayState" value="my-state-value"/)
})

test('authorizationUrl: defaults to HTTP-POST when unconfigured', async () => {
  const auth = new SamlAuthentication('strategy1', { ...BASE_CONF })
  const result = await auth.authorizationUrl({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: ''
  })
  assert.equal(typeof result, 'object')
})

test('authorizationUrl: refuses a strategy with no entryPoint/issuer/cert configured', async () => {
  const auth = new SamlAuthentication('strategy1', {})
  await assert.rejects(
    auth.authorizationUrl({ redirectUri: REDIRECT_URI, state: 's', nonce: '', codeVerifier: '' }),
    { message: 'ERR_STRATEGY_MISCONFIGURED' }
  )
})

/*
  Upstream discussion #5180: passport-saml versions below 3.0 could be configured with no IdP
  certificate at all, letting anyone forge an assertion and impersonate a user — the identity provider
  was never actually consulted. These two tests isolate `cert` specifically (entryPoint and issuer both
  present) rather than relying on the "something is missing" test above, and cover both places a
  certless config could otherwise slip through: building the outgoing request, and validating an
  incoming response. `buildSaml()`'s own `if (!entryPoint || !issuer || !cert)` guard is what refuses
  it here — `@node-saml/node-saml` 5.1.0 (this module's SAML implementation, the actively maintained
  successor to `passport-saml`) also asserts `idpCert` as required at its own construction time, so the
  same config is refused twice over even if this module's guard were ever removed.
*/
test('authorizationUrl: refuses a strategy with entryPoint and issuer but no cert (no IdP certificate bypass)', async () => {
  const auth = new SamlAuthentication('strategy1', {
    entryPoint: 'https://idp.example.com/sso',
    issuer: AUDIENCE
  })
  await assert.rejects(
    auth.authorizationUrl({ redirectUri: REDIRECT_URI, state: 's', nonce: '', codeVerifier: '' }),
    { message: 'ERR_STRATEGY_MISCONFIGURED' }
  )
})

test('profile: refuses to validate a response against a strategy with entryPoint and issuer but no cert configured', async () => {
  const auth = new SamlAuthentication('strategy1', {
    entryPoint: 'https://idp.example.com/sso',
    issuer: AUDIENCE
  })
  await assert.rejects(
    auth.profile({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: '',
      codeVerifier: '',
      authnRequestId: REQUEST_ID,
      currentUrl: REDIRECT_URI,
      body: { SAMLResponse: validResponseBase64(), RelayState: 's' }
    }),
    { message: 'ERR_STRATEGY_MISCONFIGURED' }
  )
})

/*
  `buildSaml()` is private; these three reach into it the same way the rest of this suite already
  reaches past TypeScript's compile-time-only `private` to exercise real `@node-saml/node-saml`
  behavior (`.options` is where the constructed `SAML` instance stores what it resolved each field to,
  including its own `audience || issuer` fallback and `maxAssertionAgeMs` default).
*/
test('buildSaml: an empty configured audience defaults to the strategy issuer, never to false', () => {
  const auth: any = new SamlAuthentication('strategy1', {
    ...BASE_CONF,
    issuer: 'urn:wiki:the-issuer',
    audience: ''
  })
  const saml = auth.buildSaml(REDIRECT_URI)
  assert.equal(saml.options.audience, 'urn:wiki:the-issuer')
  assert.notEqual(saml.options.audience, false)
})

test('buildSaml: an explicitly configured audience is kept, not overridden by issuer', () => {
  const auth: any = new SamlAuthentication('strategy1', {
    ...BASE_CONF,
    issuer: 'urn:wiki:the-issuer',
    audience: 'urn:some-other-audience'
  })
  const saml = auth.buildSaml(REDIRECT_URI)
  assert.equal(saml.options.audience, 'urn:some-other-audience')
})

test('buildSaml: maxAssertionAgeMs is capped to a non-zero ceiling', () => {
  const auth: any = new SamlAuthentication('strategy1', BASE_CONF)
  const saml = auth.buildSaml(REDIRECT_URI)
  assert.ok(saml.options.maxAssertionAgeMs > 0)
})

test('profile: validates a genuinely signed assertion and extracts the mapped claims', async () => {
  const auth = new SamlAuthentication('strategy1', BASE_CONF)
  const profile = await auth.profile({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: '',
    authnRequestId: REQUEST_ID,
    currentUrl: REDIRECT_URI,
    body: { SAMLResponse: validResponseBase64(), RelayState: 's' }
  })
  assert.equal(profile.id, 'alice')
  assert.equal(profile.email, 'alice@example.com')
  assert.equal(profile.name, 'Alice Example')
  assert.deepEqual(profile.groups, ['editors', 'admins'])
})

test('profile: mapGroups off leaves groups undefined rather than empty', async () => {
  const auth = new SamlAuthentication('strategy1', { ...BASE_CONF, mapGroups: false })
  const profile = await auth.profile({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: '',
    authnRequestId: REQUEST_ID,
    currentUrl: REDIRECT_URI,
    body: { SAMLResponse: validResponseBase64(), RelayState: 's' }
  })
  assert.equal(profile.groups, undefined)
})

test('profile: rejects a tampered assertion (signature no longer verifies)', async () => {
  const auth = new SamlAuthentication('strategy1', BASE_CONF)
  const now = new Date()
  const signed = signAssertion(
    buildResponseXml({
      notBefore: iso(new Date(now.getTime() - 60_000)),
      notOnOrAfter: iso(new Date(now.getTime() + 5 * 60_000)),
      issueInstant: iso(now)
    })
  )
  // -> Flip a claim after signing: same well-formed, signed-looking document, different content
  const tampered = signed.replace('alice@example.com', 'mallory@evil-corp.com')
  const tamperedBody = Buffer.from(tampered).toString('base64')

  await assert.rejects(
    auth.profile({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: '',
      codeVerifier: '',
      authnRequestId: REQUEST_ID,
      currentUrl: REDIRECT_URI,
      body: { SAMLResponse: tamperedBody, RelayState: 's' }
    })
  )
})

test('profile: rejects an assertion whose validity window has passed outside acceptedClockSkewMs', async () => {
  const auth = new SamlAuthentication('strategy1', { ...BASE_CONF, acceptedClockSkewMs: 5_000 })
  const now = new Date()
  const body = validResponseBase64({
    notBefore: iso(new Date(now.getTime() - 20 * 60_000)),
    notOnOrAfter: iso(new Date(now.getTime() - 10 * 60_000)),
    issueInstant: iso(new Date(now.getTime() - 20 * 60_000))
  })

  await assert.rejects(
    auth.profile({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: '',
      codeVerifier: '',
      authnRequestId: REQUEST_ID,
      currentUrl: REDIRECT_URI,
      body: { SAMLResponse: body, RelayState: 's' }
    }),
    // -> With `validateInResponseTo` on, `node-saml` re-checks the `SubjectConfirmationData` window
    //    before it ever reaches the plain `Conditions` check this used to fail on, and rejects with a
    //    different message for the same underlying reason (an assertion outside its validity window)
    //    -- either wording is the same expiry being refused.
    /expired|subject confirmation/i
  )
})

test('profile: an assertion just inside acceptedClockSkewMs is accepted', async () => {
  const auth = new SamlAuthentication('strategy1', {
    ...BASE_CONF,
    acceptedClockSkewMs: 5 * 60_000
  })
  const now = new Date()
  const body = validResponseBase64({
    // -> Expired two minutes ago, but within the 5-minute accepted skew. IssueInstant is kept close to
    //    NotOnOrAfter (a realistic, short assertion validity window) so `maxAssertionAgeMs`'s own fixed
    //    ceiling isn't what's actually under test here — `NotOnOrAfter` still is.
    notBefore: iso(new Date(now.getTime() - 4 * 60_000)),
    notOnOrAfter: iso(new Date(now.getTime() - 2 * 60_000)),
    issueInstant: iso(new Date(now.getTime() - 3 * 60_000))
  })

  const profile = await auth.profile({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: '',
    authnRequestId: REQUEST_ID,
    currentUrl: REDIRECT_URI,
    body: { SAMLResponse: body, RelayState: 's' }
  })
  assert.equal(profile.email, 'alice@example.com')
})

test('profile: rejects an assertion whose audience does not match', async () => {
  const auth = new SamlAuthentication('strategy1', BASE_CONF)
  const body = validResponseBase64({
    notBefore: iso(new Date(Date.now() - 60_000)),
    notOnOrAfter: iso(new Date(Date.now() + 5 * 60_000)),
    issueInstant: iso(new Date()),
    audience: 'urn:someone-else:not-this-wiki'
  })

  await assert.rejects(
    auth.profile({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: '',
      codeVerifier: '',
      authnRequestId: REQUEST_ID,
      currentUrl: REDIRECT_URI,
      body: { SAMLResponse: body, RelayState: 's' }
    }),
    /[Aa]udience/
  )
})

test('profile: cert config with a pipe-joined pair of certificates still validates against either one', async () => {
  // -> A second, unrelated self-signed cert pasted alongside the real one, as during a rotation
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-saml-test-other-'))
  const otherCertPath = path.join(otherDir, 'other-cert.pem')
  const otherKeyPath = path.join(otherDir, 'other-key.pem')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    otherKeyPath,
    '-out',
    otherCertPath,
    '-days',
    '1',
    '-subj',
    '/CN=other-idp'
  ])
  const otherCert = fs.readFileSync(otherCertPath, 'utf8')
  fs.rmSync(otherDir, { recursive: true, force: true })

  const auth = new SamlAuthentication('strategy1', {
    ...BASE_CONF,
    cert: `${otherCert}|${certPem}`
  })
  const profile = await auth.profile({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: '',
    authnRequestId: REQUEST_ID,
    currentUrl: REDIRECT_URI,
    body: { SAMLResponse: validResponseBase64(), RelayState: 's' }
  })
  assert.equal(profile.email, 'alice@example.com')
})

test('profile: rejects a callback with no SAMLResponse at all (the GET login callback, which this module has no use for)', async () => {
  const auth = new SamlAuthentication('strategy1', BASE_CONF)
  await assert.rejects(
    auth.profile({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: '',
      codeVerifier: '',
      currentUrl: REDIRECT_URI
    }),
    { message: 'ERR_NO_SAML_RESPONSE' }
  )
})

/*
  Feature 2145: default audience, `validateInResponseTo`, and the outbound AuthnRequest id.
*/

test('authorizationUrl: pins the outbound AuthnRequest ID to the id it was handed, rather than letting node-saml invent one', async () => {
  const auth = new SamlAuthentication('strategy1', {
    ...BASE_CONF,
    authnRequestBinding: 'HTTP-Redirect'
  })
  const result = await auth.authorizationUrl({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: '',
    authnRequestId: REQUEST_ID
  })
  const url = new URL(result as string)
  const deflated = Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')
  const xml = inflateRawSync(deflated).toString('utf8')
  assert.match(xml, new RegExp(`<samlp:AuthnRequest[^>]*\\bID="${REQUEST_ID}"`))
})

test('profile: rejects a response with no InResponseTo at all', async () => {
  const auth = new SamlAuthentication('strategy1', BASE_CONF)
  const body = validResponseBase64({ inResponseTo: null })

  await assert.rejects(
    auth.profile({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: '',
      codeVerifier: '',
      authnRequestId: REQUEST_ID,
      currentUrl: REDIRECT_URI,
      body: { SAMLResponse: body, RelayState: 's' }
    }),
    /InResponseTo/
  )
})

test('profile: rejects a response whose InResponseTo does not match this login flow’s own AuthnRequest id (replayed against a different login)', async () => {
  const auth = new SamlAuthentication('strategy1', BASE_CONF)
  // -> Signed for a login whose AuthnRequest id was REQUEST_ID (the default), but this flow's own
  //    session recorded a different one -- exactly what a captured SAMLResponse replayed against a
  //    freshly-started login looks like.
  const body = validResponseBase64()

  await assert.rejects(
    auth.profile({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: '',
      codeVerifier: '',
      authnRequestId: '_some-other-login-entirely',
      currentUrl: REDIRECT_URI,
      body: { SAMLResponse: body, RelayState: 's' }
    }),
    /InResponseTo/
  )
})

test('profile: with no configured audience, the assertion is still checked -- against the strategy issuer', async () => {
  // -> `audience` blanked out: `buildSaml()` must fall back to `issuer`, not skip the check the way
  //    passing `false` used to.
  const auth = new SamlAuthentication('strategy1', { ...BASE_CONF, audience: '' })
  // -> Signed for `AUDIENCE`, which is also BASE_CONF's `issuer` -- the fallback this asserts
  const profile = await auth.profile({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: '',
    authnRequestId: REQUEST_ID,
    currentUrl: REDIRECT_URI,
    body: { SAMLResponse: validResponseBase64(), RelayState: 's' }
  })
  assert.equal(profile.email, 'alice@example.com')
})

test('profile: with no configured audience, an assertion for a different audience is rejected (previously accepted, since audience checking was fully disabled)', async () => {
  const auth = new SamlAuthentication('strategy1', { ...BASE_CONF, audience: '' })
  const body = validResponseBase64({ audience: 'urn:someone-else:not-this-wiki' })

  await assert.rejects(
    auth.profile({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: '',
      codeVerifier: '',
      authnRequestId: REQUEST_ID,
      currentUrl: REDIRECT_URI,
      body: { SAMLResponse: body, RelayState: 's' }
    }),
    /[Aa]udience/
  )
})
