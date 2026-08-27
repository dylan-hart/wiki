import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * `blockCredentials` is almost entirely SQL orchestration around one table, so what is worth locking
 * down against a real database is exactly the thing a query-builder mock would just be re-describing:
 * `getCredentialForResolve()` actually returns the secret and allowlist while every other read leaves
 * the secret off, and a row is scoped to its own site.
 */
describe('blockCredentials (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let blockCredentials: typeof import('./blockCredentials.ts').blockCredentials

  before(async () => {
    fixtures = await setupTestDb()
    ;({ blockCredentials } = await import('./blockCredentials.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('createCredential returns the row without a secret field, getCredentialForResolve returns secret + origins', async () => {
    const created = await blockCredentials.createCredential(
      fixtures.siteId,
      'Weather API',
      'sekret-token-1',
      ['https://api.example.com']
    )
    assert.equal(created.name, 'Weather API')
    assert.equal(created.siteId, fixtures.siteId)
    assert.deepEqual(created.allowedOrigins, ['https://api.example.com'])
    assert.equal('secret' in created, false)

    const resolved = await blockCredentials.getCredentialForResolve(fixtures.siteId, created.id)
    assert.equal(resolved?.secret, 'sekret-token-1')
    assert.deepEqual(resolved?.allowedOrigins, ['https://api.example.com'])
  })

  test('createCredential stores every given origin, in order, no dedup applied at this layer', async () => {
    const created = await blockCredentials.createCredential(
      fixtures.siteId,
      'Multi-domain',
      'secret',
      ['https://api.example.com', 'https://internal.example.com']
    )
    assert.deepEqual(created.allowedOrigins, [
      'https://api.example.com',
      'https://internal.example.com'
    ])
  })

  test('updateAllowedOrigins replaces the list and returns true, false for an unknown id', async () => {
    const created = await blockCredentials.createCredential(fixtures.siteId, 'Scoped', 'secret', [
      'https://old.example.com'
    ])

    const updated = await blockCredentials.updateAllowedOrigins(fixtures.siteId, created.id, [
      'https://new.example.com'
    ])
    assert.equal(updated, true)
    const resolved = await blockCredentials.getCredentialForResolve(fixtures.siteId, created.id)
    assert.deepEqual(resolved?.allowedOrigins, ['https://new.example.com'])

    const missing = await blockCredentials.updateAllowedOrigins(
      fixtures.siteId,
      '11111111-1111-4111-8111-111111111111',
      ['https://whatever.com']
    )
    assert.equal(missing, false)
  })

  test('updateAllowedOrigins can clear the list to empty, deliberately disabling the credential', async () => {
    const created = await blockCredentials.createCredential(
      fixtures.siteId,
      'Clearable',
      'secret',
      ['https://api.example.com']
    )
    const updated = await blockCredentials.updateAllowedOrigins(fixtures.siteId, created.id, [])
    assert.equal(updated, true)
    const resolved = await blockCredentials.getCredentialForResolve(fixtures.siteId, created.id)
    assert.deepEqual(resolved?.allowedOrigins, [])
  })

  test("getSiteCredentials lists a site's credentials without their secrets", async () => {
    await blockCredentials.createCredential(fixtures.siteId, 'API One', 'secret-one', [
      'https://api.example.com'
    ])
    await blockCredentials.createCredential(fixtures.siteId, 'API Two', 'secret-two', [
      'https://api.example.com'
    ])

    const list = await blockCredentials.getSiteCredentials(fixtures.siteId)
    assert.ok(list.length >= 2)
    for (const row of list) {
      assert.equal('secret' in row, false)
    }
    assert.ok(list.some((row) => row.name === 'API One'))
    assert.ok(list.some((row) => row.name === 'API Two'))
  })

  test('getCredentialForResolve returns undefined for a credential id on a different site', async () => {
    const created = await blockCredentials.createCredential(
      fixtures.siteId,
      'Scoped',
      'scoped-secret',
      ['https://api.example.com']
    )
    const otherSiteId = '00000000-0000-4000-8000-000000000000'
    const resolved = await blockCredentials.getCredentialForResolve(otherSiteId, created.id)
    assert.equal(resolved, undefined)
  })

  test('rotateSecret replaces the secret and returns true, false for an unknown id', async () => {
    const created = await blockCredentials.createCredential(
      fixtures.siteId,
      'Rotates',
      'old-secret',
      ['https://api.example.com']
    )

    const rotated = await blockCredentials.rotateSecret(fixtures.siteId, created.id, 'new-secret')
    assert.equal(rotated, true)
    assert.equal(
      (await blockCredentials.getCredentialForResolve(fixtures.siteId, created.id))?.secret,
      'new-secret'
    )

    const missing = await blockCredentials.rotateSecret(
      fixtures.siteId,
      '11111111-1111-4111-8111-111111111111',
      'whatever'
    )
    assert.equal(missing, false)
  })

  test('deleteCredential removes the row and returns false on a second call', async () => {
    const created = await blockCredentials.createCredential(fixtures.siteId, 'Doomed', 'bye', [
      'https://api.example.com'
    ])

    const deleted = await blockCredentials.deleteCredential(fixtures.siteId, created.id)
    assert.equal(deleted, true)
    assert.equal(
      await blockCredentials.getCredentialForResolve(fixtures.siteId, created.id),
      undefined
    )

    const deletedAgain = await blockCredentials.deleteCredential(fixtures.siteId, created.id)
    assert.equal(deletedAgain, false)
  })
})
