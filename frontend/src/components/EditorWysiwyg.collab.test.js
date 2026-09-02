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
 * Split into its own file, separate from `EditorWysiwyg.test.js`, matching
 * `EditorMarkdown.collab.test.js`'s own split from `EditorMarkdown.test.js` and for the same reason:
 * `collabEnabled` needs `siteStore.features.collaborativeEditing`, an authenticated user, an edit-mode
 * editor and a page id all at once, none of which the other file's tests set up. Unlike
 * `EditorMarkdown.collab.test.js`, the underlying editor library (`@tiptap/vue-3`) is NOT mocked here
 * -- `EditorWysiwyg.test.js` already runs the real thing under happy-dom with no trouble, and the
 * behaviour under test (`swapToCollabEditor` building a *second*, collaboration-bound `Editor`
 * instance) is only meaningful against a real one. `@/composables/collab` is still mocked, the same
 * way, since none of this needs a live `y-websocket` round-trip.
 */
vi.mock('@/composables/collab', () => ({
  startCollabSession: vi.fn(),
  stopCollabSession: vi.fn(),
  bindCollabEditor: vi.fn(),
  collabUserColor: vi.fn(() => '#1976D2'),
  collabStatusEffects: vi.fn((status, hasSynced) => ({
    shouldBindEditor: status === 'connected',
    readOnly: !hasSynced && status === 'connecting',
    notifyDenied: status === 'denied'
  }))
}))

const { bindCollabEditor, startCollabSession } = await import('@/composables/collab')
const EditorWysiwyg = (await import('./EditorWysiwyg.vue')).default

/** The schema `swapToCollabEditor`'s own editor renders against, built here to seed a fragment the
 *  same way a real collaborator's `y-tiptap` sync would have. `StarterKit` alone is enough --
 *  it carries the `paragraph`/`text` nodes every one of this test file's fixtures uses, and
 *  `prosemirrorJSONToYXmlFragment` only needs the node/mark names it is given to exist somewhere in
 *  the schema, not the full extension list `EditorWysiwyg.vue` itself configures. */
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

async function mountEditor(initialContent = 'Hello from Wiki.js') {
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
  // -> `EditorContent` mounts the ProseMirror view on its own follow-up `onMounted`, same as
  //    `EditorWysiwyg.test.js`'s own `mountEditor` documents.
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
    // -> No `pageStore.id`, no `siteStore.features.collaborativeEditing`, no authenticated user --
    //    the exact gaps `collabEnabled` checks for, matching `EditorWysiwyg.test.js`'s default
    //    `mountEditor`.
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

    // -> A second mount against the SAME (module-singleton) collabStore -- exactly the "re-enter the
    //    editor" scenario the work package this pattern comes from (#942) describes, where a leaked
    //    first-mount watcher would still be listening alongside the second's.
    const { collabStore } = await mountEditor()

    collabStore.lastSave = { authorId: 'someone-else', authorName: 'Someone Else' }
    await flushPromises()

    expect(queue.filter((n) => n.message?.includes('Someone Else'))).toHaveLength(1)
    expect(userStore.id).toBe('me')
  })

  describe('binding to the shared document', () => {
    it('replaces the interim editor with a collaborative one, editable, once synced', async () => {
      const { wrapper, collabStore } = await mountEditor('Hello from Wiki.js')
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

    it('seeds the shared fragment from the page content when nobody has written to it yet', async () => {
      const { wrapper, collabStore } = await mountEditor('Hello from Wiki.js')

      collabStore.status = 'connected'
      collabStore.hasSynced = true
      await flushPromises()

      const factory = bindCollabEditor.mock.calls.at(-1)[0]
      const doc = new Y.Doc()
      const ytext = doc.getText('content')

      factory(ytext, fakeAwareness())
      await nextTick()

      expect(wrapper.vm.editor.getText()).toContain('Hello from Wiki.js')
      // -> Not just the local editor: the seed was written through a real transaction, so the shared
      //    fragment itself now carries it too, for the next person who joins the room.
      expect(doc.getXmlFragment('wysiwygBody').toString()).toContain('Hello from Wiki.js')

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
      // -> Stands in for what a real sync round-trip would already have applied to the shared doc
      //    by the time `bindCollabEditor` fires -- built with the same `y-tiptap` helper the real
      //    sync plugin uses internally, against a doc this test owns rather than the component's.
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
