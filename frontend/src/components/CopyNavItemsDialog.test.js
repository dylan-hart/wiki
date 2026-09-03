import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import CopyNavItemsDialog from './CopyNavItemsDialog.vue'

import { createTestI18n } from '../../test/i18n.js'

const MESSAGES = {
  'navEdit.copyFrom': 'Copy from...',
  'navEdit.copyFromInfoText': 'Select the locale (or site) items will be copied from.',
  'navEdit.copyFromOtherSite': 'Copy from another site',
  'navEdit.sourceLocale': 'Source Locale',
  'navEdit.sourceLocaleHint': 'The locale from which navigation items will be copied from.',
  'navEdit.sourceSite': 'Source Site',
  'navEdit.sourceSiteHint': 'The site from which navigation items will be copied from.',
  'common.actions.cancel': 'Cancel',
  'common.actions.copy': 'Copy'
}

const LOCALES = [
  { locale: 'en', navigationId: 'nav-1' },
  { locale: 'fr', navigationId: 'nav-2' }
]
const OTHER_SITES = [
  { id: 'site-2', title: 'Other Site', hostname: 'other.example.com', isEnabled: true }
]

function mountDialog(props = {}) {
  const i18n = createTestI18n(MESSAGES)
  return mount(CopyNavItemsDialog, {
    props: {
      siteId: 'site-1',
      navId: 'nav-1',
      locales: LOCALES,
      otherSites: OTHER_SITES,
      ...props
    },
    global: { plugins: [i18n] }
  })
}

async function submit(wrapper) {
  const copyBtn = wrapper
    .findAllComponents({ name: 'WBtn' })
    .find((c) => c.props('label') === 'Copy')
  await copyBtn.trigger('click')
}

describe('CopyNavItemsDialog', () => {
  it('defaults to the first same-site locale, excluding the menu being edited itself', async () => {
    const wrapper = mountDialog()
    await vi.waitUntil(() => wrapper.findComponent({ name: 'WSelect' }).exists())

    const localeSelect = wrapper.findComponent({ name: 'WSelect' })
    // -> `nav-1` is `navId` itself -- copying it onto itself would be a no-op merge, so `fr` (`nav-2`)
    //    is the only real choice left
    expect(localeSelect.props('modelValue')).toBe('fr')

    await submit(wrapper)

    expect(wrapper.emitted('ok')).toEqual([[{ sourceSiteId: 'site-1', sourceNavId: 'nav-2' }]])
  })

  it('fetches and offers a different site\'s locales once the "other site" toggle is on', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue([{ locale: 'de', navigationId: 'nav-3' }])
    })
    const wrapper = mountDialog()
    await vi.waitUntil(() => wrapper.findComponent({ name: 'WSelect' }).exists())

    const toggle = wrapper.findComponent({ name: 'WToggle' })
    await toggle.vm.$emit('update:modelValue', true)
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length > 0)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-2/navigation/roots')
    await vi.waitUntil(() => {
      const localeSelect = wrapper.findAllComponents({ name: 'WSelect' })[1]
      return localeSelect?.props('modelValue') === 'de'
    })

    await submit(wrapper)
    expect(wrapper.emitted('ok')).toEqual([[{ sourceSiteId: 'site-2', sourceNavId: 'nav-3' }]])
  })

  it('re-fetches when a different source site is picked while already in cross-site mode', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue([{ locale: 'de', navigationId: 'nav-3' }])
    })
    const wrapper = mountDialog({
      otherSites: [
        { id: 'site-2', title: 'Other Site', hostname: 'other.example.com', isEnabled: true },
        { id: 'site-3', title: 'Third Site', hostname: 'third.example.com', isEnabled: true }
      ]
    })
    await vi.waitUntil(() => wrapper.findComponent({ name: 'WSelect' }).exists())

    const toggle = wrapper.findComponent({ name: 'WToggle' })
    await toggle.vm.$emit('update:modelValue', true)
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length > 0)

    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue([{ locale: 'es', navigationId: 'nav-4' }])
    })
    const siteSelect = wrapper.findAllComponents({ name: 'WSelect' })[0]
    await siteSelect.vm.$emit('update:modelValue', 'site-3')

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-3/navigation/roots')
  })

  it('starts in cross-site mode when this site has no other locale to offer', async () => {
    API_CLIENT.get.mockReturnValueOnce({
      json: vi.fn().mockResolvedValue([{ locale: 'de', navigationId: 'nav-3' }])
    })
    // -> Only entry is the menu being edited itself -- nothing left to copy from within this site
    const wrapper = mountDialog({ locales: [{ locale: 'en', navigationId: 'nav-1' }] })
    await vi.waitUntil(() => wrapper.findComponent({ name: 'WSelect' }).exists())
    await vi.waitUntil(() => API_CLIENT.get.mock.calls.length > 0)

    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-2/navigation/roots')
    const toggle = wrapper.findComponent({ name: 'WToggle' })
    expect(toggle.props('modelValue')).toBe(true)
  })

  it('disables submit until a locale is actually available to submit', async () => {
    const wrapper = mountDialog({
      locales: [{ locale: 'en', navigationId: 'nav-1' }],
      otherSites: []
    })
    await vi.waitUntil(() => wrapper.findComponent({ name: 'WSelect' }).exists())

    const copyBtn = wrapper
      .findAllComponents({ name: 'WBtn' })
      .find((c) => c.props('label') === 'Copy')
    expect(copyBtn.props('disabled')).toBe(true)
  })

  it('cancels without emitting ok', async () => {
    const wrapper = mountDialog()
    await vi.waitUntil(() => wrapper.findComponent({ name: 'WSelect' }).exists())

    const cancelBtn = wrapper
      .findAllComponents({ name: 'WBtn' })
      .find((c) => c.props('label') === 'Cancel')
    await cancelBtn.trigger('click')

    expect(wrapper.emitted('ok')).toBeFalsy()
  })
})
