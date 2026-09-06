import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards task #701's decision — multi-hostname TLS termination is a reverse-proxy
 * responsibility, not something Cardinal.js terminates itself — so it can't quietly regress:
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
const REPO_ROOT = path.join(HERE, '../..')
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
    //    forwards plain HTTP, and `trustProxy` is what makes Cardinal.js trust the resulting
    //    X-Forwarded-* headers rather than the proxy's own connection.
    for (const term of ['reverse proxy', 'SNI', 'trustProxy', 'X-Forwarded']) {
      assert.ok(doc.includes(term), `docs/tls-termination.md is missing "${term}"`)
    }
  })

  /**
   * Work package #2088: step 3 used to prescribe the boolean `security.trustProxy: true`, which
   * trusts `X-Forwarded-*` unconditionally from anywhere — including a client connecting directly —
   * making `req.ip` the leftmost, client-written `X-Forwarded-For` entry and the login rate limiter
   * bypassable per request. The doc must prescribe the address/CIDR form instead, state that the
   * fronting proxy must overwrite (not append to) `X-Forwarded-For`, and call out
   * `X-Forwarded-Host` as security-relevant to tenant resolution rather than interchangeable
   * plumbing.
   */
  test('step 3 no longer prescribes the broken boolean trustProxy: true', async () => {
    const doc = await readFile(DOC_PATH, 'utf8')
    assert.ok(
      !doc.includes('security.trustProxy: true` in Wiki'),
      'docs/tls-termination.md still prescribes `security.trustProxy: true` as the deployment step'
    )
    assert.ok(
      doc.includes('address or CIDR range') || doc.includes('address/CIDR'),
      'docs/tls-termination.md should name the address/CIDR form of `security.trustProxy`'
    )
    assert.ok(
      /overwrit/i.test(doc) && doc.includes('X-Forwarded-For'),
      'docs/tls-termination.md should state that the proxy must overwrite, not append to, X-Forwarded-For'
    )
    const nginxBlocks = [...doc.matchAll(/```nginx([\s\S]*?)```/g)].map((m) => m[1])
    assert.ok(nginxBlocks.length > 0, 'expected at least one ```nginx sample block')
    for (const block of nginxBlocks) {
      assert.ok(
        block.includes('$remote_addr'),
        'the nginx sample should set X-Forwarded-For from $remote_addr'
      )
      assert.ok(
        !block.includes('$proxy_add_x_forwarded_for'),
        'the nginx sample should not use the appending $proxy_add_x_forwarded_for idiom'
      )
    }
    assert.ok(
      /security-relevant/i.test(doc) && doc.includes('X-Forwarded-Host'),
      'docs/tls-termination.md should mark X-Forwarded-Host as security-relevant to tenant resolution'
    )
  })

  test('does not instruct setting trustProxy in config.yml, since the DB-seeded security row overwrites it on every boot (#1976)', async () => {
    const doc = await readFile(DOC_PATH, 'utf8')
    assert.ok(
      !/set\s+`?security\.trustProxy[^`]*`?\s+in\s+Cardinal\.js's own config/i.test(doc),
      'docs/tls-termination.md still tells the operator to set trustProxy in config.yml, which the DB-seeded security row overwrites on every boot'
    )
    assert.ok(
      /admin (security page|Security page)/i.test(doc),
      'expected docs/tls-termination.md to name the admin Security page as the way to set trustProxy'
    )
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
