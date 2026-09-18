import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import GroupRulesEditor from './GroupRulesEditor.vue'
import { mountWithApp } from '../../test/mount.js'
import { stubApi } from '../../test/mocks.js'

function tagRule(overrides = {}) {
  return {
    id: 'rule-1',
    name: 'Tag Rule',
    mode: 'ALLOW',
    match: 'TAG',
    roles: ['read:pages'],
    path: '',
    tags: ['europe', 'capital'],
    locales: [],
    sites: [],
    ...overrides
  }
}

function pathRule(overrides = {}) {
  return {
    id: 'rule-2',
    name: 'Path Rule',
    mode: 'ALLOW',
    match: 'START',
    roles: ['read:pages'],
    path: 'engineering',
    locales: [],
    sites: [],
    ...overrides
  }
}

/**
 * OpenProject #3408: `GroupRulesEditor.vue` swaps the path input for a tag picker when a rule's
 * `match` is `TAG`/`TAGALL`, fed by `GET /sites/:siteId/tags`, and reads/writes `rule.tags` (a
 * first-class array) rather than parsing a comma list out of `rule.path`.
 */
describe('GroupRulesEditor.vue rule tags (OpenProject #3408)', () => {
  it('fetches tag suggestions for the current admin site on mount', async () => {
    const { calls } = stubApi({
      'sites/site-1/tags': [
        { tag: 'europe', usageCount: 3 },
        { tag: 'asia', usageCount: 1 }
      ]
    })

    const { wrapper } = mountWithApp(GroupRulesEditor, {
      props: { rules: [tagRule()], canManage: true },
      stores: { admin: { currentSiteId: 'site-1' } }
    })
    await flushPromises()

    expect(calls).toContain('sites/site-1/tags')
    expect(wrapper.vm.state.siteTags).toEqual(['europe', 'asia'])
  })

  it('renders a tag picker (not the path input) for a TAG rule, showing its existing tags', async () => {
    stubApi({ 'sites/site-1/tags': [] })

    const { wrapper } = mountWithApp(GroupRulesEditor, {
      props: { rules: [tagRule()], canManage: true },
      stores: { admin: { currentSiteId: 'site-1' } }
    })
    await flushPromises()

    expect(wrapper.find('input[aria-label="admin.groups.ruleTags"]').exists()).toBe(true)
    expect(wrapper.find('input[aria-label="admin.groups.rulePath"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('europe')
    expect(wrapper.text()).toContain('capital')
  })

  it('renders the path input (not a tag picker) for a non-TAG/TAGALL rule', async () => {
    stubApi({ 'sites/site-1/tags': [] })

    const { wrapper } = mountWithApp(GroupRulesEditor, {
      props: { rules: [pathRule()], canManage: true },
      stores: { admin: { currentSiteId: 'site-1' } }
    })
    await flushPromises()

    expect(wrapper.find('input[aria-label="admin.groups.rulePath"]').exists()).toBe(true)
    expect(wrapper.find('input[aria-label="admin.groups.ruleTags"]').exists()).toBe(false)
  })

  it('newRule() seeds an empty tags array', async () => {
    stubApi({ 'sites/site-1/tags': [] })

    const { wrapper } = mountWithApp(GroupRulesEditor, {
      props: { rules: [], canManage: true },
      stores: { admin: { currentSiteId: 'site-1' } }
    })
    await flushPromises()

    wrapper.vm.newRule()
    const created = wrapper.vm.groupRules[wrapper.vm.groupRules.length - 1]
    expect(created.tags).toEqual([])
  })

  it('createRuleTag trims, lowercases, splits on comma/semicolon, and de-dupes against the existing selection', async () => {
    stubApi({ 'sites/site-1/tags': [] })

    const { wrapper } = mountWithApp(GroupRulesEditor, {
      props: { rules: [tagRule({ tags: ['europe'] })], canManage: true },
      stores: { admin: { currentSiteId: 'site-1' } }
    })
    await flushPromises()

    const rule = wrapper.vm.groupRules[0]
    wrapper.vm.createRuleTag(rule, '  Capital ; Europe, UNESCO ')

    expect(rule.tags).toEqual(['europe', 'capital', 'unesco'])
  })

  it('a rule with no tags at all does not crash the picker', async () => {
    stubApi({ 'sites/site-1/tags': [] })

    const { wrapper } = mountWithApp(GroupRulesEditor, {
      props: { rules: [tagRule({ tags: undefined })], canManage: true },
      stores: { admin: { currentSiteId: 'site-1' } }
    })
    await flushPromises()

    expect(wrapper.find('input[aria-label="admin.groups.ruleTags"]').exists()).toBe(true)
  })
})
