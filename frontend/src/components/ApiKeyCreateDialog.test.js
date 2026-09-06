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
 * Covers the site-picker added alongside the scope control (task 622): a new key defaults to
 * `siteId: null` ("All Sites", instance-wide -- identical to a key created before site-pinning
 * existed) and, when a site is picked, that site's ID is what actually reaches the API.
 *
 * `wrapper.vm.state` / `wrapper.vm.create` are reachable directly because `@vue/test-utils` proxies
 * a mounted `<script setup>` component's own setup bindings, not just what it `defineExpose`s --
 * that only gates access from a *parent template* (`ref="x"` + `x.value.foo`), which is not what
 * mounting in a test does.
 *
 * A fresh pinia per mount, same as `GroupEditOverlay.test.js`: the dialog reads classification
 * levels off `adminStore.classificationLevels` (OpenProject #1205's checkbox grid replaced the
 * dialog's own independent fetch), populated by `adminStore.fetchClassificationLevels()` in
 * `onMounted` -- which still goes through the same `API_CLIENT.get('classification-levels')` mock
 * these tests already set up.
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

  /**
   * OpenProject #1205: the checkbox grid that replaced the single-select "ceiling" -- every fetched
   * level starts checked, which is what makes the default equivalent to the old "No Limit".
   */
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
    // -> Uncheck "Restricted", leaving only "Public" checked
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

/**
 * OpenProject #1261: the classification checkbox grid reflows with the level count instead of a
 * fixed `grid-cols-2` -- see `ProfileApiKeyCreateDialog.test.js`'s matching layout suite for the
 * same fix on the profile-scoped twin. This dialog's own overall field layout is untouched (out of
 * scope for #1292/#1293, which only covers `ProfileApiKeyCreateDialog.vue`).
 */
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
 * OpenProject #1261, real-layout regression: the assertion above only checks the inline style string
 * for `"auto-fit"`, which cannot tell an unaffected layout from a broken one -- see
 * `ProfileApiKeyCreateDialog.test.js`'s matching suite for the full explanation and
 * `test/realGridLayout.js` for why a real headless Chromium page is what actually answers "how many
 * columns did this render as." This dialog's own form stayed single-column (#1292/#1293 only reworks
 * the profile-scoped twin), so `.classification-grid` gets the full ~618px card width here rather
 * than the ~310px half-row the profile dialog's field shares with Permission Scopes -- confirming
 * this width was never broken, and stays that way.
 */
/*
    Launching a real Chromium is not a 5-second operation when the rest of the suite is running
    beside it: `vitest` runs matched files across eight workers, and this describe's `before` pays
    for a browser launch, a page and a stylesheet build while seven other files are transforming.
    The 5s default timed this out intermittently -- a scheduling fact about the whole run, not
    anything about the layout being measured, which passes in well under a second once the browser
    is up. `CHROMIUM_TIMEOUT` (`test/realGridLayout.js`) is the one constant every real-Chromium
    suite passes for this, rather than each carrying its own literal (OpenProject #2730).
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
    }) // -> real chromium layout via realGridLayout.js; the describe-level CHROMIUM_TIMEOUT covers this
  }
)

/**
 * OpenProject #1272: the verb-grouped tri-state scope tree (`ApiKeyScopePicker.vue`) that replaced
 * the earlier flat `w-select multiple use-chips` field. `wrapper.vm.state.keyScope` is still a flat
 * array of scope strings either way -- the picker only changed the UI reaching it, not the wire
 * shape -- so these tests drive the tree through the DOM and assert against that same state, plus
 * one round trip through `create()` proving the array actually reaches the API unchanged.
 *
 * `WDialog` renders its content behind a `<teleport to="body">` (see `ImportBatchPageDialog.test.js`'s
 * own header comment for the same pattern), which lands it as a real child of `document.body`, outside
 * `@vue/test-utils`'s own tracked tree -- `wrapper.find()` never sees it. Every query below goes
 * through the real DOM instead, via a `DOMWrapper(document.body)`.
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
    The three assertions about how the scope picker groups, toggles and narrows are byte-identical
    between this suite and its sibling key-create dialog's, so they live once, as a `describe.each`
    over both dialogs, in `apiKeyScopeTree.test.js`. The one below is not shared: it asserts on the
    route and body THIS dialog posts, which is what differs between the two.
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
