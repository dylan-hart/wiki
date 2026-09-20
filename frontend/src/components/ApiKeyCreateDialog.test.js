import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DOMWrapper } from '@vue/test-utils'

import ApiKeyCreateDialog from './ApiKeyCreateDialog.vue'
import {
  CHROMIUM_TIMEOUT,
  chromium,
  hasChromium,
  measureClassificationGrid
} from '../../test/realGridLayout.js'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

afterEach(() => {
  document.body.innerHTML = ''
})

/**
 * `wrapper.vm.state` / `wrapper.vm.create` are reachable directly because `@vue/test-utils` proxies
 * a mounted `<script setup>` component's own setup bindings, not just what it `defineExpose`s --
 * that only gates access from a *parent template* (`ref="x"` + `x.value.foo`), which is not what
 * mounting in a test does.
 */
function mountDialog() {
  // -> Opts out of `mountWithApp`'s default `teleport: true` stub: `w-dialog` really teleports its
  //    body to `document.body`, which is where the layout and scope-tree describes below assert.
  return mountWithApp(ApiKeyCreateDialog, { stubs: {} }).wrapper
}

describe('ApiKeyCreateDialog site picker', () => {
  it('prepends an "All Sites" (id: null) entry to the fetched sites list', async () => {
    stubApi({ sites: [{ id: 'site-1', title: 'Docs' }] }, { fallback: [] })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.vm.siteOptions).toEqual([
      { id: null, title: 'admin.api.newKeySiteAllSites' },
      { id: 'site-1', title: 'Docs' }
    ])
  })

  it('defaults keySiteId to null and sends it as siteId on create', async () => {
    stubApi(
      { sites: [{ id: 'site-1', title: 'Docs' }], groups: [{ id: 'group-1', name: 'Editors' }] },
      { fallback: [] }
    )
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.vm.state.keySiteId).toBe(null)

    wrapper.vm.state.keyName = 'My Key'
    wrapper.vm.state.keyGroups = ['group-1']
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'api-keys',
      expect.objectContaining({ json: expect.objectContaining({ siteId: null }) })
    )
  })

  it('sends the picked site as siteId on create', async () => {
    stubApi(
      { sites: [{ id: 'site-1', title: 'Docs' }], groups: [{ id: 'group-1', name: 'Editors' }] },
      { fallback: [] }
    )
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Key'
    wrapper.vm.state.keyGroups = ['group-1']
    wrapper.vm.state.keySiteId = 'site-1'
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'api-keys',
      expect.objectContaining({ json: expect.objectContaining({ siteId: 'site-1' }) })
    )
  })

  it('defaults every fetched classification level to checked', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'classification-levels') {
        return {
          json: () =>
            Promise.resolve([
              { id: 'level-public', name: 'Public', sortOrder: 0 },
              { id: 'level-restricted', name: 'Restricted', sortOrder: 1 }
            ])
        }
      }
      return { json: () => Promise.resolve([]) }
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.vm.state.keyClassifications).toEqual(['level-public', 'level-restricted'])
  })

  it('sends allowedClassifications: null when every level is (still) checked', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'classification-levels') {
        return {
          json: () => Promise.resolve([{ id: 'level-public', name: 'Public', sortOrder: 0 }])
        }
      }
      if (resource === 'groups') {
        return { json: () => Promise.resolve([{ id: 'group-1', name: 'Editors' }]) }
      }
      return { json: () => Promise.resolve([]) }
    })
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Key'
    wrapper.vm.state.keyGroups = ['group-1']
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'api-keys',
      expect.objectContaining({ json: expect.objectContaining({ allowedClassifications: null }) })
    )
  })

  it('sends the explicit checked ids as allowedClassifications once a level is unchecked', async () => {
    globalThis.API_CLIENT.get.mockImplementation((resource) => {
      if (resource === 'classification-levels') {
        return {
          json: () =>
            Promise.resolve([
              { id: 'level-public', name: 'Public', sortOrder: 0 },
              { id: 'level-restricted', name: 'Restricted', sortOrder: 1 }
            ])
        }
      }
      if (resource === 'groups') {
        return { json: () => Promise.resolve([{ id: 'group-1', name: 'Editors' }]) }
      }
      return { json: () => Promise.resolve([]) }
    })
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Key'
    wrapper.vm.state.keyGroups = ['group-1']
    wrapper.vm.state.keyClassifications = ['level-public']
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'api-keys',
      expect.objectContaining({
        json: expect.objectContaining({ allowedClassifications: ['level-public'] })
      })
    )
  })
})

describe('ApiKeyCreateDialog layout', () => {
  it('sizes the classification checkbox grid to reflow with the level count rather than a fixed 2-column split', async () => {
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const classificationGrid = new DOMWrapper(document.body).find('.classification-grid')
    expect(classificationGrid.classes()).not.toContain('grid-cols-2')
    expect(classificationGrid.attributes('style')).toContain('auto-fit')
  })
})

/**
 * The inline-style assertion above cannot tell an unaffected layout from a broken one, so a real
 * headless Chromium page (`test/realGridLayout.js`) answers how many columns the grid renders as at
 * the real ~618px admin-form width.
 *
 * `CHROMIUM_TIMEOUT` rather than the 5s default: this describe's `before` pays for a browser launch,
 * a page and a stylesheet build while `vitest`'s other workers are still transforming files, which
 * timed the launch out intermittently.
 */
describe(
  'ApiKeyCreateDialog classification grid — real layout',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    it('lays out all 3 default classification levels on one row at the real ~618px admin-form width', async () => {
      globalThis.API_CLIENT.get.mockImplementation((resource) => {
        if (resource === 'classification-levels') {
          return {
            json: () =>
              Promise.resolve([
                { id: 'level-public', name: 'Public', sortOrder: 0 },
                { id: 'level-internal', name: 'Internal', sortOrder: 1 },
                { id: 'level-restricted', name: 'Restricted', sortOrder: 2 }
              ])
          }
        }
        return { json: () => Promise.resolve([]) }
      })
      mountDialog()
      await new Promise((resolve) => setTimeout(resolve, 0))

      const html = new DOMWrapper(document.body).find('.classification-grid').html()
      const items = await measureClassificationGrid({ browser, html, containerWidth: 618 })

      expect(items).toHaveLength(3)
      const rows = new Set(items.map((item) => Math.round(item.y)))
      expect(rows.size).toBe(1)
    })
  }
)

/**
 * `WDialog` renders its content behind a `<teleport to="body">`, which lands it as a real child of
 * `document.body`, outside `@vue/test-utils`'s own tracked tree -- `wrapper.find()` never sees it.
 * Every query below goes through the real DOM instead, via a `DOMWrapper(document.body)`.
 */
describe('ApiKeyCreateDialog scope tree', () => {
  function body() {
    return new DOMWrapper(document.body)
  }

  function groupCheckbox(verb) {
    return body().find(`[role="checkbox"][aria-label="${verb}"]`)
  }

  function groupToggleButton(verb) {
    return [...body().findAll('.api-key-scope-picker__group-toggle')].find((btn) =>
      btn.text().startsWith(verb)
    )
  }

  function leafCheckbox(scope) {
    return [...body().findAll('[role="checkbox"]')].find((el) => el.text().includes(scope))
  }

  /*
    The assertions about how the scope picker groups, toggles and narrows are identical between this
    suite and its sibling key-create dialog's, so they live once, as a `describe.each` over both
    dialogs, in `apiKeyScopeTree.test.js`. The one below is not shared: it asserts on the route and
    body THIS dialog posts.
  */

  it('shows the group checkbox as mixed once only some of its scopes are checked, and sends the narrowed list on create', async () => {
    stubApi({ groups: [{ id: 'group-1', name: 'Editors' }] }, { fallback: [] })
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })
    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    await groupToggleButton('read').trigger('click')
    await leafCheckbox('read:pages').trigger('click')

    expect(groupCheckbox('read').attributes('aria-checked')).toBe('mixed')

    wrapper.vm.state.keyName = 'My Key'
    wrapper.vm.state.keyGroups = ['group-1']
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'api-keys',
      expect.objectContaining({ json: expect.objectContaining({ scope: ['read:pages'] }) })
    )
  })
})
