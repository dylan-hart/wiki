import { afterEach, describe, expect, it } from 'vitest'
import { DOMWrapper, mount } from '@vue/test-utils'

import EditorCodeBlockMenu from './EditorCodeBlockMenu.vue'
import WMenu from './shared/WMenu.vue'

import { createTestI18n } from '../../test/i18n.js'

/**
 * Regression coverage for the filter/keyboard-Enter-selects-first-match flow named in task 481
 * (Feature 364)'s manual pass. `w-menu`'s own positioning (`anchoredPosition`) needs no browser to
 * run -- it is plain arithmetic over a `DOMRect` -- so the real component tree is mounted rather than
 * stubbed, per this repo's stated test preference.
 *
 * `w-menu` renders its content through `<teleport to="body">`, so it never appears under `wrapper`'s
 * own element -- queried instead through a `DOMWrapper` over `document.body`, and unmounted after
 * every test (which is what actually detaches the teleported nodes again) so one test's menu is not
 * still sitting in the document for the next.
 */
let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

async function mountShown() {
  const i18n = createTestI18n()
  activeWrapper = mount(EditorCodeBlockMenu, { global: { plugins: [i18n] } })
  // -> `w-menu`'s content is `v-if="shown"`; the menu is empty until this fires
  await activeWrapper.findComponent(WMenu).vm.show()
  return { wrapper: activeWrapper, body: new DOMWrapper(document.body) }
}

describe('EditorCodeBlockMenu', () => {
  it('shows the common-languages shortlist plus the full list when nothing is filtered', async () => {
    const { body } = await mountShown()

    expect(body.text()).toContain('Plain Text')
    expect(body.text()).toContain('Bash Shell')
    // -> Not in the shortlist by id/label, but present in the full hljs-backed list below it
    expect(body.text()).toContain('JavaScript')
  })

  it('hides the shortlist and narrows the full list once a filter is typed', async () => {
    const { body } = await mountShown()

    await body.find('input').setValue('javascript')

    expect(body.text()).not.toContain('Bash Shell')
    expect(body.text()).toContain('JavaScript')
    expect(body.text()).not.toContain('CSS')
  })

  it('matches on a language alias, not just its display label', async () => {
    const { body } = await mountShown()

    // -> "py" is a registered alias of Python, not its label or id
    await body.find('input').setValue('py')

    expect(body.text()).toContain('Python')
  })

  it('shows a no-results message when the filter matches nothing', async () => {
    const { body } = await mountShown()

    await body.find('input').setValue('xyxyxyxy-not-a-language')

    expect(body.findAll('.code-block-menu-list .w-item')).toHaveLength(0)
    expect(body.text()).toContain('editor.codeBlock.noResults')
  })

  it('Enter with no filter selects the first common-language entry (Plain Text, id "")', async () => {
    const { wrapper, body } = await mountShown()

    await body.find('input').trigger('keyup.enter')

    expect(wrapper.emitted('select')).toEqual([['']])
  })

  it('Enter while filtering selects the first FILTERED match, not the common shortlist', async () => {
    const { wrapper, body } = await mountShown()

    await body.find('input').setValue('javascript')
    await body.find('input').trigger('keyup.enter')

    const emitted = wrapper.emitted('select')
    expect(emitted).toHaveLength(1)
    expect(emitted[0][0]).toBe('javascript')
  })

  it('Enter does nothing when the filter matches no language', async () => {
    const { wrapper, body } = await mountShown()

    await body.find('input').setValue('xyxyxyxy-not-a-language')
    await body.find('input').trigger('keyup.enter')

    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('resets the filter to empty each time the menu is (re)shown', async () => {
    const { wrapper, body } = await mountShown()
    await body.find('input').setValue('javascript')

    await wrapper.findComponent(WMenu).vm.hide()
    await wrapper.findComponent(WMenu).vm.show()

    expect(body.find('input').element.value).toBe('')
    expect(body.text()).toContain('Bash Shell')
  })
})
