import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { queue as notifyQueue } from '@/composables/notify'

/**
 * `y-websocket`'s real `WebsocketProvider` needs an actual `WebSocket` and a server on the other end
 * of it, neither of which exists in a unit test -- so it is faked, and driven by hand. The fake
 * emits the same `status`/`sync` events the real library does, in the order a real reconnect
 * produces them: `disconnected` -> `connecting` -> (`sync`, `true`) -> `connected`. What that covers
 * is `composables/collab.js`'s OWN reaction to the sequence.
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

    on(event, cb) {
      ;(this.listeners[event] ??= []).push(cb)
    }

    off(event, cb) {
      this.listeners[event] = (this.listeners[event] ?? []).filter((fn) => fn !== cb)
    }

    // -> Not part of the real y-protocols API: a test-only hook for driving the 'change' listener
    //    `composables/collab.js` registers through `on()` above.
    emit(event, ...args) {
      for (const cb of this.listeners[event] ?? []) {
        cb(...args)
      }
    }
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
  The real `dialog()` mounts a component that resolves through user interaction, which a unit test
  cannot drive. This stand-in keeps the same chainable shape so a test picks the branch by calling
  `.okCb()`/`.cancelCb()` directly. The component passed is a `defineAsyncComponent` wrapper, so
  only `componentProps` is worth asserting, not identity.
*/
const dialogMock = vi.fn(() => {
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
  dialog: (...args) => dialogMock(...args)
}))

/*
  `composables/collab.js` reads the app's real i18n singleton, which this harness never boots, so
  `t()` echoes back the key and params it was called with: the wiring is what is worth asserting,
  not the English wording `en.json` owns.
*/
vi.mock('@/boot/i18n', () => ({
  i18n: { global: { t: (key, params) => JSON.stringify({ key, params: params ?? null }) } }
}))

const {
  applyRestoredDraft,
  bindCollabEditor,
  claimWysiwygSeed,
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
  dialogMock.mockClear()
})

afterEach(() => {
  // -> The composable's `doc`/`provider` are module-level singletons, not component state, so
  //    without this a later test silently reuses the previous test's session.
  stopCollabSession()
})

describe('collabStatusEffects', () => {
  it('locks the editor only for the very first connect, before anything has ever synced', () => {
    expect(collabStatusEffects('connecting', false).readOnly).toBe(true)
  })

  it('never re-locks a reconnect´s trip back through "connecting" once the first sync happened', () => {
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
    expect(provider.opts).toMatchObject({ maxBackoffTime: 2500 })
  })

  it('walks disconnected -> connecting -> connected on reconnect, without tearing down the session', () => {
    const { collabStore, provider } = boot()

    provider.emit('status', { status: 'connecting' })
    provider.emit('sync', true)
    expect(collabStore.status).toBe('connected')
    expect(collabStore.hasSynced).toBe(true)

    // -> A drop: `y-websocket` reports it as `disconnected`, never `connecting` first.
    provider.emit('sync', false)
    provider.emit('status', { status: 'disconnected' })
    expect(collabStore.status).toBe('disconnected')
    expect(collabStore.hasSynced).toBe(true)

    provider.emit('status', { status: 'connecting' })
    expect(collabStore.status).toBe('connecting')

    provider.emit('sync', true)
    expect(collabStore.status).toBe('connected')
    expect(collabStore.hasSynced).toBe(true)

    // -> Reusing the same `Y.Doc`/`WebsocketProvider` is what keeps edits made while disconnected:
    //    they were written into that very document.
    expect(FakeWebsocketProvider.instances.length).toBe(1)
    expect(provider.destroyed).toBe(false)
  })

  it('never reports "connected" from the raw socket alone -- only a real sync earns that status', () => {
    const { collabStore, provider } = boot()

    provider.emit('status', { status: 'connecting' })
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
    // -> TipTap's shape: `@tiptap/extension-collaboration` binds itself once configured with the
    //    document, leaving this session nothing to hold onto or tear down.
    boot()
    expect(() => bindCollabEditor(() => undefined)).not.toThrow()
    expect(() => stopCollabSession()).not.toThrow()
  })
})

describe('collab presence carries avatarProviderUrl', () => {
  function boot({ avatarProviderUrl = null } = {}) {
    const siteStore = useSiteStore()
    const pageStore = usePageStore()
    const userStore = useUserStore()
    siteStore.id = 'site-1'
    pageStore.id = 'page-1'
    userStore.id = 'user-1'
    userStore.name = 'Ada Lovelace'
    userStore.hasAvatar = false
    userStore.avatarProviderUrl = avatarProviderUrl
    startCollabSession({ siteId: siteStore.id, pageId: pageStore.id })
    return { provider: latestProvider() }
  }

  it('seeds the local awareness state with the signed-in user’s avatarProviderUrl', () => {
    const { provider } = boot({ avatarProviderUrl: 'https://provider.example/photo.jpg' })

    expect(provider.awareness.getLocalState().user.avatarProviderUrl).toBe(
      'https://provider.example/photo.jpg'
    )
  })

  it('seeds null rather than undefined when the user has none', () => {
    const { provider } = boot()

    expect(provider.awareness.getLocalState().user.avatarProviderUrl).toBe(null)
  })

  it('maps a remote participant’s avatarProviderUrl into collabStore.participants on an awareness change', () => {
    const { provider } = boot()
    provider.awareness.states.set(1, {
      user: {
        id: 'user-2',
        name: 'Grace Hopper',
        hasAvatar: false,
        avatarProviderUrl: 'https://provider.example/grace.jpg',
        color: '#222'
      }
    })

    provider.awareness.emit('change')

    const remote = useCollabStore().participants.find((p) => p.id === 'user-2')
    expect(remote.avatarProviderUrl).toBe('https://provider.example/grace.jpg')
  })

  it('normalizes a remote participant with no avatarProviderUrl to null, not undefined', () => {
    const { provider } = boot()
    provider.awareness.states.set(1, {
      user: { id: 'user-2', name: 'Grace Hopper', hasAvatar: false, color: '#222' }
    })

    provider.awareness.emit('change')

    const remote = useCollabStore().participants.find((p) => p.id === 'user-2')
    expect(remote.avatarProviderUrl).toBe(null)
  })
})

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

  const RESTORED = {
    content: 'the restored content',
    title: 'Restored Title',
    description: 'Restored description',
    icon: 'tabler:restore'
  }

  function bindYtext(initial) {
    let seenYtext = null
    bindCollabEditor((ytext) => {
      seenYtext = ytext
      return { destroy: vi.fn() }
    })
    seenYtext.insert(0, initial)
    return seenYtext
  }

  function promptProps() {
    return dialogMock.mock.calls[0][0].componentProps
  }

  it('does not prompt when the page carries no recorded draft', () => {
    const { provider } = boot({ draft: null })
    provider.emit('sync', true)
    expect(dialogMock).not.toHaveBeenCalled()
    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('prompts once the session syncs when a draft is recorded, and clears pageStore.draft right away', () => {
    const { pageStore, provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    provider.emit('sync', true)

    expect(dialogMock).toHaveBeenCalledTimes(1)
    const { component, componentProps } = dialogMock.mock.calls[0][0]
    // -> A bespoke dialog component, not the generic `confirm()` path.
    expect(component).toBeTruthy()
    expect(componentProps.authorName).toBe('Grace Hopper')
    // -> Consumed immediately, not left standing as "still pending" while the dialog is up.
    expect(pageStore.draft).toBe(null)
  })

  it('passes a null author through when the draft carries none', () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: null }
    })
    provider.emit('sync', true)
    expect(promptProps().authorName).toBe(null)
  })

  it('fetches the draft the moment the prompt opens and hands it, with the live content, to the dialog', async () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    bindYtext('what the editor holds now')
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(RESTORED) })

    provider.emit('sync', true)

    // -> Before any button is pressed: the GET is already in flight and both halves of the
    //    comparison are the dialog's to show.
    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/pages/page-1/draft')
    const props = promptProps()
    expect(props.currentContent).toBe('what the editor holds now')
    expect(props.draftRequest).toBeInstanceOf(Promise)
    await expect(props.draftRequest).resolves.toEqual(RESTORED)
  })

  it('never prompts twice in the same session, even across a reconnect´s second sync', () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    provider.emit('sync', true)
    provider.emit('sync', false)
    provider.emit('sync', true)
    expect(dialogMock).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
  })

  it('restoring applies the already-fetched draft into the shared document and page store, with no second fetch', async () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    const seenYtext = bindYtext('stale content')
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(RESTORED) })

    provider.emit('sync', true)
    const chain = dialogMock.mock.results.at(0).value
    await chain.okCb()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    expect(seenYtext.toString()).toBe('the restored content')
    expect(usePageStore().title).toBe('Restored Title')
    expect(usePageStore().description).toBe('Restored description')
    expect(usePageStore().icon).toBe('tabler:restore')
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'positive' })
  })

  it('a fetch that failed while the prompt was up is retried on Restore', async () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    const seenYtext = bindYtext('stale content')
    API_CLIENT.get
      .mockReturnValueOnce({ json: () => Promise.reject(new Error('network')) })
      .mockReturnValueOnce({ json: () => Promise.resolve(RESTORED) })

    provider.emit('sync', true)
    await expect(promptProps().draftRequest).rejects.toThrow('network')

    const chain = dialogMock.mock.results.at(0).value
    await chain.okCb()

    expect(API_CLIENT.get).toHaveBeenCalledTimes(2)
    expect(seenYtext.toString()).toBe('the restored content')
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'positive' })
  })

  it('a restore whose retry also fails notifies negatively and leaves the document untouched', async () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    const seenYtext = bindYtext('unchanged content')
    API_CLIENT.get
      .mockReturnValueOnce({ json: () => Promise.reject(new Error('network')) })
      .mockReturnValueOnce({ json: () => Promise.reject(new Error('still down')) })

    provider.emit('sync', true)
    const chain = dialogMock.mock.results.at(0).value
    await chain.okCb()

    expect(seenYtext.toString()).toBe('unchanged content')
    expect(notifyQueue.at(-1)).toMatchObject({ type: 'negative' })
  })

  it('discarding calls DELETE and never touches the shared document', async () => {
    const { provider } = boot({
      draft: { updatedAt: '2026-01-01T00:00:00.000Z', authorName: 'Grace Hopper' }
    })
    const seenYtext = bindYtext('unchanged content')
    // -> A failed prompt-time fetch is the case a discard must not turn into an unhandled
    //    rejection: nobody else is left to observe it.
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.reject(new Error('network')) })

    provider.emit('sync', true)
    const chain = dialogMock.mock.results.at(0).value
    await chain.cancelCb()

    expect(API_CLIENT.delete).toHaveBeenCalledWith('sites/site-1/pages/page-1/draft')
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

describe('claimWysiwygSeed', () => {
  it('posts to the claim route and returns the granted verdict', async () => {
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ granted: true })
    })

    const granted = await claimWysiwygSeed({ siteId: 'site-1', pageId: 'page-1' })

    expect(API_CLIENT.post).toHaveBeenCalledWith(
      'sites/site-1/pages/page-1/collab/wysiwyg-seed-claim'
    )
    expect(granted).toBe(true)
  })

  it('returns the denied verdict unchanged', async () => {
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.resolve({ granted: false })
    })

    expect(await claimWysiwygSeed({ siteId: 'site-1', pageId: 'page-1' })).toBe(false)
  })

  it("fails open (granted) on a network error, matching this editor's pre-#2516 behaviour", async () => {
    API_CLIENT.post.mockReturnValueOnce({
      json: () => Promise.reject(new Error('network'))
    })

    expect(await claimWysiwygSeed({ siteId: 'site-1', pageId: 'page-1' })).toBe(true)
  })
})
