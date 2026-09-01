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
    // -> `admin.dev.title` (the "Developer Tools" section wrapping just `flags`) was itself swept as
    //    unreferenced by the later, more thorough #2014 pass -- AdminLayout.vue's nav flattened to a
    //    standalone "Flags" item with no wrapping section header once GraphiQL/Voyager, its only other
    //    children, were gone. `admin.dev.flags.title` is the one key from this prefix #2014 confirmed
    //    still has a reader (the nav label for /_admin/flags) and kept.
    assert.equal(keys.includes('admin.dev.flags.title'), true)
    assert.equal(keys.includes('admin.utilities.import'), true)
    assert.equal(keys.includes('admin.utilities.invalidApiCertificates'), true)
  })
})

/**
 * Regression guard for OpenProject WP #2362: a prior merge of several branches into `scarlett`
 * independently added the same key (`auth.errors.unexpectedResponse`) twice -- once in its correct
 * alphabetical position and once misplaced earlier in the file -- because each branch's diff added
 * the key without either side noticing the other already had it. `JSON.parse` silently keeps only
 * the last occurrence of a duplicate key, so neither `require`/`import`-ing this file nor a naive
 * "does this key exist" check would ever catch a duplicate -- the file has to be scanned as text.
 * By the time this WP was picked up the specific instance had already been fixed by a later merge,
 * but the underlying failure mode (an unreconciled multi-branch merge silently duplicating a locale
 * key) has no guard, so this test parses the raw source and fails if any top-level key string is
 * ever defined more than once.
 */
describe('backend/locales/en.json — no duplicate keys', () => {
  test('every top-level key string appears exactly once in the source text', async () => {
    const raw = await readFile(path.join(import.meta.dirname, 'locales', 'en.json'), 'utf8')
    const keyPattern = /^\s*"((?:[^"\\]|\\.)*)":/gm
    const seen = new Map()
    const duplicates = []
    let match
    while ((match = keyPattern.exec(raw)) !== null) {
      const key = match[1]
      if (seen.has(key)) {
        duplicates.push(key)
      } else {
        seen.set(key, true)
      }
    }
    assert.deepEqual(duplicates, [], `duplicate locale key(s) found: ${duplicates.join(', ')}`)
  })
})
