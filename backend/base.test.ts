import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { DEFAULT_AUDIT_LOG_RETENTION_DAYS } from './models/auditLog.ts'

const BASE_YML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'base.yml')

/**
 * Regression coverage for OpenProject #2005: `base.yml`'s `defaults.config` is the only backstop for
 * a `settings` key an existing database predates (`core/config.ts` merges it under whatever the DB
 * row provides) -- `auditLog.retentionDays` didn't declare one, so a database whose `settings` table
 * was created before `models/settings.ts#init()` started seeding an `auditLog` row would have no
 * fallback at all. Locks the fallback in place and pins it to the same default `models/auditLog.ts`
 * seeds a fresh install with, so the two can never silently drift apart.
 */
test('base.yml declares an auditLog.retentionDays default matching DEFAULT_AUDIT_LOG_RETENTION_DAYS', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const parsed = load(raw) as any

  assert.equal(parsed.defaults?.config?.auditLog?.retentionDays, DEFAULT_AUDIT_LOG_RETENTION_DAYS)
})

/**
 * Regression coverage for the three dead top-level `defaults.config` keys removed by task 2021
 * (2026-08-24 audit, operability-devex.md §15): `ssl.enabled`, `channel`, `maintainerEmail`. None
 * of the three had a reader anywhere in `backend` or `frontend` -- `ssl.enabled` in particular is
 * actively harmful to keep around, since it reads like the switch for the wiki's own HTTPS listener
 * (which Cardinal.js never terminates) even though nothing ever consulted it, right next to the
 * genuinely-read, doc-commented `db.ssl` that configures the Postgres connection's TLS instead.
 * This locks their removal so none of the three reappears in `base.yml`.
 */
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
 * Regression coverage for task 2240: `base.yml` used to default `auth.secret` to a publicly-known,
 * committed value (`'abcdef1234567890abcdef1234567890abcdef'`), defended only by `preBoot()`'s
 * `loadFromDb()` overlaying the real per-install secret before anything reads it. `models/settings.ts`
 * always seeds a real random secret on first run, so the merge doesn't need this key's shape at all --
 * deleting it means a boot-ordering regression that skips `loadFromDb()` hits
 * `helpers/authSecret.ts`'s `assertValidAuthSecret()` boot guard (see `authSecret.test.ts`) instead of
 * silently signing sessions with a known value.
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
 * OpenProject #2276: `core/db.ts` spreads `WIKI.config.pool` straight into `new Pool({...})`'s
 * options, and until this key existed node-postgres silently applied its own default `max` of 10 —
 * exactly the same number, just never written down anywhere in this repo's own config. Locks that it
 * stays declared, explicit, and a sane positive integer rather than silently reverting to "whatever
 * the library defaults to" on some future edit of this block.
 */
test('base.yml declares an explicit, positive pool.max', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const parsed = load(raw) as any

  assert.ok(parsed.defaults?.config?.pool, 'expected defaults.config.pool to exist in base.yml')
  assert.equal(typeof parsed.defaults.config.pool.max, 'number')
  assert.ok(parsed.defaults.config.pool.max > 0, 'pool.max must be a positive integer')
})
