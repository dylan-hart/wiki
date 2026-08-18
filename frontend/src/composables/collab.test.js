import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * Task 482: verify the reconnect-with-offline-edits path end to end on the browser side.
 *
 * `y-websocket`'s real `WebsocketProvider` needs an actual `WebSocket` and a server on the other end
 * of it, neither of which exists in this unit test -- so it is mocked with a small fake that the test
 * drives by hand, emitting exactly the `status`/`sync` events the real library emits (see
 * `node_modules/y-websocket/src/y-websocket.js`) in exactly the order a real reconnect produces them:
 * `disconnected` -> `connecting` -> (`sync`, `true`) -> `connected`. What this buys over trusting the
 * library is coverage of `composables/collab.js`'s OWN reaction to that sequence -- the thing task 482
 * flags as most likely to regress.
 */

const { FakeWebsocketProvider } = vi.hoisted(() => {
  class FakeAwareness {
    constructor() {
      this.states = new Map()
      this.listeners = {}
    }

    setLocalStateField(key, value) {
      const self = this.states.get(0) ?? {}
      self[key] = value
      this.states.set(0, self)
    }

    setLocalState(value) {
      if (value === null) {
        this.states.delete(0)
      }
    }

    getLocalState() {
      return this.states.get(0) ?? null
    }

    getStates() {
      return this.states
    }

    on() {}

    off() {}
  }

  class FakeWebsocketProvider {
    constructor(url, room, doc, opts) {
      this.url = url
      this.room = room
      this.doc = doc
      this.opts = opts
      this.awareness = new FakeAwareness()
      this.listeners = {}
      this.shouldConnect = true
      this.destroyed = false
      FakeWebsocketProvider.instances.push(this)
    }

    on(event, cb) {
      ;(this.listeners[event] ??= []).push(cb)
    }

    emit(event, ...args) {
      for (const cb of this.listeners[event] ?? []) {
        cb(...args)
      }
    }

    disconnect() {}

    destroy() {
      this.destroyed = true
    }
  }
  FakeWebsocketProvider.instances = []

  return { FakeWebsocketProvider }
})

vi.mock('y-websocket', () => ({ WebsocketProvider: FakeWebsocketProvider }))
vi.mock('y-monaco', () => ({ MonacoBinding: class {} }))

const { collabStatusEffects, startCollabSession, stopCollabSession } = await import('./collab.js')
const { useCollabStore } = await import('@/stores/collab')
const { usePageStore } = await import('@/stores/page')
const { useSiteStore } = await import('@/stores/site')
const { useUserStore } = await import('@/stores/user')

function latestProvider() {
  return FakeWebsocketProvider.instances.at(-1)
}

beforeEach(() => {
  setActivePinia(createPinia())
  FakeWebsocketProvider.instances.length = 0
})

afterEach(() => {
  // -> The composable's `doc`/`provider` are module-level singletons, not component state -- must be
  //    torn down between tests the same way `EditorMarkdown.vue`'s `onBeforeUnmount` does, or a later
  //    test would silently reuse the previous test's session.
  stopCollabSession()
})

describe('collabStatusEffects', () => {
  it('locks the editor only for the very first connect, before anything has ever synced', () => {
    expect(collabStatusEffects('connecting', false).readOnly).toBe(true)
  })

  it('never re-locks a reconnect´s trip back through "connecting" once the first sync happened', () => {
    // -> This is the exact guard `stores/collab.js`'s doc comment describes and task 482 calls out as
    //    the thing most likely to regress: same raw status as the very first connect, different
    //    outcome because `hasSynced` is now true.
    expect(collabStatusEffects('connecting', true).readOnly).toBe(false)
  })

  it('releases the editor on every other status, synced or not', () => {
    for (const hasSynced of [false, true]) {
      expect(collabStatusEffects('disconnected', hasSynced).readOnly).toBe(false)
      expect(collabStatusEffects('connected', hasSynced).readOnly).toBe(false)
      expect(collabStatusEffects('denied', hasSynced).readOnly).toBe(false)
    }
  })

  it('binds the editor only once the session is genuinely live', () => {
    expect(collabStatusEffects('connected', true).shouldBindEditor).toBe(true)
    for (const status of ['connecting', 'disconnected', 'denied']) {
      expect(collabStatusEffects(status, true).shouldBindEditor).toBe(false)
    }
  })

  it('flags a notification only for the terminal "denied" status', () => {
    expect(collabStatusEffects('denied', true).notifyDenied).toBe(true)
    for (const status of ['connecting', 'connected', 'disconnected']) {
      expect(collabStatusEffects(status, true).notifyDenied).toBe(false)
    }
  })
})

describe('startCollabSession reconnect behavior', () => {
  function boot() {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    const userStore = useUserStore()
    siteStore.id = 'site-1'
    pageStore.id = 'page-1'
    userStore.id = 'user-1'
    userStore.name = 'Ada Lovelace'
    startCollabSession({ siteId: siteStore.id, pageId: pageStore.id })
    return { collabStore: useCollabStore(), provider: latestProvider() }
  }

  it('pins an explicit reconnect backoff ceiling rather than trusting the library default', () => {
    const { provider } = boot()
    // -> A future `y-websocket` bump changing its own default must not silently change how long a
    //    real outage takes to recover from once connectivity returns.
    expect(provider.opts).toMatchObject({ maxBackoffTime: 2500 })
  })

  it('walks disconnected -> connecting -> connected on reconnect, without tearing down the session', () => {
    const { collabStore, provider } = boot()

    // -> First connect and sync, exactly like a normal session opening.
    provider.emit('status', { status: 'connecting' })
    provider.emit('sync', true)
    expect(collabStore.status).toBe('connected')
    expect(collabStore.hasSynced).toBe(true)

    // -> The network drops. `y-websocket` reports this as `disconnected`, never `connecting` first.
    provider.emit('sync', false)
    provider.emit('status', { status: 'disconnected' })
    expect(collabStore.status).toBe('disconnected')
    // -> hasSynced must survive a disconnect, not just a resync
    expect(collabStore.hasSynced).toBe(true)

    // -> Connectivity returns; `y-websocket` retries on its own and reports the retry.
    provider.emit('status', { status: 'connecting' })
    expect(collabStore.status).toBe('connecting')

    // -> The reconnect resyncs.
    provider.emit('sync', true)
    expect(collabStore.status).toBe('connected')
    expect(collabStore.hasSynced).toBe(true)

    // -> Never a new `Y.Doc`/`WebsocketProvider` for the same reconnect -- that is what actually keeps
    //    local edits made while disconnected: the very same document they were written into.
    expect(FakeWebsocketProvider.instances.length).toBe(1)
    expect(provider.destroyed).toBe(false)
  })

  it('never reports "connected" from the raw socket alone -- only a real sync earns that status', () => {
    const { collabStore, provider } = boot()

    provider.emit('status', { status: 'connecting' })
    // -> The socket is up, but nothing has synced yet: y-websocket's own 'connected' status must not
    //    leak into the store as-is (see the comment in `composables/collab.js`).
    provider.emit('status', { status: 'connected' })
    expect(collabStore.status).toBe('connecting')

    provider.emit('sync', true)
    expect(collabStore.status).toBe('connected')
  })

  it('a final "denied" close is sticky: reconnect status changes after it are ignored', () => {
    const { collabStore, provider } = boot()

    provider.emit('status', { status: 'connecting' })
    provider.emit('sync', true)
    provider.emit('connection-close', { code: 4001 })
    expect(collabStore.status).toBe('denied')

    // -> Some late `status` events can still arrive from a socket already being torn down.
    provider.emit('status', { status: 'connecting' })
    provider.emit('status', { status: 'disconnected' })
    expect(collabStore.status).toBe('denied')
  })
})
