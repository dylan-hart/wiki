import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import path from 'node:path'

let analyticsModel: typeof import('./analytics.ts').analytics

before(async () => {
  ;(globalThis as any).CARDINAL = {
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
  delete (globalThis as any).CARDINAL
})

// `base.yml` declares no `analytics` key, so the field exists only because `refreshFromDisk()` put
// it there — readers index into it unguarded.
test('a scan that fails leaves CARDINAL.data.analytics an empty array rather than undefined', async () => {
  const previousServerPath = (globalThis as any).CARDINAL.SERVERPATH
  ;(globalThis as any).CARDINAL.SERVERPATH = path.join(import.meta.dirname, '..', '__no-such-dir__')
  ;(globalThis as any).CARDINAL.data = {}
  try {
    await analyticsModel.refreshFromDisk()
    assert.deepEqual(CARDINAL.data.analytics, [])
    assert.deepEqual(analyticsModel.getModules(), [])
  } finally {
    ;(globalThis as any).CARDINAL.SERVERPATH = previousServerPath
    ;(globalThis as any).CARDINAL.data = {}
  }
})
