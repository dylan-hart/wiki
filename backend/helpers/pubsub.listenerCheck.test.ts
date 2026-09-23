import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, test } from 'node:test'
import { Pool } from 'pg'

import { LISTENER_CHECK_CHANNEL, ListenerDeliveryError, verifyListenerDelivery } from './pubsub.ts'
import { hasTestDatabase } from '../test/db.ts'

class FakeClient extends EventEmitter {
  queries: string[] = []
  released: boolean | undefined = undefined
  async query(text: string): Promise<{ rows: [] }> {
    this.queries.push(text)
    return { rows: [] }
  }
  release(destroy?: boolean): void {
    this.released = destroy === true
  }
}

function fakePool(client: FakeClient): Pool {
  return { connect: async () => client } as unknown as Pool
}

describe('verifyListenerDelivery()', () => {
  test('resolves once the listener receives the nonce it sent, and destroys the client', async () => {
    const client = new FakeClient()
    const sent: Array<[string, string]> = []

    await verifyListenerDelivery({
      listenerPool: fakePool(client),
      notify: async (channel, payload) => {
        sent.push([channel, payload])
        client.emit('notification', { channel, payload, processId: 1 })
      },
      timeoutMs: 1000
    })

    assert.deepEqual(client.queries, [`LISTEN ${LISTENER_CHECK_CHANNEL}`])
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], LISTENER_CHECK_CHANNEL)
    assert.equal(client.released, true, 'released with destroy, so the LISTEN never lingers')
    assert.equal(client.listenerCount('notification'), 0)
  })

  test('never uses the collaboration or event-bus channels', async () => {
    assert.notEqual(LISTENER_CHECK_CHANNEL, 'wiki')
    assert.notEqual(LISTENER_CHECK_CHANNEL, 'wiki_collab')
  })

  test('a notification that never arrives rejects with ListenerDeliveryError and still releases', async () => {
    const client = new FakeClient()

    await assert.rejects(
      verifyListenerDelivery({
        listenerPool: fakePool(client),
        notify: async () => {},
        timeoutMs: 20
      }),
      (err: unknown) => {
        assert.ok(err instanceof ListenerDeliveryError)
        assert.match(err.message, /DATABASE_DIRECT_URL/)
        assert.match(err.message, /docs\/pgbouncer-deployment\.md/)
        return true
      }
    )
    assert.equal(client.released, true)
  })

  test("another instance's check, or a stray payload on the channel, does not count", async () => {
    const client = new FakeClient()

    await assert.rejects(
      verifyListenerDelivery({
        listenerPool: fakePool(client),
        notify: async (channel) => {
          client.emit('notification', { channel, payload: 'someone-else', processId: 1 })
          client.emit('notification', { channel: 'wiki', payload: 'x', processId: 1 })
        },
        timeoutMs: 20
      }),
      ListenerDeliveryError
    )
  })

  test('a failing NOTIFY propagates its own error and releases the client', async () => {
    const client = new FakeClient()
    const boom = new Error('permission denied')

    await assert.rejects(
      verifyListenerDelivery({
        listenerPool: fakePool(client),
        notify: async () => {
          throw boom
        },
        timeoutMs: 1000
      }),
      (err) => err === boom
    )
    assert.equal(client.released, true)
  })

  test('an error event on the client during the check does not crash the process', async () => {
    const client = new FakeClient()

    await verifyListenerDelivery({
      listenerPool: fakePool(client),
      notify: async (channel, payload) => {
        client.emit('error', new Error('connection reset'))
        client.emit('notification', { channel, payload, processId: 1 })
      },
      timeoutMs: 1000
    })
    assert.equal(client.released, true)
  })

  test(
    'against a real Postgres, a NOTIFY through one pool reaches a LISTEN on another',
    { skip: hasTestDatabase() ? false : 'requires DATABASE_URL' },
    async () => {
      const connectionString = process.env.DATABASE_URL!
      const queryPool = new Pool({ connectionString, max: 1 })
      const listenerPool = new Pool({ connectionString, max: 1 })
      try {
        await verifyListenerDelivery({
          listenerPool,
          notify: (channel, payload) =>
            queryPool.query('SELECT pg_notify($1, $2)', [channel, payload]),
          timeoutMs: 5000
        })
      } finally {
        await queryPool.end()
        await listenerPool.end()
      }
    }
  )
})
