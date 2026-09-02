import assert from 'node:assert/strict'
import { afterEach, describe, mock, test } from 'node:test'
import { ClusterReloaded } from './clusterCache.ts'
import { createEventsStub } from '../test/mocks.ts'

/**
 * A minimal subclass standing in for the five models that extend `ClusterReloaded`: it declares an
 * event name and counts the reloads it is asked for, which is the whole of what the base class
 * promises to drive.
 */
class FakeCachedModel extends ClusterReloaded {
  protected readonly reloadEvent = 'reloadFakes'
  reloadCache = mock.fn(async () => {})
}

/** Installs just the `WIKI.events` member `ClusterReloaded` reads, and hands the stub back. */
function installEvents() {
  const events = createEventsStub()
  globalThis.WIKI = { events } as any
  return events
}

afterEach(() => {
  delete (globalThis as any).WIKI
})

describe('ClusterReloaded', () => {
  test('broadcastReload reloads this instance, then emits the reload event outbound', async () => {
    const events = installEvents()
    const model = new FakeCachedModel()

    await model.broadcastReload()

    assert.equal(model.reloadCache.mock.callCount(), 1)
    assert.equal(events.outbound.emit.mock.callCount(), 1)
    assert.deepEqual(events.outbound.emit.mock.calls[0].arguments, ['reloadFakes'])
    // -> Nothing goes out on the inbound bus: that one carries other instances' events INTO this one.
    assert.equal(events.inbound.emit.mock.callCount(), 0)
  })

  test('broadcastReload reloads before it emits, so a listener never sees a stale cache', async () => {
    const events = installEvents()
    const order: string[] = []
    const model = new FakeCachedModel()
    model.reloadCache = mock.fn(async () => {
      order.push('reload')
    })
    events.outbound.emit = mock.fn(() => {
      order.push('emit')
    })

    await model.broadcastReload()

    assert.deepEqual(order, ['reload', 'emit'])
  })

  test('subscribeToEvents registers an inbound handler that reloads without re-broadcasting', async () => {
    const events = installEvents()
    const model = new FakeCachedModel()

    model.subscribeToEvents()

    assert.equal(events.inbound.on.mock.callCount(), 1)
    const [eventName, handler] = events.inbound.on.mock.calls[0].arguments
    assert.equal(eventName, 'reloadFakes')

    await handler()

    assert.equal(model.reloadCache.mock.callCount(), 1)
    // -> The echo rule: answering another instance's event must never emit one back, or the reload
    //    bounces around the cluster forever.
    assert.equal(events.outbound.emit.mock.callCount(), 0)
  })

  test('each subclass broadcasts under its own event name', async () => {
    const events = installEvents()
    class OtherModel extends ClusterReloaded {
      protected readonly reloadEvent = 'reloadOthers'
      async reloadCache(): Promise<void> {}
    }

    await new OtherModel().broadcastReload()

    assert.deepEqual(events.outbound.emit.mock.calls[0].arguments, ['reloadOthers'])
  })
})
