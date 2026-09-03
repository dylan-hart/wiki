import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Work Package 2091 ("Rename the three measurement admin labels so their scope is explicit"):
 * `AdminAnalytics.vue` ("Analytics Providers" — per-site third-party tracking config) and
 * `AdminPageviews.vue` ("Page Views" — instance-level built-in visit counting) used to share a
 * near-identical label with each other and with `AdminMetrics.vue` ("Metrics" — the Prometheus
 * endpoint), despite living in different, differently-permissioned sidebar sections
 * (`manage:sites` vs `manage:system` — see `docs/decisions/admin-measurement-label-scope.md`).
 * These assertions lock the renamed strings in and guard against the label silently reverting.
 */
describe('backend/locales/en.json admin measurement labels', () => {
  const enJsonPath = path.join(import.meta.dirname, 'en.json')

  async function loadLocale() {
    const raw = await readFile(enJsonPath, 'utf8')
    return { raw, parsed: JSON.parse(raw) }
  }

  test('admin.analytics.title reads "Analytics Providers"', async () => {
    const { parsed } = await loadLocale()
    assert.equal(parsed['admin.analytics.title'], 'Analytics Providers')
  })

  test('admin.pageviews.title reads "Page Views"', async () => {
    const { parsed } = await loadLocale()
    assert.equal(parsed['admin.pageviews.title'], 'Page Views')
  })

  test('admin.metrics.title is unchanged ("Metrics")', async () => {
    const { parsed } = await loadLocale()
    assert.equal(parsed['admin.metrics.title'], 'Metrics')
  })

  // -> A duplicate `admin.analytics.title` key (the regression this rename originally guarded
  //    against) is caught by the general, file-wide duplicate-key guard in `locales/en.test.ts`'s
  //    `has no duplicate keys` test, which line-parses the whole file rather than one key at a time.
})
