import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards task #701's decision — multi-hostname TLS termination is a reverse-proxy
 * responsibility, not something Wiki.js terminates itself — so it can't quietly regress:
 *
 * - The dead 2.5.x `AdminSsl.vue` stub (GraphQL/Apollo, Vuetify pug, direct `lodash`) and its
 *   orphaned `admin.ssl.*` locale strings stay gone.
 * - The disabled nav item that pointed at it is gone too, rather than left dangling on a
 *   deleted locale key.
 * - The reverse-proxy-termination story is written down under `docs/`.
 * - `config.sample.yml`'s `db.ssl`/`db.sslOptions` carry a comment distinguishing them from
 *   application-level TLS, since the shared naming is exactly what invites confusion later.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..')
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'tls-termination.md')

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

describe('TLS/SSL story (task #701)', () => {
  test('AdminSsl.vue was deleted', async () => {
    const p = path.join(REPO_ROOT, 'frontend', 'src', 'pages', 'AdminSsl.vue')
    assert.equal(await exists(p), false, 'frontend/src/pages/AdminSsl.vue should be deleted')
  })

  test('no orphaned admin.ssl.* locale strings remain', async () => {
    const locales = await readFile(path.join(REPO_ROOT, 'backend', 'locales', 'en.json'), 'utf8')
    const parsed = JSON.parse(locales) as Record<string, string>
    const orphaned = Object.keys(parsed).filter((key) => key.startsWith('admin.ssl.'))
    assert.deepEqual(orphaned, [])
  })

  test('AdminLayout no longer links to the deleted SSL admin page', async () => {
    const layout = await readFile(
      path.join(REPO_ROOT, 'frontend', 'src', 'layouts', 'AdminLayout.vue'),
      'utf8'
    )
    assert.ok(!layout.includes('/_admin/ssl'), 'AdminLayout.vue still links to /_admin/ssl')
    assert.ok(!layout.includes('admin.ssl.'), 'AdminLayout.vue still references admin.ssl.* keys')
  })

  test('routes.js has no reference to AdminSsl', async () => {
    const routes = await readFile(
      path.join(REPO_ROOT, 'frontend', 'src', 'router', 'routes.js'),
      'utf8'
    )
    assert.ok(!routes.includes('AdminSsl'))
  })

  test('the TLS-termination decision is documented under docs/', async () => {
    const doc = await readFile(DOC_PATH, 'utf8')
    // -> The load-bearing claims: a reverse proxy does SNI-based per-hostname termination and
    //    forwards plain HTTP, and `trustProxy` is what makes Wiki.js trust the resulting
    //    X-Forwarded-* headers rather than the proxy's own connection.
    for (const term of ['reverse proxy', 'SNI', 'trustProxy', 'X-Forwarded']) {
      assert.ok(doc.includes(term), `docs/tls-termination.md is missing "${term}"`)
    }
  })

  test('db.ssl / db.sslOptions in config.sample.yml are distinguished from app-level TLS', async () => {
    const sample = await readFile(path.join(REPO_ROOT, 'config.sample.yml'), 'utf8')
    const sslLineIndex = sample.split('\n').findIndex((line) => line.trim() === 'ssl: false')
    assert.notEqual(
      sslLineIndex,
      -1,
      'expected to find `ssl: false` under `db:` in config.sample.yml'
    )
    const precedingLines = sample.split('\n').slice(Math.max(0, sslLineIndex - 3), sslLineIndex)
    assert.ok(
      precedingLines.some((line) => /postgres/i.test(line) && /tls|ssl/i.test(line)),
      'expected a comment above db.ssl clarifying it configures the Postgres connection, not application-level TLS'
    )
  })
})
