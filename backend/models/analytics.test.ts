import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import path from 'node:path'

/**
 * Coverage for Task 592: analytics module discovery.
 *
 * `models/analytics.ts` mirrors `models/authentication.ts`'s directory-scan pattern — readdir
 * `modules/analytics`, parse each `definition.yml`, run its `props` through
 * `helpers/moduleProps.ts#parseModuleProps` — but has no db table behind it, since a provider's
 * enabled/config state lives directly in each site's `config.analytics.providers` rather than being
 * shared instance-wide the way an auth strategy is. This is a plain unit test against the real
 * `modules/analytics` directory added by this task: no db, no fastify app, just `fs` + `js-yaml`.
 */

let analyticsModel: typeof import('./analytics.ts').analytics

before(async () => {
  ;(globalThis as any).WIKI = {
    SERVERPATH: path.join(import.meta.dirname, '..'),
    data: {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    }
  }
  ;({ analytics: analyticsModel } = await import('./analytics.ts'))
})

after(() => {
  delete (globalThis as any).WIKI
})

test('refreshFromDisk() discovers all three modules this task adds', async () => {
  await analyticsModel.refreshFromDisk()
  const modules = analyticsModel.getModules()
  const keys = modules.map((m) => m.key).sort()
  assert.deepEqual(keys, ['google', 'gtm', 'matomo'])
})

test('getModules() sorts alphabetically by title', async () => {
  await analyticsModel.refreshFromDisk()
  const titles = analyticsModel.getModules().map((m) => m.title)
  assert.deepEqual(
    titles,
    [...titles].sort((a, b) => a.localeCompare(b))
  )
})

test('google declares a propertyTrackingId string prop hinting the G-XXXXXXXXXX format', async () => {
  await analyticsModel.refreshFromDisk()
  const google = analyticsModel.getModule('google')
  assert.ok(google)
  assert.equal(google!.isAvailable, true)
  assert.equal(google!.props.propertyTrackingId.type, 'string')
  assert.equal(google!.props.propertyTrackingId.hint, 'G-XXXXXXXXXX')
})

test('gtm declares a containerTrackingId string prop hinting the GTM-XXXXXXX format', async () => {
  await analyticsModel.refreshFromDisk()
  const gtm = analyticsModel.getModule('gtm')
  assert.ok(gtm)
  assert.equal(gtm!.props.containerTrackingId.type, 'string')
  assert.equal(gtm!.props.containerTrackingId.hint, 'GTM-XXXXXXX')
})

test('matomo declares siteId and serverHost props with the real upstream defaults', async () => {
  await analyticsModel.refreshFromDisk()
  const matomo = analyticsModel.getModule('matomo')
  assert.ok(matomo)
  assert.equal(matomo!.props.siteId.type, 'string')
  assert.equal(matomo!.props.siteId.default, 1)
  assert.equal(matomo!.props.serverHost.type, 'string')
  assert.equal(matomo!.props.serverHost.default, 'https://example.matomo.cloud')
})

test('getModule() returns null for a key nothing on disk declares', async () => {
  await analyticsModel.refreshFromDisk()
  assert.equal(analyticsModel.getModule('does-not-exist'), null)
})

/**
 * A failed scan must still leave `WIKI.data.analytics` an array: `base.yml` declares no `analytics`
 * key, so the field only exists because `refreshFromDisk()` put it there — the same invariant
 * `models/authentication.test.ts` locks down for its own `WIKI.data.authentication` readers.
 */
test('a scan that fails leaves WIKI.data.analytics an empty array rather than undefined', async () => {
  const previousServerPath = (globalThis as any).WIKI.SERVERPATH
  // -> A directory that does not exist: `readdir` rejects before a single definition is read.
  ;(globalThis as any).WIKI.SERVERPATH = path.join(import.meta.dirname, '..', '__no-such-dir__')
  ;(globalThis as any).WIKI.data = {}
  try {
    await analyticsModel.refreshFromDisk()
    assert.deepEqual(WIKI.data.analytics, [])
    assert.deepEqual(analyticsModel.getModules(), [])
  } finally {
    ;(globalThis as any).WIKI.SERVERPATH = previousServerPath
    ;(globalThis as any).WIKI.data = {}
  }
})
