import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

import ClassificationReportDrillDialog from './ClassificationReportDrillDialog.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * OpenProject #1081: `AdminClassification.vue`'s coverage report opens this dialog when an admin
 * clicks a level's count -- "everything currently classified as X", paginated newest-updated first
 * against `GET pages/classification-report/:levelId`.
 */
async function mountDialog(props) {
  const i18n = createTestI18n()
  const wrapper = mount(ClassificationReportDrillDialog, {
    props: { levelId: 'level-restricted', levelName: 'Restricted', ...props },
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
  // -> `useDialogComponent()` mounts hidden and flips visible on the next tick, same as
  //    `ClassificationResolutionDialog.test.js` -- then the mounted-hook fetch itself.
  await flushPromises()
  await flushPromises()

  return { wrapper }
}

describe('ClassificationReportDrillDialog', () => {
  it('fetches the level on mount and lists every entry by title and path', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          total: 2,
          entries: [
            { id: 'page-1', path: 'docs/one', locale: 'en', title: 'One' },
            { id: 'page-2', path: 'docs/two', locale: 'en', title: 'Two' }
          ]
        })
    })

    const { wrapper } = await mountDialog()

    expect(API_CLIENT.get).toHaveBeenCalledWith('pages/classification-report/level-restricted', {
      searchParams: { limit: 20, offset: 0 }
    })
    const text = wrapper.text()
    expect(text).toContain('One')
    expect(text).toContain('docs/one')
    expect(text).toContain('Two')
    expect(text).toContain('docs/two')
  })

  it('shows the empty state when no page is at this level', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ total: 0, entries: [] })
    })

    const { wrapper } = await mountDialog()

    expect(wrapper.vm.state.entries).toHaveLength(0)
  })

  it('a failed fetch leaves the list empty rather than throwing', async () => {
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network error')
    })

    const { wrapper } = await mountDialog()

    expect(wrapper.vm.state.entries).toHaveLength(0)
    expect(wrapper.vm.state.total).toBe(0)
  })

  it('changing page re-fetches with the new offset', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          total: 25,
          entries: [{ id: 'page-1', path: 'a', locale: 'en', title: 'A' }]
        })
    })
    const { wrapper } = await mountDialog()

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          total: 25,
          entries: [{ id: 'page-2', path: 'b', locale: 'en', title: 'B' }]
        })
    })
    wrapper.vm.state.page = 2
    await wrapper.vm.load()
    await flushPromises()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith(
      'pages/classification-report/level-restricted',
      {
        searchParams: { limit: 20, offset: 20 }
      }
    )
  })
})
