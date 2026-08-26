import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { inflateRawSync as zlibInflateRawSync } from 'node:zlib'
import SamlAuthentication from './authentication.ts'
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
  ;(globalThis as any).WIKI = { models: { flags: { authDebug: () => {} } } }
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

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z')
}

/**
 * The AuthnRequest id every fixture response answers, by default — stands in for what a real
 * `authorizationUrl()` call would have generated and `req.session.authFlow.requestId` would have
 * carried over. Tests that mean to exercise the mismatch/replay paths pass a different `requestId` to
 * `profile()`, or a different `inResponseTo` to `buildResponseXml()`, rather than changing this.
 */
const REQUEST_ID = '_test-authn-request-id'

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
  inResponseTo?: string
}): string {
  const groupValues = groups.map((g) => `<saml:AttributeValue>${g}</saml:AttributeValue>`).join('')
  return `<?xml version="1.0"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp1" Version="2.0" IssueInstant="${issueInstant}" InResponseTo="${inResponseTo}" Destination="https://wiki.example.com/_api/auth/strategy1/callback">
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
  assert.ok('url' in result)
  const url = new URL(result.url)
  assert.equal(url.origin + url.pathname, 'https://idp.example.com/sso')
  assert.ok(url.searchParams.get('SAMLRequest'))
  assert.equal(url.searchParams.get('RelayState'), 'my-state-value')
  // -> The `ID` node-saml actually put on the AuthnRequest, decompressed straight out of the URL it
  //    just built — not merely present, but the *same* value `profile()` will later check against.
  const inflated = zlibInflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64'))
  assert.match(inflated.toString('utf8'), new RegExp(`ID="${result.requestId}"`))
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
  assert.ok('html' in result)
  assert.match(result.html, /<form method="post" action="https:\/\/idp\.example\.com\/sso">/)
  assert.match(result.html, /name="SAMLRequest"/)
  assert.match(result.html, /name="RelayState" value="my-state-value"/)
  assert.ok(result.requestId)
})

test('authorizationUrl: defaults to HTTP-POST when unconfigured', async () => {
  const auth = new SamlAuthentication('strategy1', { ...BASE_CONF })
  const result = await auth.authorizationUrl({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: ''
  })
  assert.ok('html' in result)
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
      requestId: REQUEST_ID,
      currentUrl: REDIRECT_URI,
      body: { SAMLResponse: validResponseBase64(), RelayState: 's' }
    }),
    { message: 'ERR_STRATEGY_MISCONFIGURED' }
  )
})

test('profile: validates a genuinely signed assertion and extracts the mapped claims', async () => {
  const auth = new SamlAuthentication('strategy1', BASE_CONF)
  const profile = await auth.profile({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: '',
    requestId: REQUEST_ID,
    currentUrl: REDIRECT_URI,
    body: { SAMLResponse: validResponseBase64(), RelayState: 's' }
  })
  assert.equal(profile.id, 'alice')
  assert.equal(profile.email, 'alice@example.com')
  assert.equal(profile.name, 'Alice Example')
  assert.deepEqual(profile.groups, ['editors', 'admins'])
})

/*
  `validateInResponseTo` is the fix for the attack `docs/audit-2026-08-24/security/10-auth-modules.md`
  §4 describes: an unsolicited or replayed `SAMLResponse` for the victim, POSTed into a flow the
  attacker started themselves. `matchCallbackFlow()` in `api/authentication.ts` can't catch this — it
  only compares `RelayState`/`state` against the attacker's *own* session, which is satisfied by
  construction — so `InResponseTo` against this session's own `requestId` (see `AuthFlow.requestId`)
  is the only thing left standing between a genuine callback and one of these.
*/
test("profile: rejects a response whose InResponseTo does not match the flow's requestId", async () => {
  const auth = new SamlAuthentication('strategy1', BASE_CONF)
  await assert.rejects(
    auth.profile({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: '',
      codeVerifier: '',
      // -> This session's own flow asked for REQUEST_ID — the response below answers a different one
      requestId: REQUEST_ID,
      currentUrl: REDIRECT_URI,
      body: {
        SAMLResponse: validResponseBase64({ inResponseTo: '_someone-elses-request' }),
        RelayState: 's'
      }
    }),
    /InResponseTo/
  )
})

test('profile: rejects a second presentation of the same response, once this session has already consumed its requestId', async () => {
  const auth = new SamlAuthentication('strategy1', BASE_CONF)
  const body = { SAMLResponse: validResponseBase64(), RelayState: 's' }

  // -> First presentation: this session's flow still has its requestId, so it validates normally
  const profile = await auth.profile({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: '',
    requestId: REQUEST_ID,
    currentUrl: REDIRECT_URI,
    body
  })
  assert.equal(profile.email, 'alice@example.com')

  /*
    Second presentation of the exact same response. In the real route, this can never reach `profile()`
    at all: `matchCallbackFlow()` clears `req.session.authFlow` the instant the first callback is
    matched (`api/authentication.ts`'s "one callback per login" comment), so a repeat POST is refused
    before this module is even asked. `flowCallback.requestId` being absent here is what that consumed
    session looks like by the time anything downstream could see it — nothing is left to check the
    response's `InResponseTo` against, so it is refused rather than silently accepted.
  */
  await assert.rejects(
    auth.profile({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: '',
      codeVerifier: '',
      currentUrl: REDIRECT_URI,
      body
    }),
    /InResponseTo/
  )
})

test('profile: mapGroups off leaves groups undefined rather than empty', async () => {
  const auth = new SamlAuthentication('strategy1', { ...BASE_CONF, mapGroups: false })
  const profile = await auth.profile({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: '',
    requestId: REQUEST_ID,
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
      requestId: REQUEST_ID,
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

  /*
    With `validateInResponseTo: 'always'` on, node-saml rejects this one step earlier than it used to:
    an expired `SubjectConfirmationData` means no candidate `SubjectConfirmation` survives its own
    window check, so the `InResponseTo`-matching block (only reached at all once `validateInResponseTo`
    is enabled) finds none to compare and throws "No valid subject confirmation found" — rather than
    falling through to the assertion-level `Conditions` check that used to produce an "expired" message
    for this same fixture. Either message is a correct refusal of an expired assertion.
  */
  await assert.rejects(
    auth.profile({
      redirectUri: REDIRECT_URI,
      state: 's',
      nonce: '',
      codeVerifier: '',
      requestId: REQUEST_ID,
      currentUrl: REDIRECT_URI,
      body: { SAMLResponse: body, RelayState: 's' }
    }),
    /subject confirmation/i
  )
})

test('profile: an assertion just inside acceptedClockSkewMs is accepted', async () => {
  const auth = new SamlAuthentication('strategy1', {
    ...BASE_CONF,
    acceptedClockSkewMs: 5 * 60_000
  })
  const now = new Date()
  const body = validResponseBase64({
    // -> Expired two minutes ago, but within the 5-minute accepted skew
    notBefore: iso(new Date(now.getTime() - 10 * 60_000)),
    notOnOrAfter: iso(new Date(now.getTime() - 2 * 60_000)),
    issueInstant: iso(new Date(now.getTime() - 10 * 60_000))
  })

  const profile = await auth.profile({
    redirectUri: REDIRECT_URI,
    state: 's',
    nonce: '',
    codeVerifier: '',
    requestId: REQUEST_ID,
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
      requestId: REQUEST_ID,
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
    requestId: REQUEST_ID,
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
      requestId: REQUEST_ID,
      currentUrl: REDIRECT_URI
    }),
    { message: 'ERR_NO_SAML_RESPONSE' }
  )
})
