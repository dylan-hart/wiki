import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards work package #1976 — `config.sample.yml` never documented the `$(VAR:default)`
 * substitution `parseConfigValue` (`backend/helpers/config.ts`) applies to it, nor the
 * three-source precedence (`base.yml` -> `config.yml` -> DB `settings` table, DB wins) that
 * `core/config.ts` implements, nor the `pool`/`files.cacheMaxSize` tunables that are spread
 * straight into `new Pool()` (`core/db.ts`) and read by `models/assets.ts` with no mention in the
 * sample file at all. This test locks the header content down so it can't quietly regress.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..')
const SAMPLE_PATH = path.join(REPO_ROOT, 'config.sample.yml')

describe('config.sample.yml documentation header (#1976)', () => {
  test('documents the $(VAR:default) substitution syntax with a worked example', async () => {
    const sample = await readFile(SAMPLE_PATH, 'utf8')
    assert.ok(
      sample.includes('$(') && sample.includes(':default)'),
      'expected the $(VAR:default) syntax to be shown'
    )
    // -> A worked example: some concrete env var name substituted with a fallback, not just the
    //    abstract placeholder syntax.
    assert.match(
      sample,
      /\$\([A-Z0-9_]+:[^)]+\)/,
      'expected a worked $(ENV_VAR_NAME:default) example, not just the abstract syntax'
    )
  })

  test('documents the three-source precedence and names the DB-owned key groups', async () => {
    const sample = await readFile(SAMPLE_PATH, 'utf8')
    for (const term of ['base.yml', 'config.yml', 'settings']) {
      assert.ok(sample.includes(term), `expected config.sample.yml to mention "${term}"`)
    }
    // -> The DB-owned key groups from models/settings.ts's seeded rows.
    const dbOwnedGroups = [
      'api',
      'auditLog',
      'auth',
      'flags',
      'icons',
      'mail',
      'metrics',
      'pageviews',
      'search',
      'security',
      'update',
      'userDefaults'
    ]
    for (const group of dbOwnedGroups) {
      assert.ok(
        sample.includes(group),
        `expected config.sample.yml to name the DB-owned key group "${group}"`
      )
    }
  })

  test('documents the pool tunables and their effective defaults', async () => {
    const sample = await readFile(SAMPLE_PATH, 'utf8')
    assert.ok(sample.includes('pool'), 'expected config.sample.yml to mention `pool`')
    assert.ok(sample.includes('min'), 'expected config.sample.yml to mention `pool.min`')
    assert.ok(sample.includes('max'), 'expected config.sample.yml to mention `pool.max`')
    // -> The real effective default: base.yml only sets min: 1, no max is set anywhere, so pg's
    //    own default (10) is what actually applies. The doc must say so, not invent a config-side
    //    default.
    assert.ok(
      /\b10\b/.test(sample) && /pg|postgres/i.test(sample),
      "expected config.sample.yml to state that pg's own default of 10 applies to `pool.max` when unset"
    )
  })

  test('documents files.cacheMaxSize and its effective default', async () => {
    const sample = await readFile(SAMPLE_PATH, 'utf8')
    assert.ok(
      sample.includes('cacheMaxSize'),
      'expected config.sample.yml to mention `files.cacheMaxSize`'
    )
    assert.ok(
      sample.includes('536870912'),
      'expected config.sample.yml to state the 536870912-byte default'
    )
  })
})
