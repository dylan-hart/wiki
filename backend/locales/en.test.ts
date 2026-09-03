import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * `en.json` is the single source of truth for every user-facing string, and the sync point
 * Localazy round-trips through. `JSON.parse` silently keeps only the *last* occurrence of a
 * duplicate key, so a duplicate key is invisible to every consumer -- an edit or a translation
 * applied to the earlier copy is discarded with no error. See work package 1974.
 *
 * A naive regex over `"key":` is not safe here: string values in this file contain colons and
 * escaped quotes. Instead this walks the file line by line (the file is a flat, single-level
 * object with exactly one key per line) and JSON-parses each key-bearing line on its own, which
 * handles escaping correctly. Comparing that line count against `JSON.parse`'s own (deduplicated)
 * key count is what catches a reintroduced duplicate: if they disagree, some key appeared on more
 * than one line.
 */
describe('backend/locales/en.json', () => {
  const localePath = path.join(import.meta.dirname, 'en.json')

  async function readKeyBearingLines(raw: string) {
    const keys: string[] = []
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim()
      if (line === '' || line === '{' || line === '}') continue
      const withoutTrailingComma = line.endsWith(',') ? line.slice(0, -1) : line
      const entry = JSON.parse(`{${withoutTrailingComma}}`) as Record<string, unknown>
      const entryKeys = Object.keys(entry)
      assert.equal(entryKeys.length, 1, `expected exactly one key on line: ${rawLine}`)
      keys.push(entryKeys[0])
    }
    return keys
  }

  test('has no duplicate keys', async () => {
    const raw = await readFile(localePath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, string>
    const lineKeys = await readKeyBearingLines(raw)

    assert.equal(
      lineKeys.length,
      Object.keys(parsed).length,
      'key-bearing line count must equal the parsed key count -- a mismatch means a duplicate key ' +
        'was silently dropped by JSON.parse'
    )
  })

  test('keys are sorted alphabetically', async () => {
    const raw = await readFile(localePath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, string>
    const keys = Object.keys(parsed)
    const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

    assert.deepEqual(keys, sorted)
  })

  /**
   * Regression coverage for the dead GraphQL-era developer-tools locale keys (OpenProject #1634 /
   * #1984 / #2014). `admin.dev.title`, `admin.dev.graphiql.title` and `admin.dev.voyager.title`
   * described an admin "Developer Tools" page with GraphiQL/Voyager panels that no longer exists;
   * `admin.utilities.graphEndpointSubtitle`/`admin.utilities.graphEndpointTitle` described the
   * now-removed GraphQL endpoint setting alongside it — GraphQL was removed from the live surface
   * (see CLAUDE.md's "GraphQL was removed" section) and `grep -rni 'graphiql|voyager|graphendpoint'`
   * across `backend/`, `frontend/src` and `blocks/` returns nothing but these locale declarations.
   * `admin.logging.title` described a Logging admin page with no surviving route or component.
   * `admin.dev.flags.title` is deliberately excluded from this list — a real Flags admin page exists
   * at `/_admin/flags` (`frontend/src/layouts/AdminLayout.vue`) and reads it.
   */
  test('has no orphaned admin.dev.* GraphQL-tooling, admin.utilities.graphEndpoint*, or admin.logging.* keys', async () => {
    const raw = await readFile(localePath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, string>

    for (const deadKey of [
      'admin.dev.title',
      'admin.dev.graphiql.title',
      'admin.dev.voyager.title',
      'admin.logging.title',
      'admin.utilities.graphEndpointSubtitle',
      'admin.utilities.graphEndpointTitle'
    ]) {
      assert.equal(
        Object.hasOwn(parsed, deadKey),
        false,
        `${deadKey} is dead (no reader anywhere in the repo) and must not reappear in en.json`
      )
    }

    // -> The live Flags admin page's nav label -- must survive this and any future dead-key sweep.
    assert.equal(Object.hasOwn(parsed, 'admin.dev.flags.title'), true)
  })
})

/**
 * Regression guard for OpenProject WP #1634: `backend/locales/en.json` used to ship strings for
 * surfaces this branch has already removed — the Wiki.js 1.x importer and the route-unreachable
 * `admin.tags.*` cluster backing `frontend/src/pages/AdminTags.vue`. Every one of those keys had
 * zero references across `frontend/src`, `backend/api`, `backend/models`, `backend/controllers` and
 * `e2e` (verified by grep, not by a generic unused-key scan — several other namespaces are addressed
 * by runtime key construction and are deliberately out of this WP's scope). This test locks the
 * deletion in place so none of the dead clusters silently reappears. The GraphQL dev-tool/endpoint
 * cluster this WP originally also covered is folded into the describe above, whose dead-key list
 * already includes it (see that test's docblock).
 */
describe('backend/locales/en.json — dead key clusters stay removed', () => {
  const localePath = path.join(import.meta.dirname, 'en.json')

  async function loadParsed() {
    const raw = await readFile(localePath, 'utf8')
    return JSON.parse(raw) as Record<string, string>
  }

  test('no Wiki.js 1.x importer keys', async () => {
    const parsed = await loadParsed()
    for (const deadKey of ['admin.utilities.importv1Subtitle', 'admin.utilities.importv1Title']) {
      assert.equal(Object.hasOwn(parsed, deadKey), false, `${deadKey} should have been deleted`)
    }
  })

  test('no admin.tags.* keys (AdminTags.vue is route-unreachable)', async () => {
    const parsed = await loadParsed()
    const tagsKeys = Object.keys(parsed).filter((k) => k.startsWith('admin.tags.'))
    assert.deepEqual(tagsKeys, [])
  })

  test('surviving admin.dev.* and admin.utilities.* namespaces are untouched', async () => {
    const parsed = await loadParsed()
    // -> `admin.dev.title` (the "Developer Tools" section wrapping just `flags`) was itself swept as
    //    unreferenced by the later, more thorough #2014 pass -- AdminLayout.vue's nav flattened to a
    //    standalone "Flags" item with no wrapping section header once GraphiQL/Voyager, its only other
    //    children, were gone. `admin.dev.flags.title` is the one key from this prefix #2014 confirmed
    //    still has a reader (the nav label for /_admin/flags) and kept.
    assert.equal(Object.hasOwn(parsed, 'admin.dev.flags.title'), true)
    assert.equal(Object.hasOwn(parsed, 'admin.utilities.import'), true)
    assert.equal(Object.hasOwn(parsed, 'admin.utilities.invalidApiCertificates'), true)
  })
})
