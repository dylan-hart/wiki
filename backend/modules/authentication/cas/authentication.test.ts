import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import CasAuthentication from './authentication.ts'
import { installTestWiki } from '../../../test/mocks.ts'

/**
 * CAS talks to a real server over HTTP, so — per the task's own "or a hand-rolled mock
 * `serviceValidate` endpoint" allowance — this suite stands up a real `http` server implementing just
 * enough of both `serviceValidate` variants to exercise this module's actual `fetch` calls and XML/text
 * parsing, rather than mocking `fetch` itself. It also enforces genuine single-use ticket semantics
 * (each granted ticket is consumed on its first successful validation), so the replay-attack scenario is
 * exercising real "already consumed" rejection, not an assumption about it.
 */

interface GrantedTicket {
  username: string
  attrs?: Record<string, string>
}

let server: http.Server
let baseUrl: string
const usedTickets = new Set<string>()
const grantedTickets: Record<string, GrantedTicket> = {
  'ST-alice': {
    username: 'alice',
    attrs: { uid: 'a12345', mail: 'alice@example.com', displayName: 'Alice Example' }
  },
  'ST-alice2': {
    username: 'alice',
    attrs: { uid: 'a12345', mail: 'alice@example.com', displayName: 'Alice Example' }
  },
  'ST-bob-noattrs': { username: 'bob', attrs: {} },
  'ST-eve-mononym': {
    username: 'eve',
    attrs: { uid: 'e999', mail: 'eve@example.com', displayName: 'Eve' }
  },
  'ST-frank-noname': { username: 'frank', attrs: { uid: 'f111', mail: 'frank@example.com' } },
  'ST-replay-me': { username: 'carol', attrs: { mail: 'carol@example.com' } },
  'ST-cas1-dave': { username: 'dave' }
}

let wikiHandle: { restore(): void }

before(async () => {
  wikiHandle = installTestWiki({ models: { flags: { authDebug: () => {} } } })

  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    const ticket = url.searchParams.get('ticket') ?? ''
    const granted = grantedTickets[ticket]
    const alreadyUsed = usedTickets.has(ticket)
    usedTickets.add(ticket)
    const ok = Boolean(granted) && !alreadyUsed

    if (url.pathname === '/serviceValidate') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(ok ? `yes\n${granted!.username}\n` : 'no\n\n')
      return
    }
    if (url.pathname === '/p3/serviceValidate') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      if (!ok) {
        res.end(
          `<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:authenticationFailure code="INVALID_TICKET">Ticket ${ticket} not recognized</cas:authenticationFailure></cas:serviceResponse>`
        )
        return
      }
      const attrsXml = Object.entries(granted!.attrs ?? {})
        .map(([k, v]) => `<cas:${k}>${v}</cas:${k}>`)
        .join('')
      res.end(
        `<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:authenticationSuccess><cas:user>${granted!.username}</cas:user><cas:attributes>${attrsXml}</cas:attributes></cas:authenticationSuccess></cas:serviceResponse>`
      )
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  wikiHandle.restore()
})

const CAS3_CONF = () => ({
  casUrl: baseUrl,
  casVersion: 'CAS3.0',
  uniqueIdAttribute: 'uid',
  emailAttribute: 'mail',
  displayNameAttribute: 'displayName'
})
const CAS1_CONF = () => ({ casUrl: baseUrl, casVersion: 'CAS1.0' })
const REDIRECT = 'https://wiki.example.com/_api/auth/strategy1/callback'

test('authorizationUrl() builds the CAS /login URL with the service (redirectUri + state) embedded', async () => {
  const cas = new CasAuthentication('strategy1', CAS3_CONF())
  const url = await cas.authorizationUrl({
    redirectUri: REDIRECT,
    state: 'st4t3-xyz',
    nonce: '',
    codeVerifier: ''
  })
  const expectedService = encodeURIComponent(`${REDIRECT}?state=st4t3-xyz`)
  assert.equal(url, `${baseUrl}/login?service=${expectedService}`)
})

test('authorizationUrl() throws ERR_STRATEGY_MISCONFIGURED when casUrl is not set', async () => {
  const cas = new CasAuthentication('strategy1', {})
  await assert.rejects(
    () => cas.authorizationUrl({ redirectUri: REDIRECT, state: 's', nonce: '', codeVerifier: '' }),
    /ERR_STRATEGY_MISCONFIGURED/
  )
})

test('profile() throws ERR_NO_CAS_TICKET when the callback carries no ticket', async () => {
  const cas = new CasAuthentication('strategy1', CAS3_CONF())
  await assert.rejects(
    () =>
      cas.profile({
        redirectUri: REDIRECT,
        state: 's',
        nonce: '',
        codeVerifier: '',
        currentUrl: 'x'
      }),
    /ERR_NO_CAS_TICKET/
  )
})

test('CAS 3.0: a valid ticket maps id/email/name from the configured attributes', async () => {
  const cas = new CasAuthentication('strategy1', CAS3_CONF())
  const profile = await cas.profile({
    redirectUri: REDIRECT,
    state: 's1',
    nonce: '',
    codeVerifier: '',
    currentUrl: 'x',
    ticket: 'ST-alice'
  })
  assert.deepEqual(profile, {
    id: 'a12345',
    email: 'alice@example.com',
    name: 'Alice Example',
    firstName: 'Alice',
    lastName: 'Example'
  })
})

test('CAS 3.0: a one-word display name stays a mononym — no surname is invented for it', async () => {
  const cas = new CasAuthentication('strategy1', CAS3_CONF())
  const profile = await cas.profile({
    redirectUri: REDIRECT,
    state: 's1',
    nonce: '',
    codeVerifier: '',
    currentUrl: 'x',
    ticket: 'ST-eve-mononym'
  })
  assert.equal(profile.name, 'Eve')
  assert.equal(profile.firstName, 'Eve')
  assert.equal(profile.lastName, '')
})

test('CAS 3.0: a display name that fell back to the bare username splits as a mononym, the same restraint email gets', async () => {
  // -> This ticket releases `uid`/`mail` and no `displayName`, so `name` falls back to the CAS
  //    username. `email` is never fabricated out of a username (see the module's doc comment); a
  //    surname is not either — the username lands whole in `firstName` and `lastName` stays empty.
  const cas = new CasAuthentication('strategy1', CAS3_CONF())
  const profile = await cas.profile({
    redirectUri: REDIRECT,
    state: 's1',
    nonce: '',
    codeVerifier: '',
    currentUrl: 'x',
    ticket: 'ST-frank-noname'
  })
  assert.equal(profile.name, 'frank')
  assert.equal(profile.firstName, 'frank')
  assert.equal(profile.lastName, '')
})

test('CAS 3.0: a valid ticket with no attributes falls id/name back to the username, but has no email to establish', async () => {
  const cas = new CasAuthentication('strategy1', CAS3_CONF())
  await assert.rejects(
    () =>
      cas.profile({
        redirectUri: REDIRECT,
        state: 's2',
        nonce: '',
        codeVerifier: '',
        currentUrl: 'x',
        ticket: 'ST-bob-noattrs'
      }),
    /ERR_NO_EMAIL_FROM_PROVIDER/
  )
})

test('CAS 3.0: an unrecognized ticket is refused', async () => {
  const cas = new CasAuthentication('strategy1', CAS3_CONF())
  await assert.rejects(
    () =>
      cas.profile({
        redirectUri: REDIRECT,
        state: 's3',
        nonce: '',
        codeVerifier: '',
        currentUrl: 'x',
        ticket: 'ST-never-issued'
      }),
    /ERR_CAS_LOGIN_FAILED/
  )
})

test('CAS 3.0: a ticket cannot be replayed — the server refuses its second use', async () => {
  const cas = new CasAuthentication('strategy1', CAS3_CONF())
  const flow = {
    redirectUri: REDIRECT,
    state: 's4',
    nonce: '',
    codeVerifier: '',
    currentUrl: 'x',
    ticket: 'ST-replay-me'
  }
  const first = await cas.profile(flow)
  assert.equal(first.email, 'carol@example.com')
  await assert.rejects(() => cas.profile(flow), /ERR_CAS_LOGIN_FAILED/)
})

test('CAS 1.0: a valid ticket reports only the bare username, with no email attributes ever available', async () => {
  const cas = new CasAuthentication('strategy1', CAS1_CONF())
  await assert.rejects(
    () =>
      cas.profile({
        redirectUri: REDIRECT,
        state: 's5',
        nonce: '',
        codeVerifier: '',
        currentUrl: 'x',
        ticket: 'ST-cas1-dave'
      }),
    /ERR_NO_EMAIL_FROM_PROVIDER/
  )
})

test('CAS 1.0: a failed ticket ("no") is refused', async () => {
  const cas = new CasAuthentication('strategy1', CAS1_CONF())
  await assert.rejects(
    () =>
      cas.profile({
        redirectUri: REDIRECT,
        state: 's6',
        nonce: '',
        codeVerifier: '',
        currentUrl: 'x',
        ticket: 'ST-never-issued-cas1'
      }),
    /ERR_CAS_LOGIN_FAILED/
  )
})

test('CAS 3.0 is the default version when casVersion is left unset', async () => {
  const cas = new CasAuthentication('strategy1', {
    casUrl: baseUrl,
    uniqueIdAttribute: 'uid',
    emailAttribute: 'mail'
  })
  const profile = await cas.profile({
    redirectUri: REDIRECT,
    state: 's7',
    nonce: '',
    codeVerifier: '',
    currentUrl: 'x',
    ticket: 'ST-alice2'
  })
  assert.equal(profile.email, 'alice@example.com')
})
