import { describe, test, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { fetchWorkspaceGroups } from './groups.ts'

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})

const serviceAccountKey = JSON.stringify({
  type: 'service_account',
  client_email: 'sync@project.iam.gserviceaccount.com',
  private_key: privateKey
})

const conf = { serviceAccountKey, delegatedAdminEmail: ' admin@example.com ' }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

describe('fetchWorkspaceGroups', () => {
  let calls: Array<{ url: URL; init: RequestInit }>
  let handler: Handler

  beforeEach(() => {
    calls = []
    handler = (url) =>
      url.origin === 'https://oauth2.googleapis.com'
        ? json({ access_token: 'tok-1', expires_in: 3600 })
        : json({})
    mock.method(globalThis, 'fetch', async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      calls.push({ url, init })
      return handler(url, init)
    })
  })

  afterEach(() => {
    mock.restoreAll()
  })

  test('signs an RS256 JWT with the delegated admin as subject and the read-only directory scope', async () => {
    const before = Math.floor(Date.now() / 1000)
    await fetchWorkspaceGroups(conf, 'user@example.com')

    const tokenCall = calls[0]
    assert.equal(tokenCall.url.toString(), 'https://oauth2.googleapis.com/token')
    assert.equal(tokenCall.init.method, 'POST')
    const form = new URLSearchParams(String(tokenCall.init.body))
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer')

    const [header, claims, signature] = form.get('assertion')!.split('.')
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {
      alg: 'RS256',
      typ: 'JWT'
    })
    const payload = JSON.parse(Buffer.from(claims, 'base64url').toString())
    assert.equal(payload.iss, 'sync@project.iam.gserviceaccount.com')
    assert.equal(payload.sub, 'admin@example.com')
    assert.equal(payload.scope, 'https://www.googleapis.com/auth/admin.directory.group.readonly')
    assert.equal(payload.aud, 'https://oauth2.googleapis.com/token')
    assert.ok(payload.iat >= before && payload.iat <= before + 5)
    assert.equal(payload.exp, payload.iat + 3600)

    const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`)
    assert.equal(verifier.verify(publicKey, Buffer.from(signature, 'base64url')), true)
  })

  test('lists groups for the user with the exchanged bearer token', async () => {
    handler = (url) =>
      url.origin === 'https://oauth2.googleapis.com'
        ? json({ access_token: 'tok-1' })
        : json({ groups: [{ name: 'Engineering' }] })
    const result = await fetchWorkspaceGroups(conf, 'us+er@example.com')

    assert.deepEqual(result, ['Engineering'])
    const listCall = calls[1]
    assert.equal(
      listCall.url.origin + listCall.url.pathname,
      'https://admin.googleapis.com/admin/directory/v1/groups'
    )
    assert.equal(listCall.url.searchParams.get('userKey'), 'us+er@example.com')
    assert.equal((listCall.init.headers as Record<string, string>).Authorization, 'Bearer tok-1')
  })

  test('follows nextPageToken until the listing is exhausted', async () => {
    handler = (url) => {
      if (url.origin === 'https://oauth2.googleapis.com') {
        return json({ access_token: 'tok-1' })
      }
      const token = url.searchParams.get('pageToken')
      if (!token) {
        return json({ groups: [{ name: 'A' }], nextPageToken: 'p2' })
      }
      if (token === 'p2') {
        return json({ groups: [{ name: 'B' }], nextPageToken: 'p3' })
      }
      return json({ groups: [{ name: 'C' }] })
    }
    assert.deepEqual(await fetchWorkspaceGroups(conf, 'user@example.com'), ['A', 'B', 'C'])
    assert.equal(calls.filter((c) => c.url.origin === 'https://admin.googleapis.com').length, 3)
    assert.equal(calls.filter((c) => c.url.origin === 'https://oauth2.googleapis.com').length, 1)
  })

  test('trims names and drops blanks and duplicates', async () => {
    handler = (url) =>
      url.origin === 'https://oauth2.googleapis.com'
        ? json({ access_token: 'tok-1' })
        : json({
            groups: [
              { name: '  Engineering ' },
              { name: 'Engineering' },
              { name: '   ' },
              { email: 'no-name@example.com' },
              { name: 'Sales' }
            ]
          })
    assert.deepEqual(await fetchWorkspaceGroups(conf, 'user@example.com'), ['Engineering', 'Sales'])
  })

  test('returns an empty list when the user belongs to no group', async () => {
    assert.deepEqual(await fetchWorkspaceGroups(conf, 'user@example.com'), [])
  })

  test('accepts the service account key as an object', async () => {
    await fetchWorkspaceGroups(
      { ...conf, serviceAccountKey: JSON.parse(serviceAccountKey) },
      'user@example.com'
    )
    assert.equal(calls.length, 2)
  })

  describe('failures throw rather than returning an empty list', () => {
    test('a token endpoint error', async () => {
      handler = () => json({ error: 'invalid_grant' }, 400)
      await assert.rejects(fetchWorkspaceGroups(conf, 'user@example.com'), {
        message: 'ERR_PROVIDER_REQUEST_FAILED'
      })
      assert.equal(calls.length, 1)
    })

    test('a token response without an access token', async () => {
      handler = () => json({})
      await assert.rejects(fetchWorkspaceGroups(conf, 'user@example.com'), {
        message: 'ERR_PROVIDER_REQUEST_FAILED'
      })
    })

    test('a directory API error', async () => {
      handler = (url) =>
        url.origin === 'https://oauth2.googleapis.com'
          ? json({ access_token: 'tok-1' })
          : json({ error: { code: 403 } }, 403)
      await assert.rejects(fetchWorkspaceGroups(conf, 'user@example.com'), {
        message: 'ERR_PROVIDER_REQUEST_FAILED'
      })
    })

    test('a directory API error on a later page discards the earlier pages', async () => {
      handler = (url) => {
        if (url.origin === 'https://oauth2.googleapis.com') {
          return json({ access_token: 'tok-1' })
        }
        return url.searchParams.get('pageToken')
          ? json({}, 503)
          : json({ groups: [{ name: 'A' }], nextPageToken: 'p2' })
      }
      await assert.rejects(fetchWorkspaceGroups(conf, 'user@example.com'), {
        message: 'ERR_PROVIDER_REQUEST_FAILED'
      })
    })

    test('a network error', async () => {
      handler = () => {
        throw new TypeError('fetch failed')
      }
      await assert.rejects(fetchWorkspaceGroups(conf, 'user@example.com'), {
        message: 'ERR_PROVIDER_REQUEST_FAILED'
      })
    })

    test('a non-JSON body', async () => {
      handler = () => new Response('<html>', { status: 200 })
      await assert.rejects(fetchWorkspaceGroups(conf, 'user@example.com'), {
        message: 'ERR_PROVIDER_REQUEST_FAILED'
      })
    })

    test('a groups field that is not a list', async () => {
      handler = (url) =>
        url.origin === 'https://oauth2.googleapis.com'
          ? json({ access_token: 'tok-1' })
          : json({ groups: 'nope' })
      await assert.rejects(fetchWorkspaceGroups(conf, 'user@example.com'), {
        message: 'ERR_PROVIDER_REQUEST_FAILED'
      })
    })

    test('a listing that never stops paging', async () => {
      handler = (url) =>
        url.origin === 'https://oauth2.googleapis.com'
          ? json({ access_token: 'tok-1' })
          : json({ groups: [{ name: 'A' }], nextPageToken: 'again' })
      await assert.rejects(fetchWorkspaceGroups(conf, 'user@example.com'), {
        message: 'ERR_PROVIDER_REQUEST_FAILED'
      })
    })
  })

  describe('misconfiguration is refused before any request', () => {
    for (const [label, bad] of [
      ['a missing key', { ...conf, serviceAccountKey: undefined }],
      ['a key that is not JSON', { ...conf, serviceAccountKey: 'not json' }],
      ['a key without a private key', { ...conf, serviceAccountKey: '{"client_email":"a@b.c"}' }],
      ['a missing delegated admin', { ...conf, delegatedAdminEmail: '  ' }]
    ] as const) {
      test(label, async () => {
        await assert.rejects(fetchWorkspaceGroups(bad, 'user@example.com'), {
          message: 'ERR_STRATEGY_MISCONFIGURED'
        })
        assert.equal(calls.length, 0)
      })
    }

    test('a private key that cannot sign', async () => {
      const broken = JSON.stringify({ client_email: 'a@b.c', private_key: 'not a pem' })
      await assert.rejects(
        fetchWorkspaceGroups({ ...conf, serviceAccountKey: broken }, 'u@e.com'),
        {
          message: 'ERR_STRATEGY_MISCONFIGURED'
        }
      )
      assert.equal(calls.length, 0)
    })
  })
})
