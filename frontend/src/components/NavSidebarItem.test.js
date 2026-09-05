import { describe, expect, it } from 'vitest'

import NavSidebarItem from './NavSidebarItem.vue'
import routes from '@/router/routes'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * Feature #2574/#2578: a `generated` (auto/mixed tree-walk) item's label is a deliberate override
 * of the tree row's own title when the site's path-display setting is on -- see
 * `NavSidebarItem.vue#displayLabel`'s own doc comment. A hand-authored `static` link (never
 * `generated`) always keeps its label, whatever the setting is, since it may not correspond to a
 * real path at all.
 */
async function mountItem(item, { pathDisplayCase, acronymMap } = {}) {
  const router = await createTestRouter(routes, '/')

  const { wrapper } = mountWithApp(NavSidebarItem, {
    props: { item },
    router,
    stores: {
      site: (store) => {
        if (pathDisplayCase !== undefined) {
          store.pathDisplayCase = pathDisplayCase
        }
        if (acronymMap !== undefined) {
          store.acronymMap = acronymMap
        }
      }
    }
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('NavSidebarItem: leaf label', () => {
  it('renders item.label unchanged when the setting is off', async () => {
    const wrapper = await mountItem({
      id: '1',
      type: 'link',
      label: 'USS Enterprise',
      path: 'uss-enterprise',
      generated: true,
      target: '/uss-enterprise'
    })

    expect(wrapper.text()).toContain('USS Enterprise')
  })

  it('renders item.label unchanged for a generated item when the setting is on but the item has no path', async () => {
    const wrapper = await mountItem(
      { id: '1', type: 'link', label: 'Hand Label', generated: true, target: '/x' },
      { pathDisplayCase: 'title' }
    )

    expect(wrapper.text()).toContain('Hand Label')
  })

  it('never humanizes a hand-authored (non-generated) link, even when the setting is on', async () => {
    const wrapper = await mountItem(
      { id: '1', type: 'link', label: 'Hand Authored Link', target: '/x' },
      { pathDisplayCase: 'title' }
    )

    expect(wrapper.text()).toContain('Hand Authored Link')
  })

  it('overrides a generated leaf item’s label with its humanized last path segment when the setting is on', async () => {
    const wrapper = await mountItem(
      {
        id: '1',
        type: 'link',
        label: 'Whatever The Tree Row Title Was',
        path: 'guides/uss-enterprise',
        generated: true,
        target: '/guides/uss-enterprise'
      },
      { pathDisplayCase: 'title', acronymMap: { uss: 'USS' } }
    )

    expect(wrapper.text()).toContain('USS Enterprise')
    expect(wrapper.text()).not.toContain('Whatever The Tree Row Title Was')
  })
})

describe('NavSidebarItem: folder (expansion header) label', () => {
  it('overrides a generated folder’s header label the same way a leaf item’s is overridden', async () => {
    const wrapper = await mountItem(
      {
        id: '1',
        type: 'link',
        label: 'Whatever The Folder Title Was',
        path: 'getting-started',
        generated: true,
        children: [
          { id: '2', type: 'link', label: 'Child', path: 'getting-started/child', generated: true }
        ]
      },
      { pathDisplayCase: 'upper' }
    )

    expect(wrapper.text()).toContain('GETTING-STARTED')
    expect(wrapper.text()).not.toContain('Whatever The Folder Title Was')
  })
})
