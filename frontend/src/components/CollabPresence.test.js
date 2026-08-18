import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import CollabPresence from './CollabPresence.vue'
import { useCollabStore } from '@/stores/collab'

const messages = {
  en: {
    editor: {
      collab: {
        participants: 'People editing this page',
        you: 'You',
        editingWithYou: '{name} is editing this page with you.'
      }
    }
  }
}

function mountPresence() {
  setActivePinia(createPinia())
  const collabStore = useCollabStore()
  const i18n = createI18n({ legacy: false, locale: 'en', messages })
  const wrapper = mount(CollabPresence, { global: { plugins: [i18n] } })
  return { wrapper, collabStore }
}

/**
 * Task 480: `editor.collab.editingWithYou` was defined but never referenced anywhere -- the group's
 * `role="group"`/`aria-label` only describes a static snapshot, so a screen-reader user was never told
 * WHEN someone started (or stopped) co-editing, only what the roster looks like if they go check it.
 */
describe('CollabPresence aria-live announcement', () => {
  it('renders an always-present aria-live status region, empty until something happens', () => {
    const { wrapper } = mountPresence()

    const status = wrapper.find('[role="status"]')
    expect(status.exists()).toBe(true)
    expect(status.attributes('aria-live')).toBe('polite')
    expect(status.text()).toBe('')
  })

  it('announces via editingWithYou when a new participant appears', async () => {
    const { wrapper, collabStore } = mountPresence()

    // -> Yourself opening the editor is not a join worth announcing to yourself
    collabStore.participants = [
      { id: 'me', name: 'Ada', color: '#111', isSelf: true, typing: false }
    ]
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="status"]').text()).toBe('')

    collabStore.participants = [
      ...collabStore.participants,
      { id: 'grace', name: 'Grace Hopper', color: '#222', isSelf: false, typing: false }
    ]
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[role="status"]').text()).toBe(
      'Grace Hopper is editing this page with you.'
    )
  })

  it('does not re-announce on unrelated updates, such as a typing flag flipping', async () => {
    const { wrapper, collabStore } = mountPresence()

    collabStore.participants = [
      { id: 'me', name: 'Ada', color: '#111', isSelf: true, typing: false },
      { id: 'grace', name: 'Grace Hopper', color: '#222', isSelf: false, typing: false }
    ]
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="status"]').text()).toBe(
      'Grace Hopper is editing this page with you.'
    )

    // -> Reset it, so the next assertion proves this update did NOT re-announce
    collabStore.participants[1].typing = true
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[role="status"]').text()).toBe(
      'Grace Hopper is editing this page with you.'
    )
  })

  it('is keyed on people, not editor tabs: a second tab from someone already announced is silent', async () => {
    const { wrapper, collabStore } = mountPresence()

    collabStore.participants = [
      { id: 'me', name: 'Ada', color: '#111', isSelf: true, typing: false },
      { id: 'grace', name: 'Grace Hopper', color: '#222', isSelf: false, typing: false }
    ]
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="status"]').text()).toBe(
      'Grace Hopper is editing this page with you.'
    )

    /*
      Grace opens a second tab (a new PARTICIPANT entry, same PERSON) in the same update that Bob
      genuinely joins. A naive "did the array grow" check would grab whichever entry landed last and
      could easily announce the second Grace entry instead of Bob's actual arrival -- this pins the
      announcement to Bob, proving the join is detected off the deduplicated person id, not the raw
      participants list.
    */
    collabStore.participants = [
      ...collabStore.participants,
      { id: 'grace', name: 'Grace Hopper', color: '#222', isSelf: false, typing: true },
      { id: 'bob', name: 'Bob Martin', color: '#333', isSelf: false, typing: false }
    ]
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[role="status"]').text()).toBe('Bob Martin is editing this page with you.')
  })
})
