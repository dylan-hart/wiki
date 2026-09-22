import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import TagsBrowse from './TagsBrowse.vue'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

describe('TagsBrowse.vue task roll-up entry link', () => {
  it('links to /_tasks', async () => {
    API_CLIENT.get.mockReturnValue({ json: () => Promise.resolve([]) })
    const router = await createTestRouter(
      [{ path: '/_tags', component: TagsBrowse }, '/:pathMatch(.*)*'],
      '/_tags'
    )
    const { wrapper } = mountWithApp(TagsBrowse, {
      messages: { tasks: { openTasks: 'Open tasks' } },
      router,
      stores: { site: { id: 'site-1' } }
    })
    await flushPromises()

    const link = wrapper.find('a.tags-browse-tasks-link')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('/_tasks')
    expect(link.text()).toContain('Open tasks')
  })
})
