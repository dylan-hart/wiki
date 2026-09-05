import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import GlossaryVersionHistoryDialog from './GlossaryVersionHistoryDialog.vue'
import { confirm } from '@/composables/dialog'

import { createTestI18n } from '../../test/i18n.js'

vi.mock('@/composables/dialog', async (importOriginal) => ({
  ...(await importOriginal()),
  confirm: vi.fn(() => ({ onOk: (cb) => cb() }))
}))

const fileSave = vi.fn()
vi.mock('browser-fs-access', () => ({
  fileSave: (...args) => fileSave(...args)
}))

// -> Declared at module scope (`vi.mock` factories can't close over per-test locals), so it needs its
//    own call-history clear -- see `AdminGlossary.test.js`'s identical note on `fileSave`/`fileOpen`.
// -> Also (re)installs an active Pinia: the version list renders through `relativeDate()`
//    (`helpers/datetime.js`), which now reads `commonStore.locale` on every call and throws without
//    one.
beforeEach(() => {
  fileSave.mockClear()
  setActivePinia(createPinia())
})

let currentWrapper = null
afterEach(() => {
  currentWrapper?.unmount()
  currentWrapper = null
})

const CURRENT_TERMS = [
  { term: 'API', definition: 'Application Programming Interface.', aliases: [], path: null },
  { term: 'REST', definition: 'Representational State Transfer.', aliases: [], path: null }
]

const VERSIONS = [
  {
    id: 'v2',
    termCount: 2,
    actorId: 'user-1',
    actorName: 'Alice',
    createdAt: '2026-08-20T10:00:00Z'
  },
  { id: 'v1', termCount: 1, actorId: null, actorName: '', createdAt: '2026-08-19T10:00:00Z' }
]

function mountDialog(currentTerms = CURRENT_TERMS) {
  // -> `relativeDate()` (rendered for each version's timestamp) reads `commonStore.locale`
  //    (`helpers/datetime.js`, OpenProject #1600), so mounting needs an active Pinia now too.
  setActivePinia(createPinia())

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(VERSIONS) })

  const i18n = createTestI18n()
  currentWrapper = mount(GlossaryVersionHistoryDialog, {
    props: { siteId: 'site-1', currentTerms },
    global: { plugins: [i18n] }
  })
  return currentWrapper
}

/**
 * Whole-glossary version history (OpenProject #1113): list saved snapshots, expand one to diff it
 * against the current live glossary, and restore one.
 */
describe('GlossaryVersionHistoryDialog: load', () => {
  it('fetches this site’s version list on mount', async () => {
    mountDialog()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/glossary/versions')
  })

  it('renders every version’s actor and term count', async () => {
    mountDialog()
    await flushPromises()
    // -> Content is teleported to `document.body` -- see `GlossaryTermDialog.test.js`'s identical note
    await flushPromises()

    expect(document.body.textContent).toContain('Alice')
    expect(currentWrapper.vm.state.versions).toHaveLength(2)
  })
})

describe('GlossaryVersionHistoryDialog: diff', () => {
  it('toggleExpanded() fetches the full version and computes what would be added/removed/changed', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'v1',
          termCount: 2,
          snapshot: {
            formatVersion: 1,
            terms: [
              { term: 'API', definition: 'Changed definition.', aliases: [], path: null },
              { term: 'GraphQL', definition: 'A query language.', aliases: [], path: null }
            ]
          }
        })
    })

    await wrapper.vm.toggleExpanded(VERSIONS[1])

    expect(wrapper.vm.state.expandedId).toBe('v1')
    expect(wrapper.vm.state.diff.added.map((t) => t.term)).toEqual(['GraphQL'])
    expect(wrapper.vm.state.diff.removed.map((t) => t.term)).toEqual(['REST'])
    expect(wrapper.vm.state.diff.changed.map((t) => t.term)).toEqual(['API'])
  })

  it('toggleExpanded() collapses when the same version is clicked again', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    wrapper.vm.state.expandedId = 'v1'
    wrapper.vm.state.diff = { added: [], removed: [], changed: [] }

    await wrapper.vm.toggleExpanded(VERSIONS[1])

    expect(wrapper.vm.state.expandedId).toBe(null)
    expect(wrapper.vm.state.diff).toBe(null)
  })

  it('reports no difference when the version matches the current glossary exactly', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'v2',
          termCount: 2,
          snapshot: { formatVersion: 1, terms: CURRENT_TERMS }
        })
    })

    await wrapper.vm.toggleExpanded(VERSIONS[0])

    expect(wrapper.vm.state.diff).toEqual({ added: [], removed: [], changed: [] })
  })

  it('reports a change when only isAcronym differs, aliases and definition unchanged (OpenProject #2575)', async () => {
    const wrapper = mountDialog([
      { term: 'API', definition: 'Application Programming Interface.', aliases: [], path: null }
    ])
    await flushPromises()

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'v1',
          termCount: 1,
          snapshot: {
            formatVersion: 2,
            terms: [
              {
                term: 'API',
                definition: 'Application Programming Interface.',
                isAcronym: true,
                aliases: [],
                path: null
              }
            ]
          }
        })
    })

    await wrapper.vm.toggleExpanded(VERSIONS[1])

    expect(wrapper.vm.state.diff.changed.map((t) => t.term)).toEqual(['API'])
  })

  it('reports no change when an alias reorders but keeps the same values and isAcronym flags', async () => {
    const wrapper = mountDialog([
      {
        term: 'API',
        definition: 'Application Programming Interface.',
        aliases: [
          { value: 'REST API', isAcronym: false },
          { value: 'A.P.I.', isAcronym: true }
        ],
        path: null
      }
    ])
    await flushPromises()

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'v1',
          termCount: 1,
          snapshot: {
            formatVersion: 2,
            terms: [
              {
                term: 'API',
                definition: 'Application Programming Interface.',
                aliases: [
                  { value: 'A.P.I.', isAcronym: true },
                  { value: 'REST API', isAcronym: false }
                ],
                path: null
              }
            ]
          }
        })
    })

    await wrapper.vm.toggleExpanded(VERSIONS[1])

    expect(wrapper.vm.state.diff.changed).toEqual([])
  })
})

describe('GlossaryVersionHistoryDialog: restore', () => {
  it('confirms, then POSTs to the restore endpoint and closes with ok', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    API_CLIENT.post.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          terms: [],
          version: { id: 'v3', termCount: 1, actorId: null, actorName: '' }
        })
    })

    wrapper.vm.restore(VERSIONS[1])
    await flushPromises()

    expect(confirm).toHaveBeenCalled()
    expect(API_CLIENT.post).toHaveBeenCalledWith('sites/site-1/glossary/versions/v1/restore')
    expect(wrapper.emitted().ok).toBeTruthy()
  })
})

describe('GlossaryVersionHistoryDialog: download', () => {
  it('fetches the full version and saves its snapshot -- the same shape .../glossary/export returns', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    const snapshot = {
      formatVersion: 1,
      terms: [
        { term: 'API', definition: 'Application Programming Interface.', aliases: [], path: null }
      ]
    }
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ id: 'v1', termCount: 1, snapshot })
    })

    await wrapper.vm.download(VERSIONS[1])

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/glossary/versions/v1')
    expect(fileSave).toHaveBeenCalledTimes(1)
    const [blob, opts] = fileSave.mock.calls[0]
    expect(blob).toBeInstanceOf(Blob)
    expect(opts.fileName).toBe('glossary-v1-2026-08-19-10-00-00.json')
  })

  it('notifies on a real failure but stays silent on a cancelled save picker', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ id: 'v1', termCount: 1, snapshot: { formatVersion: 1, terms: [] } })
    })
    fileSave.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name: 'AbortError' }))

    await wrapper.vm.download(VERSIONS[1])

    expect(wrapper.vm.state.downloadingId).toBe(null)
  })
})
