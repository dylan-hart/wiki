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
