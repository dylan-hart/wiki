import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import CollabPresence from './CollabPresence.vue'
import { useCollabStore } from '@/stores/collab'

import { createTestI18n } from '../../test/i18n.js'

const messages = {
  editor: {
    collab: {
      participants: 'People editing this page',
      you: 'You',
      editingWithYou: '{name} is editing this page with you.'
    }
  }
}

function mountPresence() {
  setActivePinia(createPinia())
  const collabStore = useCollabStore()
  const i18n = createTestI18n(messages)
  const wrapper = mount(CollabPresence, { global: { plugins: [i18n] } })
  return { wrapper, collabStore }
}

/**
 * The group's `role="group"`/`aria-label` describes a static snapshot only, so nothing but this
 * region tells a screen-reader user WHEN someone started co-editing.
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

    // -> An unrelated field changing must leave the announcement exactly as it was
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
      genuinely joins. A "did the array grow" check could announce the second Grace entry instead of
      Bob's arrival -- pinning it to Bob proves the join is detected off the deduplicated person id.
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

/**
 * A per-row avatar must not compete with the initial page render for network priority, and must
 * reserve its own box so the row doesn't jump once it loads.
 */
describe('CollabPresence avatar images', () => {
  it('renders a participant avatar lazily with explicit dimensions', async () => {
    const { wrapper, collabStore } = mountPresence()

    collabStore.participants = [
      { id: 'me', name: 'Ada', color: '#111', isSelf: true, typing: false, hasAvatar: false },
      {
        id: 'grace',
        name: 'Grace Hopper',
        color: '#222',
        isSelf: false,
        typing: false,
        hasAvatar: true
      }
    ]
    await wrapper.vm.$nextTick()

    const img = wrapper.find('.collab-presence-bubble img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('loading')).toBe('lazy')
    expect(img.attributes('width')).toBe('30')
    expect(img.attributes('height')).toBe('30')
  })
})

/**
 * A participant's manually-uploaded avatar (`hasAvatar`) always wins; their provider-synced picture
 * (`avatarProviderUrl`) is only a fallback, and initials are the last resort.
 */
describe('CollabPresence avatar fallback', () => {
  it('renders the uploaded avatar when hasAvatar is set, ignoring avatarProviderUrl', async () => {
    const { wrapper, collabStore } = mountPresence()

    collabStore.participants = [
      { id: 'me', name: 'Ada', color: '#111', isSelf: true, typing: false, hasAvatar: false },
      {
        id: 'grace',
        name: 'Grace Hopper',
        color: '#222',
        isSelf: false,
        typing: false,
        hasAvatar: true,
        avatarProviderUrl: 'https://provider.example/photo.jpg'
      }
    ]
    await wrapper.vm.$nextTick()

    const img = wrapper.find('.collab-presence-bubble img')
    expect(img.attributes('src')).toBe('/_user/grace/avatar')
  })

  it('falls back to the provider avatar when the participant has no manual upload', async () => {
    const { wrapper, collabStore } = mountPresence()

    collabStore.participants = [
      { id: 'me', name: 'Ada', color: '#111', isSelf: true, typing: false, hasAvatar: false },
      {
        id: 'grace',
        name: 'Grace Hopper',
        color: '#222',
        isSelf: false,
        typing: false,
        hasAvatar: false,
        avatarProviderUrl: 'https://provider.example/photo.jpg'
      }
    ]
    await wrapper.vm.$nextTick()

    const img = wrapper.find('.collab-presence-bubble img')
    expect(img.attributes('src')).toBe('https://provider.example/photo.jpg')
  })

  it('falls back to initials when neither avatar exists', async () => {
    const { wrapper, collabStore } = mountPresence()

    collabStore.participants = [
      { id: 'me', name: 'Ada', color: '#111', isSelf: true, typing: false, hasAvatar: false },
      {
        id: 'grace',
        name: 'Grace Hopper',
        color: '#222',
        isSelf: false,
        typing: false,
        hasAvatar: false
      }
    ]
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.collab-presence-bubble img').exists()).toBe(false)
    expect(wrapper.findAll('.collab-presence-bubble span').at(-1).text()).toBe('GH')
  })
})

/**
 * The derivation itself is `helpers/initials.js`'s and is unit-tested there; this is only the
 * wiring -- that a bubble with no avatar behind it draws the shared one.
 */
describe('CollabPresence bubble initials', () => {
  async function bubbleTextsFor(names) {
    const { wrapper, collabStore } = mountPresence()
    collabStore.participants = names.map((name, index) => ({
      id: `p${index}`,
      name,
      color: '#111',
      isSelf: false,
      typing: false,
      hasAvatar: false
    }))
    await wrapper.vm.$nextTick()
    return wrapper.findAll('.collab-presence-bubble span').map((span) => span.text())
  }

  it('draws the first and last initial of a multi-part name', async () => {
    expect(await bubbleTextsFor(['Dylan James Hart', 'Ada Lovelace'])).toEqual(['DH', 'AL'])
  })

  it('draws a single letter for a mononym and a neutral glyph for a nameless account', async () => {
    expect(await bubbleTextsFor(['Prince', ''])).toEqual(['P', '?'])
  })
})
