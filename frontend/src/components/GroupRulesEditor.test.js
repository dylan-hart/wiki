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

  it('offers Path Is, Or Is Under and folds a SUBTREE rule path to lowercase', async () => {
    stubApi({ 'sites/site-1/tags': [] })

    const { wrapper } = mountWithApp(GroupRulesEditor, {
      props: { rules: [pathRule({ match: 'SUBTREE', path: 'foo/bar' })], canManage: true },
      stores: { admin: { currentSiteId: 'site-1' } }
    })
    await flushPromises()

    expect(wrapper.find('input[aria-label="admin.groups.rulePath"]').exists()).toBe(true)
    const rule = wrapper.vm.groupRules[0]
    wrapper.vm.onRulePathInput(rule, 'Foo/Bar')
    expect(rule.path).toBe('foo/bar')
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

// The caption is rendered verbatim from the dictionary, so an administrator granting the rule sees
// whatever `read:source.hint` says -- including that `write:pages`/`manage:pages` imply it.
describe('GroupRulesEditor.vue read:source caption (OpenProject #3412)', () => {
  it('resolves the read:source option caption from admin.groups.permissions.read:source.hint', async () => {
    stubApi({ 'sites/site-1/tags': [] })
    const hint = 'Can view pages source. Also implicitly held by write:pages and manage:pages.'

    const { wrapper } = mountWithApp(GroupRulesEditor, {
      props: { rules: [pathRule()], canManage: true },
      stores: { admin: { currentSiteId: 'site-1' } },
      messages: {
        admin: {
          groups: {
            permissions: {
              'read:source': { title: 'View Page Source', hint }
            }
          }
        }
      }
    })
    await flushPromises()

    const readSourceOption = wrapper.vm.rules.find((rule) => rule.permission === 'read:source')
    expect(readSourceOption.hint).toBe(hint)
  })
})
