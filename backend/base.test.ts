import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { DEFAULT_AUDIT_LOG_RETENTION_DAYS } from './models/auditLog.ts'

const BASE_YML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'base.yml')

/**
 * `defaults.config` is the only fallback for a `settings` key an existing database predates, so it
 * must equal what a fresh install is seeded with.
 */
test('base.yml declares an auditLog.retentionDays default matching DEFAULT_AUDIT_LOG_RETENTION_DAYS', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const parsed = load(raw) as any

  assert.equal(parsed.defaults?.config?.auditLog?.retentionDays, DEFAULT_AUDIT_LOG_RETENTION_DAYS)
})

test('base.yml has no top-level ssl, channel, or maintainerEmail keys', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const data = load(raw) as Record<string, any>
  const config = data.defaults?.config

  assert.ok(config, 'expected defaults.config to exist in base.yml')
  assert.equal(
    Object.hasOwn(config, 'ssl'),
    false,
    'top-level ssl is dead (never read anywhere) and must not reappear in base.yml -- db.ssl is the real, read TLS setting'
  )
  assert.equal(
    Object.hasOwn(config, 'channel'),
    false,
    'channel is dead (never read anywhere) and must not reappear in base.yml'
  )
  assert.equal(
    Object.hasOwn(config, 'maintainerEmail'),
    false,
    'maintainerEmail is dead (never read anywhere) and must not reappear in base.yml'
  )
})

/**
 * `models/settings.ts` seeds a real random secret on first run. With no default here, a boot that
 * skips `loadFromDb()` trips `helpers/authSecret.ts`'s `assertValidAuthSecret()` guard instead of
 * signing sessions with a publicly-known value.
 */
test('base.yml does not define a default auth.secret', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const data = load(raw) as Record<string, any>

  assert.equal(
    Object.hasOwn(data.auth ?? {}, 'secret'),
    false,
    'auth.secret must not have a default in base.yml -- models/settings.ts#init() always seeds the real one'
  )
  assert.doesNotMatch(
    raw,
    /abcdef1234567890/,
    'the old committed default auth.secret must not reappear'
  )
})

/**
 * `core/db.ts` spreads `CARDINAL.config.pool` into `new Pool()`: left undeclared, `max` silently
 * becomes node-postgres's own default.
 */
test('base.yml declares an explicit, positive pool.max', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const parsed = load(raw) as any

  assert.ok(parsed.defaults?.config?.pool, 'expected defaults.config.pool to exist in base.yml')
  assert.equal(typeof parsed.defaults.config.pool.max, 'number')
  assert.ok(parsed.defaults.config.pool.max > 0, 'pool.max must be a positive integer')
})

/**
 * `warnUnknownConfigKeys` descends into any key that is a plain object on both sides, so `{}` would
 * warn about every real entry on every boot. Null stops the walk at the key, and `toMerged` still
 * lets a config.yml map replace it. Undeclared, the key itself would be flagged by the same walk.
 */
test('base.yml declares logScopes as an explicit null, not an empty map', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const parsed = load(raw) as any
  const config = parsed.defaults?.config

  assert.ok(Object.hasOwn(config, 'logScopes'), 'defaults.config.logScopes must be declared')
  assert.equal(
    config.logScopes,
    null,
    'logScopes must be null, not {} -- see warnUnknownConfigKeys in core/config.ts'
  )
})

/** Nothing reads it (`logScopes: { sql: debug }` is the switch): it would silently do nothing. */
test('base.yml has no dev.logQueries key', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const parsed = load(raw) as any

  assert.ok(parsed.defaults?.config?.dev, 'expected defaults.config.dev to exist in base.yml')
  assert.equal(Object.hasOwn(parsed.defaults.config.dev, 'logQueries'), false)
})

test('base.yml declares db.direct with null host and port, so the direct route is off by default', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const parsed = load(raw) as any
  const direct = parsed.defaults?.config?.db?.direct

  assert.deepEqual(
    direct,
    { host: null, port: null },
    'db.direct must declare host and port (so config.yml entries under it are not flagged as unknown keys) and default both to null'
  )
})
