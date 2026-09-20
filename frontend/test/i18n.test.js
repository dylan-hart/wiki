import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import { createTestI18n } from './i18n.js'

function mountWithT(i18n, key, params) {
  return mount(
    {
      template: '<span>{{ label }}</span>',
      setup: () => ({ label: i18n.global.t(key, params ?? {}) })
    },
    { global: { plugins: [i18n] } }
  )
}

describe('createTestI18n', () => {
  it('resolves a nested message under the en locale', () => {
    const i18n = createTestI18n({ common: { actions: { apply: 'Apply' } } })
    expect(mountWithT(i18n, 'common.actions.apply').text()).toBe('Apply')
  })

  it('resolves a flat dotted key under the en locale', () => {
    const i18n = createTestI18n({ 'admin.cluster.title': 'Cluster' })
    expect(mountWithT(i18n, 'admin.cluster.title').text()).toBe('Cluster')
  })

  it('interpolates named parameters', () => {
    const i18n = createTestI18n({ tags: { renameConfirm: 'Rename {from} to {to}' } })
    expect(mountWithT(i18n, 'tags.renameConfirm', { from: 'a', to: 'b' }).text()).toBe(
      'Rename a to b'
    )
  })

  it('defaults to an empty en message set, echoing the key back', () => {
    const i18n = createTestI18n()
    expect(mountWithT(i18n, 'anything.at.all').text()).toBe('anything.at.all')
  })

  it('is a composition-API instance locked to en', () => {
    const i18n = createTestI18n()
    expect(i18n.mode).toBe('composition')
    expect(i18n.global.locale.value).toBe('en')
  })

  it('silences the missing/fallback warnings a mostly-empty message set would otherwise emit', () => {
    const i18n = createTestI18n()
    expect(i18n.global.missingWarn).toBe(false)
    expect(i18n.global.fallbackWarn).toBe(false)
  })
})
