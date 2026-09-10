import { describe, expect, it } from 'vitest'

import PageHeader from './PageHeader.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

/**
 * OpenProject #2961: the watch and print buttons in `.page-header-actions` used to pass a `color`
 * prop (`slate-soft`, or `accent` while watching) straight through to `WBtn`, which turns any
 * non-solid `color` prop into an inline `style="color: ..."` on the button root -- and an inline
 * style always beats `.page-header-actions > .w-btn.w-btn--flat`'s own `color:
 * var(--page-header-action-fg)` class rule, regardless of aesthetic. That token is already correct
 * per aesthetic (white on Cobalt, `--color-slate-soft` on Ledger); the bug was purely the inline
 * override permanently winning over it. Neither button takes a `color` prop any more, so this suite
 * asserts the inline override is gone and that the watching-accent state now comes from a class
 * instead (`is-watching`), which the SFC's own scoped `<style>` resolves to `--color-accent` at a
 * higher specificity than the shared `.w-btn.w-btn--flat` rule.
 *
 * Not a resolved-color/`getComputedStyle` assertion: `NavEditMenu.test.js`'s "Cobalt restyle"
 * precedent notes this workspace's DOM environment doesn't reliably resolve an aesthetic's `var()`
 * cascade, so this checks the same two facts that precedent settled on instead -- the inline style
 * is absent, and the class anchor a future edit could hang the override off of is present.
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
