import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * `blockCredentials` is almost entirely SQL orchestration around one table, so what is worth locking
 * down against a real database is exactly the thing a query-builder mock would just be re-describing:
 * `getSecret()` actually returns the secret while every other read leaves it off, and a row is scoped
 * to its own site.
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

  test('createCredential returns the row without a secret field, getSecret returns the secret', async () => {
    const created = await blockCredentials.createCredential(
      fixtures.siteId,
      'Weather API',
      'sekret-token-1'
    )
    assert.equal(created.name, 'Weather API')
    assert.equal(created.siteId, fixtures.siteId)
    assert.equal('secret' in created, false)

    const secret = await blockCredentials.getSecret(fixtures.siteId, created.id)
    assert.equal(secret, 'sekret-token-1')
  })

  test("getSiteCredentials lists a site's credentials without their secrets", async () => {
    await blockCredentials.createCredential(fixtures.siteId, 'API One', 'secret-one')
    await blockCredentials.createCredential(fixtures.siteId, 'API Two', 'secret-two')

    const list = await blockCredentials.getSiteCredentials(fixtures.siteId)
    assert.ok(list.length >= 2)
    for (const row of list) {
      assert.equal('secret' in row, false)
    }
    assert.ok(list.some((row) => row.name === 'API One'))
    assert.ok(list.some((row) => row.name === 'API Two'))
  })

  test('getSecret returns undefined for a credential id on a different site', async () => {
    const created = await blockCredentials.createCredential(
      fixtures.siteId,
      'Scoped',
      'scoped-secret'
    )
    const otherSiteId = '00000000-0000-4000-8000-000000000000'
    const secret = await blockCredentials.getSecret(otherSiteId, created.id)
    assert.equal(secret, undefined)
  })

  test('rotateSecret replaces the secret and returns true, false for an unknown id', async () => {
    const created = await blockCredentials.createCredential(
      fixtures.siteId,
      'Rotates',
      'old-secret'
    )

    const rotated = await blockCredentials.rotateSecret(fixtures.siteId, created.id, 'new-secret')
    assert.equal(rotated, true)
    assert.equal(await blockCredentials.getSecret(fixtures.siteId, created.id), 'new-secret')

    const missing = await blockCredentials.rotateSecret(
      fixtures.siteId,
      '11111111-1111-4111-8111-111111111111',
      'whatever'
    )
    assert.equal(missing, false)
  })

  test('deleteCredential removes the row and returns false on a second call', async () => {
    const created = await blockCredentials.createCredential(fixtures.siteId, 'Doomed', 'bye')

    const deleted = await blockCredentials.deleteCredential(fixtures.siteId, created.id)
    assert.equal(deleted, true)
    assert.equal(await blockCredentials.getSecret(fixtures.siteId, created.id), undefined)

    const deletedAgain = await blockCredentials.deleteCredential(fixtures.siteId, created.id)
    assert.equal(deletedAgain, false)
  })
})
