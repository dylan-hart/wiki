import { describe, expect, it } from 'vitest'

import PageHeader from './PageHeader.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * `WBtn` turns any non-solid `color` prop into an inline `style="color: ..."`, which always beats
 * `.page-header-actions > .w-btn.w-btn--flat`'s own `--page-header-action-fg` rule whatever the
 * aesthetic. So neither button takes `color`, and the watching accent hangs off an `is-watching`
 * class the SFC's scoped CSS resolves at a higher specificity.
 *
 * Asserted against markup, not `getComputedStyle`: this workspace's DOM environment does not
 * reliably resolve an aesthetic's `var()` cascade.
 */
async function mountHeader(overrides = {}) {
  const router = await createTestRouter(['/'])
  const { wrapper } = mountWithApp(PageHeader, {
    router,
    stores: {
      user: (store) => {
        store.authenticated = true
      },
      site: (store) => {
        store.theme.showPrintBtn = true
      },
      page: (store) => {
        if (overrides.isWatching !== undefined) {
          store.isWatching = overrides.isWatching
        }
      }
    }
  })
  await wrapper.vm.$nextTick()
  return wrapper
}

function actionButtons(wrapper) {
  return wrapper.findAll('.page-header-actions > .w-btn')
}

describe('PageHeader action-row color (OpenProject #2961)', () => {
  it('gives the print button no inline color style', async () => {
    const wrapper = await mountHeader()

    const print = actionButtons(wrapper).find(
      (b) => b.attributes('aria-label') === 'common.actions.print'
    )
    expect(print).toBeTruthy()
    expect(print.attributes('style') ?? '').not.toContain('color:')
  })

  it('gives the watch button no inline color style while not watching', async () => {
    const wrapper = await mountHeader({ isWatching: false })

    const watch = actionButtons(wrapper).find(
      (b) => b.attributes('aria-label') === 'common.page.watch'
    )
    expect(watch).toBeTruthy()
    expect(watch.attributes('style') ?? '').not.toContain('color:')
    expect(watch.classes()).not.toContain('is-watching')
  })

  it('gives the watch button no inline color style while watching, using a class instead', async () => {
    const wrapper = await mountHeader({ isWatching: true })

    const watch = actionButtons(wrapper).find(
      (b) => b.attributes('aria-label') === 'common.page.unwatch'
    )
    expect(watch).toBeTruthy()
    expect(watch.attributes('style') ?? '').not.toContain('color:')
    expect(watch.classes()).toContain('is-watching')
  })

  it("keeps the watching-accent override anchored to a class the SFC's own scoped CSS targets", async () => {
    await mountHeader()

    const sfcCss = [...document.querySelectorAll('style')].map((el) => el.textContent).join('\n')
    expect(sfcCss).toMatch(/\.w-btn--flat\.is-watching(\[data-v-\w+\])?\s*{[^}]*--color-accent/)
  })
})
