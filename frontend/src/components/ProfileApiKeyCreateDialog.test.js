import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DOMWrapper } from '@vue/test-utils'

import ProfileApiKeyCreateDialog from './ProfileApiKeyCreateDialog.vue'
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
 * OpenProject #788: the self-service counterpart to `ApiKeyCreateDialog.vue`, minus the groups
 * picker -- a personal token always carries the creating user's own current permissions, so there is
 * nothing to pick there, only the `scope`/`siteId` narrowing every admin-issued key also gets.
 *
 * A fresh pinia per mount, same as `ApiKeyCreateDialog.test.js`: the dialog reads classification
 * levels off `adminStore.classificationLevels` (OpenProject #1205's checkbox grid replaced the
 * dialog's own independent fetch), populated by `adminStore.fetchClassificationLevels()` in
 * `onMounted` -- which still goes through the same `API_CLIENT.get('classification-levels')` mock
 * these tests already set up.
 */
function mountDialog() {
  // -> Opts out of `mountWithApp`'s default `teleport: true` stub: `w-dialog` really teleports its
  //    body to `document.body`, which is where the layout and scope-tree describes below assert.
  return mountWithApp(ProfileApiKeyCreateDialog, { stubs: {} }).wrapper
}

describe('ProfileApiKeyCreateDialog', () => {
  it('posts to users/profile/api-keys with no groups field, unlike the admin-issued form', async () => {
    stubApi({ sites: [{ id: 'site-1', title: 'Docs' }] }, { fallback: [] })
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Token'
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'users/profile/api-keys',
      expect.objectContaining({
        json: {
          name: 'My Token',
          expiration: '90d',
          scope: null,
          allowedClassifications: null,
          siteId: null
        }
      })
    )
  })

  it('prepends an "All Sites" (id: null) entry to the fetched sites list, same as the admin form', async () => {
    stubApi({ sites: [{ id: 'site-1', title: 'Docs' }] }, { fallback: [] })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(wrapper.vm.siteOptions).toEqual([
      { id: null, title: 'profile.api.newKeySiteAllSites' },
      { id: 'site-1', title: 'Docs' }
    ])
  })

  it('sends a non-empty scope selection as the narrowing list, not null', async () => {
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Token'
    wrapper.vm.state.keyScope = ['read:pages']
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'users/profile/api-keys',
      expect.objectContaining({ json: expect.objectContaining({ scope: ['read:pages'] }) })
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
      return { json: () => Promise.resolve([]) }
    })
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })

    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    wrapper.vm.state.keyName = 'My Token'
    // -> Uncheck "Public", leaving only "Restricted" checked
    wrapper.vm.state.keyClassifications = ['level-restricted']
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'users/profile/api-keys',
      expect.objectContaining({
        json: expect.objectContaining({ allowedClassifications: ['level-restricted'] })
      })
    )
  })
})

/**
 * OpenProject #1292/#1293: the single-column stack of 5 fields is now a responsive 2-column grid
 * (Name spanning both columns, then Expiration/Site and Permission Scopes/Classification Access
 * paired beneath it), collapsing to the original single-column order below the `md` breakpoint. See
 * `WDialog` for why `DOMWrapper(document.body)` is used, as in the scope-tree suite below.
 */
describe('ProfileApiKeyCreateDialog layout', () => {
  function body() {
    return new DOMWrapper(document.body)
  }

  it('groups the 5 fields into a 2-column grid with Name spanning both columns', async () => {
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const grid = body().find('[class*="md:grid-cols-2"]')
    expect(grid.exists()).toBe(true)

    const items = grid.findAll(':scope > .w-item')
    expect(items).toHaveLength(5)
    expect(items[0].classes()).toContain('md:col-span-2')
    for (const item of items.slice(1)) {
      expect(item.classes()).not.toContain('md:col-span-2')
    }
  })

  it('sizes the classification checkbox grid to reflow with the level count rather than a fixed 2-column split', async () => {
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const classificationGrid = body().find('.classification-grid')
    expect(classificationGrid.classes()).not.toContain('grid-cols-2')
    expect(classificationGrid.attributes('style')).toContain('auto-fit')
  })
})

/**
 * OpenProject #1261, real-layout regression: the assertions above only check that the inline style
 * string contains `"auto-fit"` -- which was already true when this exact defect shipped, since
 * neither `jsdom` nor `happy-dom` runs a layout engine to catch what that style actually computes to
 * at this dialog's real width. This field shares row 3 of the 2-column grid (#1292/#1293) with
 * Permission Scopes, so `.classification-grid` only ever gets ~half the dialog's ~700px width --
 * measured at ~310px, not the ~618px `ApiKeyCreateDialog.test.js`'s own matching suite covers for the
 * single-column admin form. See `test/realGridLayout.js` for why a real headless Chromium page is
 * what actually answers "how many columns did this render as."
 */
/*
  Launching a real Chromium is not a 5-second operation when the rest of the suite is running beside
  it: `vitest` runs matched files across eight workers, and this describe's `before` pays for a
  browser launch, a page and a stylesheet build while seven other files are transforming. The 5s
  default timed this out intermittently -- a scheduling fact about the whole run, not anything about
  the layout being measured, which passes in well under a second once the browser is up.
*/
describe(
  'ProfileApiKeyCreateDialog classification grid — real layout',
  { skip: !hasChromium(), timeout: CHROMIUM_TIMEOUT },
  () => {
    let browser

    function body() {
      return new DOMWrapper(document.body)
    }

    beforeAll(async () => {
      browser = await chromium.launch()
    })

    afterAll(async () => {
      await browser?.close()
    })

    function mockThreeDefaultLevels() {
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
    }

    it('lays out all 3 default classification levels on one row at the real ~310px row-3 width', async () => {
      mockThreeDefaultLevels()
      mountDialog()
      await new Promise((resolve) => setTimeout(resolve, 0))

      const html = body().find('.classification-grid').html()
      const items = await measureClassificationGrid({ browser, html, containerWidth: 310 })

      expect(items).toHaveLength(3)
      const rows = new Set(items.map((item) => Math.round(item.y)))
      expect(rows.size).toBe(1)
    })
  }
)

/**
 * OpenProject #1272: the same verb-grouped tri-state scope tree (`ApiKeyScopePicker.vue`) as
 * `ApiKeyCreateDialog.vue`'s admin form, replacing the earlier flat `w-select multiple use-chips`
 * field here too. `wrapper.vm.state.keyScope` is still a flat array of scope strings -- the picker
 * only changed the UI reaching it, not the wire shape.
 *
 * `WDialog` renders its content behind a `<teleport to="body">`, which lands it as a real child of
 * `document.body`, outside `@vue/test-utils`'s own tracked tree -- `wrapper.find()` never sees it.
 * Every query below goes through the real DOM instead, via a `DOMWrapper(document.body)` -- same
 * pattern `ApiKeyCreateDialog.test.js`'s own scope-tree suite uses.
 */
describe('ProfileApiKeyCreateDialog scope tree', () => {
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
    globalThis.API_CLIENT.get.mockImplementation(() => ({ json: () => Promise.resolve([]) }))
    globalThis.API_CLIENT.post.mockReturnValue({
      json: () => Promise.resolve({ ok: true, key: 'abc.def.ghi' })
    })
    const wrapper = mountDialog()
    await new Promise((resolve) => setTimeout(resolve, 0))

    await groupToggleButton('read').trigger('click')
    await leafCheckbox('read:pages').trigger('click')

    expect(groupCheckbox('read').attributes('aria-checked')).toBe('mixed')

    wrapper.vm.state.keyName = 'My Token'
    await wrapper.vm.$nextTick()
    await wrapper.vm.create()

    expect(globalThis.API_CLIENT.post).toHaveBeenCalledWith(
      'users/profile/api-keys',
      expect.objectContaining({ json: expect.objectContaining({ scope: ['read:pages'] }) })
    )
  })
})
