import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import userRoutes from './user.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

/**
 * WP 1852: a conditional avatar request must be answered from the `hash` column alone — never by
 * loading the avatar blob (`getAvatar`) — and only fall through to the blob read when the ETag does
 * not match. `WIKI.models.users` is mocked with `node:test`'s `mock.fn()` so a test can assert
 * `getAvatar` was (or was not) called, the same mocking approach `controllers/site.test.ts` documents
 * for its sibling route.
 */
describe('GET /_user/:userId/avatar', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111'
  const AVATAR_DATA = Buffer.from('avatar-bytes')
  const AVATAR_HASH = crypto.createHash('sha1').update(AVATAR_DATA).digest('hex')

  let app: FastifyInstance
  let getAvatar: ReturnType<typeof mock.fn>
  let getAvatarHash: ReturnType<typeof mock.fn>

  before(async () => {
    app = fastify()
    await app.register(fastifySensible)
    await app.register(userRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  beforeEach(() => {
    getAvatar = mock.fn(async () => ({ data: AVATAR_DATA, mime: 'image/jpeg' }))
    getAvatarHash = mock.fn(async () => AVATAR_HASH)
    wikiHandle = installTestWiki({
      models: {
        users: { getAvatar, getAvatarHash }
      }
    })
  })

  test('a first request (no If-None-Match) gets a 200 with the avatar bytes, ETag and headers, and does read the blob', async () => {
    const res = await app.inject({ method: 'GET', url: `/${USER_ID}/avatar` })

    assert.equal(res.statusCode, 200)
    assert.equal(res.body, AVATAR_DATA.toString())
    assert.equal(res.headers.etag, `"${AVATAR_HASH}"`)
    assert.equal(res.headers['cache-control'], 'private, no-cache')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(getAvatarHash.mock.callCount(), 1)
    assert.equal(getAvatar.mock.callCount(), 1)
  })

  test('a matching If-None-Match short-circuits to an empty 304, WITHOUT ever calling getAvatar (the blob-loading method)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/${USER_ID}/avatar`,
      headers: { 'if-none-match': `"${AVATAR_HASH}"` }
    })

    assert.equal(res.statusCode, 304)
    assert.equal(res.body, '')
    assert.equal(res.headers.etag, `"${AVATAR_HASH}"`)
    assert.equal(res.headers['cache-control'], 'private, no-cache')
    assert.equal(getAvatarHash.mock.callCount(), 1)
    assert.equal(
      getAvatar.mock.callCount(),
      0,
      'a matching conditional request must never load the avatar blob'
    )
  })

  test('a stale/mismatched If-None-Match still gets the full 200 response, reading the blob', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/${USER_ID}/avatar`,
      headers: { 'if-none-match': '"stale-etag-from-a-previous-upload"' }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.body, AVATAR_DATA.toString())
    assert.equal(getAvatar.mock.callCount(), 1)
  })

  test('a user with no avatar answers 404 from the hash reader alone, without calling getAvatar', async () => {
    getAvatarHash.mock.mockImplementation(async () => null)

    const res = await app.inject({ method: 'GET', url: `/${USER_ID}/avatar` })

    assert.equal(res.statusCode, 404)
    assert.equal(getAvatar.mock.callCount(), 0)
  })

  test('an invalid userId answers 404 without touching either model method', async () => {
    const res = await app.inject({ method: 'GET', url: '/not-a-uuid/avatar' })

    assert.equal(res.statusCode, 404)
    assert.equal(getAvatarHash.mock.callCount(), 0)
    assert.equal(getAvatar.mock.callCount(), 0)
  })
})
