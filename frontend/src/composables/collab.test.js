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

const { bindCollabEditor, collabStatusEffects, startCollabSession, stopCollabSession } =
  await import('./collab.js')
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

/**
 * Feature #2426 ("Autosave draft while editing"): a room that started from a persisted draft rather
 * than the stored page (`core/collab.ts#initRoom()`) marks it on `meta.draftRestored`, and the very
 * first sync is what has to surface it -- unlike `lastSave`, this is inherited room state a joining
 * editor needs to see, not only news that arrives mid-session.
 */
describe('draftRestored (Feature #2426)', () => {
  function boot() {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    const userStore = useUserStore()
    siteStore.id = 'site-1'
    pageStore.id = 'page-1'
    userStore.id = 'user-1'
    userStore.name = 'Ada Lovelace'
    const { doc } = startCollabSession({ siteId: siteStore.id, pageId: pageStore.id })
    return { collabStore: useCollabStore(), provider: latestProvider(), doc }
  }

  it('is null before anything has synced', () => {
    const { collabStore } = boot()
    expect(collabStore.draftRestored).toBe(null)
  })

  it('is read off the room´s meta map the moment the first sync lands', () => {
    const { collabStore, provider, doc } = boot()
    // -> Set the way `core/collab.ts#initRoom()` sets it, before this client ever connects -- the
    //    real server writes this into the document itself, not a message this client reacts to.
    doc.getMap('meta').set('draftRestored', { at: '2026-09-03T00:00:00.000Z' })

    provider.emit('status', { status: 'connecting' })
    provider.emit('sync', true)

    expect(collabStore.draftRestored).toEqual({ at: '2026-09-03T00:00:00.000Z' })
  })

  it('stays null for an ordinary room that started from the stored page, not a draft', () => {
    const { collabStore, provider } = boot()

    provider.emit('status', { status: 'connecting' })
    provider.emit('sync', true)

    expect(collabStore.draftRestored).toBe(null)
  })

  it('is cleared by stopCollabSession(), like the rest of the session state', () => {
    const { collabStore, provider, doc } = boot()
    doc.getMap('meta').set('draftRestored', { at: '2026-09-03T00:00:00.000Z' })
    provider.emit('sync', true)
    expect(collabStore.draftRestored).not.toBe(null)

    stopCollabSession()

    expect(collabStore.draftRestored).toBe(null)
  })
})

/**
 * Task 485: `bindCollabEditor` must not assume Monaco.
 *
 * Prior to this task it constructed `y-monaco`'s `MonacoBinding` directly, so any other editor --
 * TipTap included -- had no way to bind to the same session. It now takes a factory and hands it the
 * two things every binding needs (the shared `ytext`, the provider's `awareness`), leaving how those
 * turn into a live binding, and what (if anything) needs tearing down later, entirely up to the
 * caller.
 */
describe('bindCollabEditor', () => {
  function boot() {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    const userStore = useUserStore()
    siteStore.id = 'site-1'
    pageStore.id = 'page-1'
    userStore.id = 'user-1'
    userStore.name = 'Ada Lovelace'
    startCollabSession({ siteId: siteStore.id, pageId: pageStore.id })
    return { provider: latestProvider() }
  }

  it('does nothing until a session is open -- there is no shared document to bind to yet', () => {
    const createBinding = vi.fn()
    bindCollabEditor(createBinding)
    expect(createBinding).not.toHaveBeenCalled()
  })

  it('hands the factory the session´s real shared text and the live awareness, editor-agnostic', () => {
    const { provider } = boot()
    let seenYtext = null
    let seenAwareness = null
    bindCollabEditor((ytext, awareness) => {
      seenYtext = ytext
      seenAwareness = awareness
      return { destroy: vi.fn() }
    })
    expect(seenAwareness).toBe(provider.awareness)
    // -> A real Y.Text bound to this session's own document, not a stand-in -- so any real binding
    //    (Monaco's, TipTap's, or a test double) sees genuine session content.
    seenYtext.insert(0, 'hello')
    expect(seenYtext.toString()).toBe('hello')
  })

  it('binds only once per session -- a second call is a no-op', () => {
    boot()
    const first = vi.fn(() => ({ destroy: vi.fn() }))
    const second = vi.fn()
    bindCollabEditor(first)
    bindCollabEditor(second)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('tears down whatever the factory returned when the session stops', () => {
    boot()
    const fakeBinding = { destroy: vi.fn() }
    bindCollabEditor(() => fakeBinding)
    stopCollabSession()
    expect(fakeBinding.destroy).toHaveBeenCalledTimes(1)
  })

  it('tolerates a factory that owns its own lifecycle and returns nothing to track', () => {
    // -> This is TipTap's shape: `@tiptap/extension-collaboration` binds itself once configured with
    //    the document, and there is nothing left for this session to hold onto or tear down.
    boot()
    expect(() => bindCollabEditor(() => undefined)).not.toThrow()
    expect(() => stopCollabSession()).not.toThrow()
  })
})
