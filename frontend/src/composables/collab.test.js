import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { queue as notifyQueue } from '@/composables/notify'

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

/*
  `confirm()`'s real chain (`composables/dialog.js`) opens a `<w-dialog>` component that resolves
  asynchronously through user interaction -- nothing this unit test can drive. This stand-in keeps the
  same chainable shape (`.onOk(cb).onCancel(cb)`, both registering on the one object confirm() itself
  returns) so a test decides which branch fires by calling `.okCb()`/`.cancelCb()` directly, the same
  way `GlossaryImportDialog.test.js` drives its own `confirm()` mock.
*/
const confirmMock = vi.fn(() => {
  const chain = {
    onOk(cb) {
      chain.okCb = cb
      return chain
    },
    onCancel(cb) {
      chain.cancelCb = cb
      return chain
    },
    onDismiss() {
      return chain
    }
  }
  return chain
})
vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  confirm: (...args) => confirmMock(...args)
}))

/*
  `composables/collab.js` reads the app's real i18n singleton (`@/boot/i18n`), which nothing in this
  unit test's harness ever boots (no `main.js`, no locale strings loaded from the server) -- so `t()`
  is stood in with a marker that echoes back exactly which key and params it was called with. What is
  worth asserting here is the WIRING (the right key, the right interpolation params for "known
  author" vs "unknown author"), not the English wording itself, which `en.json` already owns.
*/
vi.mock('@/boot/i18n', () => ({
  i18n: { global: { t: (key, params) => JSON.stringify({ key, params: params ?? null }) } }
}))

const {
  applyRestoredDraft,
  bindCollabEditor,
  collabStatusEffects,
  startCollabSession,
  stopCollabSession
} = await import('./collab.js')
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
  confirmMock.mockClear()
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

/**
 * OpenProject #2455: on a page whose collaboration room last closed with unsaved edits still
 * pending, the reader is offered to restore them once the session syncs.
 */
describe('offerDraftRestore / applyRestoredDraft', () => {
  function boot({ draft = null } = {}) {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    const userStore = useUserStore()
    siteStore.id = 'site-1'
    pageStore.id = 'page-1'
    pageStore.draft = draft
    userStore.id = 'user-1'
    userStore.name = 'Ada Lovelace'
    startCollabSession({ siteId: siteStore.id, pageId: pageStore.id })
    return { pageStore, provider: latestProvider() }
  }

  it('does not prompt when the page carries no recorded draft', () => {
    const { provider } = boot({ draft: null })
    provider.emit('sync', true)
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('prompts once the session syncs when a draft is recorded, and clears pageStore.draft right away', () => {
    const { pageStore, provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    provider.emit('sync', true)

    expect(confirmMock).toHaveBeenCalledTimes(1)
    const opts = confirmMock.mock.calls[0][0]
    expect(JSON.parse(opts.title)).toEqual({
      key: 'editor.collab.draftRecovery.title',
      params: null
    })
    expect(JSON.parse(opts.message)).toEqual({
      key: 'editor.collab.draftRecovery.messageBy',
      params: { authorName: 'Grace Hopper' }
    })
    expect(opts.persistent).toBe(true)
    // -> Consumed immediately, not left standing as "still pending" while the dialog is up
    expect(pageStore.draft).toBe(null)
  })

  it('falls back to the name-less message key when the draft carries no author', () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: null }
    })
    provider.emit('sync', true)
    const opts = confirmMock.mock.calls[0][0]
    expect(JSON.parse(opts.message)).toEqual({
      key: 'editor.collab.draftRecovery.message',
      params: null
    })
  })

  it('never prompts twice in the same session, even across a reconnect´s second sync', () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    provider.emit('sync', true)
    provider.emit('sync', false)
    provider.emit('sync', true)
    expect(confirmMock).toHaveBeenCalledTimes(1)
  })

  it('restoring fetches the draft content and applies it into the shared document and page store', async () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    let seenYtext = null
    bindCollabEditor((ytext) => {
      seenYtext = ytext
      return { destroy: vi.fn() }
    })
    seenYtext.insert(0, 'stale content')

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          content: 'the restored content',
          title: 'Restored Title',
          description: 'Restored description',
          icon: 'mdi:restore'
        })
    })

    provider.emit('sync', true)
    const chain = confirmMock.mock.results.at(0).value
    await chain.okCb()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/page-1/draft')
    expect(seenYtext.toString()).toBe('the restored content')
    expect(usePageStore().title).toBe('Restored Title')
    expect(usePageStore().description).toBe('Restored description')
    expect(usePageStore().icon).toBe('mdi:restore')
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'positive' })
  })

  it('a failed restore notifies negatively and leaves the document untouched', async () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    let seenYtext = null
    bindCollabEditor((ytext) => {
      seenYtext = ytext
      return { destroy: vi.fn() }
    })
    seenYtext.insert(0, 'unchanged content')

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.reject(new Error('network'))
    })

    provider.emit('sync', true)
    const chain = confirmMock.mock.results.at(0).value
    await chain.okCb()

    expect(seenYtext.toString()).toBe('unchanged content')
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative' })
  })

  it('discarding calls DELETE and never touches the shared document', async () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    let seenYtext = null
    bindCollabEditor((ytext) => {
      seenYtext = ytext
      return { destroy: vi.fn() }
    })
    seenYtext.insert(0, 'unchanged content')

    provider.emit('sync', true)
    const chain = confirmMock.mock.results.at(0).value
    await chain.cancelCb()

    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/pages/page-1/draft')
    expect(API_CLIENT.get).not.toHaveBeenCalled()
    expect(seenYtext.toString()).toBe('unchanged content')
  })

  it('applyRestoredDraft is a no-op once the session has already ended', () => {
    boot({ draft: null })
    stopCollabSession()
    expect(() =>
      applyRestoredDraft({ content: 'x', title: 'x', description: 'x', icon: 'x' })
    ).not.toThrow()
  })
})
