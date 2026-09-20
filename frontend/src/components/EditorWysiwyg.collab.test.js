import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import * as Y from 'yjs'

import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'

import { useCollabStore } from '@/stores/collab'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { queue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Split out from `EditorWysiwyg.test.js` because `collabEnabled` needs
 * `siteStore.features.collaborativeEditing`, an authenticated user, edit mode and a page id all at
 * once. `@tiptap/vue-3` is deliberately left unmocked -- the behaviour under test is
 * `swapToCollabEditor` building a *second*, collaboration-bound `Editor` -- while
 * `@/composables/collab` is mocked, since none of this needs a live `y-websocket` round-trip.
 */
vi.mock('@/composables/collab', () => ({
  startCollabSession: vi.fn(),
  stopCollabSession: vi.fn(),
  bindCollabEditor: vi.fn(),
  // -> Granted by default; the one test asserting the denied path overrides it
  claimWysiwygSeed: vi.fn(async () => true),
  collabUserColor: vi.fn(() => '#1976D2'),
  collabStatusEffects: vi.fn((status, hasSynced) => ({
    shouldBindEditor: status === 'connected',
    readOnly: !hasSynced && status === 'connecting',
    notifyDenied: status === 'denied'
  }))
}))

const { bindCollabEditor, claimWysiwygSeed, startCollabSession } =
  await import('@/composables/collab')
const EditorWysiwyg = (await import('./EditorWysiwyg.vue')).default

/** `StarterKit` alone is enough: `prosemirrorJSONToYXmlFragment` only needs the node and mark names
 *  it is handed to exist in the schema, not `EditorWysiwyg.vue`'s full extension list. */
const schema = getSchema([StarterKit])

function fakeAwareness() {
  const state = {}
  return {
    states: new Map(),
    getStates: () => new Map(),
    getLocalState: () => state,
    setLocalState: vi.fn(),
    setLocalStateField: vi.fn((key, value) => {
      state[key] = value
    }),
    on: vi.fn(),
    off: vi.fn()
  }
}

function paragraphDoc(text) {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

async function mountEditor(initialContent = 'Hello from Cardinal.js') {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = initialContent
  pageStore.id = 'page-1'

  const siteStore = useSiteStore()
  siteStore.features.collaborativeEditing = true

  const userStore = useUserStore()
  userStore.authenticated = true
  userStore.id = 'me'
  userStore.name = 'Me'

  const editorStore = useEditorStore()
  editorStore.mode = 'edit'

  const collabStore = useCollabStore()

  const i18n = createTestI18n({
    editor: {
      collab: {
        activeEditors:
          'No one else has this page open | 1 other person has this page open | {count} other people have this page open',
        notAllowed: 'You are no longer allowed to edit this page collaboratively.',
        savedBy: '{name} saved this page.'
      }
    }
  })

  const wrapper = mount(EditorWysiwyg, { global: { plugins: [i18n] } })
  // -> `EditorContent` mounts the ProseMirror view on a follow-up `onMounted`, hence two ticks
  await nextTick()
  await nextTick()

  return { wrapper, collabStore, userStore, pageStore }
}

describe('EditorWysiwyg collaboration (OpenProject #1124)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queue.splice(0, queue.length)
  })

  afterEach(() => {
    queue.splice(0, queue.length)
  })

  it('does not start a session when collaboration is not enabled', async () => {
    // -> The plain harness mount supplies none of the preconditions `collabEnabled` checks for
    const { wrapper } = mountWithApp(EditorWysiwyg, { stores: { page: { content: 'Hello' } } })
    await nextTick()
    await nextTick()

    expect(startCollabSession).not.toHaveBeenCalled()
    expect(wrapper.vm.editor.isEditable).toBe(true)

    wrapper.unmount()
  })

  it('stops reacting to collabStore.status once unmounted', async () => {
    const { wrapper, collabStore } = await mountEditor()
    const setEditableSpy = vi.spyOn(wrapper.vm.editor, 'setEditable')

    collabStore.status = 'connected'
    await flushPromises()
    expect(setEditableSpy).toHaveBeenCalled()

    wrapper.unmount()
    setEditableSpy.mockClear()

    collabStore.status = 'connecting'
    await flushPromises()

    expect(setEditableSpy).not.toHaveBeenCalled()
  })

  it('stops notifying on collabStore.lastSave once unmounted, across repeated mounts', async () => {
    const { wrapper: firstWrapper, userStore } = await mountEditor()
    firstWrapper.unmount()

    // -> A second mount against the SAME module-singleton collabStore: a leaked first-mount watcher
    //    would still be listening alongside the second's
    const { collabStore } = await mountEditor()

    collabStore.lastSave = { authorId: 'someone-else', authorName: 'Someone Else' }
    await flushPromises()

    expect(queue.filter((n) => n.message?.includes('Someone Else'))).toHaveLength(1)
    expect(userStore.id).toBe('me')
  })

  describe('binding to the shared document', () => {
    it('replaces the interim editor with a collaborative one, editable, once synced', async () => {
      const { wrapper, collabStore } = await mountEditor('Hello from Cardinal.js')
      const interimEditor = wrapper.vm.editor

      expect(interimEditor.isEditable).toBe(false)

      collabStore.status = 'connected'
      collabStore.hasSynced = true
      await flushPromises()

      const factory = bindCollabEditor.mock.calls.at(-1)[0]
      const doc = new Y.Doc()
      const ytext = doc.getText('content')

      factory(ytext, fakeAwareness())
      await nextTick()

      expect(interimEditor.isDestroyed).toBe(true)
      expect(wrapper.vm.editor).not.toBe(interimEditor)
      expect(wrapper.vm.editor.isEditable).toBe(true)

      wrapper.unmount()
    })

    /**
     * Tiptap's CollaborationCaret extension overwrites the awareness `user` field with whatever this
     * component hands it, so a copy missing `avatarProviderUrl` silently wipes out the one
     * `composables/collab.js` writes at connect time.
     */
    it('carries avatarProviderUrl into the awareness user field alongside hasAvatar', async () => {
      const { wrapper, collabStore, userStore } = await mountEditor('Hello from Cardinal.js')
      userStore.hasAvatar = false
      userStore.avatarProviderUrl = 'https://provider.example/photo.jpg'

      collabStore.status = 'connected'
      collabStore.hasSynced = true
      await flushPromises()

      const factory = bindCollabEditor.mock.calls.at(-1)[0]
      const doc = new Y.Doc()
      const ytext = doc.getText('content')
      const awareness = fakeAwareness()

      factory(ytext, awareness)
      await nextTick()

      expect(awareness.getLocalState().user.avatarProviderUrl).toBe(
        'https://provider.example/photo.jpg'
      )
      expect(awareness.getLocalState().user.hasAvatar).toBe(false)

      wrapper.unmount()
    })

    it('seeds the shared fragment from the page content when nobody has written to it yet, once the seed claim is granted', async () => {
      const { wrapper, collabStore } = await mountEditor('Hello from Cardinal.js')

      collabStore.status = 'connected'
      collabStore.hasSynced = true
      await flushPromises()

      const factory = bindCollabEditor.mock.calls.at(-1)[0]
      const doc = new Y.Doc()
      const ytext = doc.getText('content')

      factory(ytext, fakeAwareness())
      // -> The swap happens synchronously inside `factory(...)`, but the seed waits on
      //    `claimWysiwygSeed`'s promise, so a plain `nextTick()` would not see it land
      await flushPromises()

      expect(claimWysiwygSeed).toHaveBeenCalledWith({ siteId: null, pageId: 'page-1' })
      expect(wrapper.vm.editor.getText()).toContain('Hello from Cardinal.js')
      // -> The seed went through a real transaction, so the shared fragment carries it for the next
      //    person joining the room, not just the local editor
      expect(doc.getXmlFragment('wysiwygBody').toString()).toContain('Hello from Cardinal.js')

      wrapper.unmount()
    })

    it('does not seed the fragment when the seed claim is denied', async () => {
      claimWysiwygSeed.mockResolvedValueOnce(false)
      const { wrapper, collabStore } = await mountEditor('Hello from Cardinal.js')

      collabStore.status = 'connected'
      collabStore.hasSynced = true
      await flushPromises()

      const factory = bindCollabEditor.mock.calls.at(-1)[0]
      const doc = new Y.Doc()
      const ytext = doc.getText('content')

      factory(ytext, fakeAwareness())
      await flushPromises()

      expect(wrapper.vm.editor.getText()).not.toContain('Hello from Cardinal.js')
      expect(doc.getXmlFragment('wysiwygBody').toString()).toBe('')

      wrapper.unmount()
    })

    it('does not seed when the claim resolves granted but a peer already seeded the fragment meanwhile', async () => {
      const { wrapper, collabStore } = await mountEditor('Hello from Cardinal.js')

      collabStore.status = 'connected'
      collabStore.hasSynced = true
      await flushPromises()

      const factory = bindCollabEditor.mock.calls.at(-1)[0]
      const doc = new Y.Doc()
      const ytext = doc.getText('content')

      claimWysiwygSeed.mockImplementationOnce(async () => {
        // -> Stands in for a peer's content arriving mid-flight, before the claim round trip
        //    resolves
        prosemirrorJSONToYXmlFragment(
          schema,
          paragraphDoc('A peer got there first'),
          ytext.doc.getXmlFragment('wysiwygBody')
        )
        return true
      })

      factory(ytext, fakeAwareness())
      await flushPromises()

      expect(wrapper.vm.editor.getText()).toContain('A peer got there first')
      expect(wrapper.vm.editor.getText()).not.toContain('Hello from Cardinal.js')

      wrapper.unmount()
    })

    it('adopts an already-populated shared fragment instead of overwriting it', async () => {
      const { wrapper, collabStore } = await mountEditor('Local stale content')

      collabStore.status = 'connected'
      collabStore.hasSynced = true
      await flushPromises()

      const factory = bindCollabEditor.mock.calls.at(-1)[0]
      const doc = new Y.Doc()
      const ytext = doc.getText('content')
      // -> Stands in for what a real sync round-trip would already have applied by the time
      //    `bindCollabEditor` fires, via the same `y-tiptap` helper the sync plugin uses
      prosemirrorJSONToYXmlFragment(
        schema,
        paragraphDoc('Someone else already wrote this'),
        ytext.doc.getXmlFragment('wysiwygBody')
      )

      factory(ytext, fakeAwareness())
      await nextTick()

      expect(wrapper.vm.editor.getText()).toContain('Someone else already wrote this')
      expect(wrapper.vm.editor.getText()).not.toContain('Local stale content')

      wrapper.unmount()
    })
  })
})
