import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EN_JSON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'en.json')

/**
 * Regression coverage for the dead GraphQL-era developer-tools locale keys (OpenProject #1984 /
 * #2014). `admin.dev.title`, `admin.dev.graphiql.title` and `admin.dev.voyager.title` described an
 * admin "Developer Tools" page with GraphiQL/Voyager panels that no longer exists — GraphQL was
 * removed from the live surface (see CLAUDE.md's "GraphQL is being removed" section) and
 * `grep -rni 'graphiql|voyager'` across `backend/`, `frontend/src` and `blocks/` returns nothing but
 * these locale declarations. `admin.logging.title` described a Logging admin page with no surviving
 * route or component. `admin.dev.flags.title` is deliberately excluded from this list — a real
 * Flags admin page exists at `/_admin/flags` (`frontend/src/layouts/AdminLayout.vue`) and reads it.
 */
describe('backend/locales/en.json', () => {
  test('has no orphaned admin.dev.* GraphQL-tooling or admin.logging.* keys', async () => {
    const raw = await fs.readFile(EN_JSON_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, string>

    for (const deadKey of [
      'admin.dev.title',
      'admin.dev.graphiql.title',
      'admin.dev.voyager.title',
      'admin.logging.title'
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
