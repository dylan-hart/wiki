import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Regression guard for OpenProject WP #1634: `backend/locales/en.json` used to ship strings for
 * surfaces this branch has already removed — the GraphiQL/Voyager dev tools, the GraphQL endpoint
 * setting, the Wiki.js 1.x importer, and the route-unreachable `admin.tags.*` cluster backing
 * `frontend/src/pages/AdminTags.vue`. Every one of those keys had zero references across
 * `frontend/src`, `backend/api`, `backend/models`, `backend/controllers` and `e2e` (verified by
 * grep, not by a generic unused-key scan — several other namespaces are addressed by runtime key
 * construction and are deliberately out of this WP's scope). This test locks the deletion in place
 * so none of the dead clusters silently reappears.
 */
describe('backend/locales/en.json — dead key clusters stay removed', () => {
  async function loadKeys() {
    const raw = await readFile(path.join(import.meta.dirname, 'locales', 'en.json'), 'utf8')
    return Object.keys(JSON.parse(raw))
  }

  test('no GraphQL dev-tool or endpoint-setting keys', async () => {
    const keys = await loadKeys()
    const dead = [
      'admin.dev.graphiql.title',
      'admin.dev.voyager.title',
      'admin.utilities.graphEndpointSubtitle',
      'admin.utilities.graphEndpointTitle'
    ]
    for (const key of dead) {
      assert.equal(keys.includes(key), false, `${key} should have been deleted`)
    }
  })

  test('no Wiki.js 1.x importer keys', async () => {
    const keys = await loadKeys()
    const dead = ['admin.utilities.importv1Subtitle', 'admin.utilities.importv1Title']
    for (const key of dead) {
      assert.equal(keys.includes(key), false, `${key} should have been deleted`)
    }
  })

  test('no admin.tags.* keys (AdminTags.vue is route-unreachable)', async () => {
    const keys = await loadKeys()
    const tagsKeys = keys.filter((k) => k.startsWith('admin.tags.'))
    assert.deepEqual(tagsKeys, [])
  })

  test('surviving admin.dev.* and admin.utilities.* namespaces are untouched', async () => {
    const keys = await loadKeys()
    assert.equal(keys.includes('admin.dev.title'), true)
    assert.equal(keys.includes('admin.dev.flags.title'), true)
    assert.equal(keys.includes('admin.utilities.import'), true)
    assert.equal(keys.includes('admin.utilities.invalidApiCertificates'), true)
  })
})
