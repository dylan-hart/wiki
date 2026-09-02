import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import { useCollabStore } from '@/stores/collab'
import { useCommonStore } from '@/stores/common'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

import { queue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'

/**
 * Split into its own file, separate from `EditorMarkdown.test.js`, specifically to exercise the
 * `collabEnabled` branch that file's own header comment documents as deliberately never mounted
 * there (`collabEnabled` needs `siteStore.features.collaborativeEditing`, an authenticated user, and
 * a page id all at once, none of which that file's tests set up). `@/composables/collab` is mocked
 * outright rather than pulling in the real `y-websocket`/`yjs` machinery `startCollabSession` drives
 * -- this only needs to prove the two `watch()`es EditorMarkdown registers off `collabStore` are torn
 * down on unmount (OpenProject #942), not that a live session round-trips correctly (that is
 * `composables/collab.test.js`'s job).
 */
const fakeEditor = {
  getModel: vi.fn(() => ({})),
  getValue: vi.fn(() => ''),
  getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
  setPosition: vi.fn(),
  getSelections: vi.fn(() => [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1, isEmpty: () => true }
  ]),
  getTargetAtClientPoint: vi.fn(() => null),
  executeEdits: vi.fn(),
  trigger: vi.fn(),
  updateOptions: vi.fn(),
  addCommand: vi.fn(() => 'fake-command-id'),
  addAction: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeModelContent: vi.fn(),
  onDidChangeCursorPosition: vi.fn(),
  revealLineInCenterIfOutsideViewport: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn()
}

vi.mock('monaco-editor', () => ({
  editor: {
    defineTheme: vi.fn(),
    create: vi.fn(() => fakeEditor)
  },
  languages: {
    setLanguageConfiguration: vi.fn(),
    registerCodeLensProvider: vi.fn(() => ({ dispose: vi.fn() }))
  },
  KeyMod: { CtrlCmd: 1, Alt: 2 },
  KeyCode: { KeyB: 1, KeyI: 2, KeyS: 3, RightArrow: 4, LeftArrow: 5, Enter: 6 },
  Range: class Range {},
  Position: class Position {},
  Selection: class Selection {}
}))

vi.mock('y-monaco', () => ({ MonacoBinding: vi.fn() }))

vi.mock('@/composables/collab', () => ({
  startCollabSession: vi.fn(),
  stopCollabSession: vi.fn(),
  bindCollabEditor: vi.fn(),
  collabStatusEffects: vi.fn((status, hasSynced) => ({
    shouldBindEditor: status === 'connected',
    readOnly: !hasSynced && status === 'connecting',
    notifyDenied: status === 'denied'
  }))
}))

const EditorMarkdown = (await import('./EditorMarkdown.vue')).default

async function mountEditor() {
  setActivePinia(createPinia())
  const pageStore = usePageStore()
  pageStore.content = ''
  pageStore.id = 'page-1'

  const siteStore = useSiteStore()
  siteStore.features.collaborativeEditing = true

  const userStore = useUserStore()
  userStore.authenticated = true
  userStore.id = 'me'

  const editorStore = useEditorStore()
  editorStore.mode = 'edit'

  const collabStore = useCollabStore()

  // -> Same happy-dom `loadBlocks()` dynamic-import guard `EditorMarkdown.test.js`'s own
  //    `mountEditor` documents and relies on.
  useCommonStore().loadBlocks = vi.fn().mockResolvedValue(undefined)

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

  const wrapper = mount(EditorMarkdown, {
    global: { plugins: [i18n] }
  })
  await flushPromises()

  return { wrapper, collabStore, userStore }
}

describe('EditorMarkdown collab watchers (OpenProject #942)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queue.splice(0, queue.length)
  })

  afterEach(() => {
    queue.splice(0, queue.length)
  })

  it('stops reacting to collabStore.status once unmounted', async () => {
    const { wrapper, collabStore } = await mountEditor()

    collabStore.status = 'connected'
    await flushPromises()
    const callsWhileMounted = fakeEditor.updateOptions.mock.calls.length
    expect(callsWhileMounted).toBeGreaterThan(0)

    wrapper.unmount()
    fakeEditor.updateOptions.mockClear()

    collabStore.status = 'connecting'
    await flushPromises()

    expect(fakeEditor.updateOptions).not.toHaveBeenCalled()
  })

  it('stops notifying on collabStore.lastSave once unmounted, across repeated mounts', async () => {
    const { wrapper: firstWrapper, userStore } = await mountEditor()
    firstWrapper.unmount()

    // -> A second mount against the SAME (module-singleton) collabStore -- exactly the "re-enter the
    //    editor" scenario the work package describes, where a leaked first-mount watcher would still
    //    be listening alongside the second's.
    const { collabStore } = await mountEditor()

    collabStore.lastSave = { authorId: 'someone-else', authorName: 'Someone Else' }
    await flushPromises()

    expect(queue.filter((n) => n.message?.includes('Someone Else'))).toHaveLength(1)
    expect(userStore.id).toBe('me')
  })
})
