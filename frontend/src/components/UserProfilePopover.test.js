import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import UserProfilePopover from './UserProfilePopover.vue'
import {
  closeProfilePopover,
  openProfilePopover,
  profilePopoverState
} from '@/composables/profilePopover'
import { useUserStore } from '@/stores/user'

import { createTestI18n } from '../../test/i18n.js'

const MESSAGES = {
  common: { actions: { close: 'Close' } },
  profilePopover: {
    failed: 'This profile could not be loaded.',
    fieldJobTitle: 'Job Title',
    fieldLocation: 'Location',
    fieldPronouns: 'Pronouns',
    loading: 'Loading profile...',
    notFound: 'This profile is not available.',
    unauthorized: 'Sign in to view this profile.'
  }
}

const PROFILE_URL = 'users/u1/profile'

let wrapper
let anchor

function profile(overrides = {}) {
  return {
    id: 'u1',
    name: 'Ada Lovelace',
    hasAvatar: false,
    avatarProviderUrl: null,
    fields: {},
    ...overrides
  }
}

function stubProfile(result) {
  API_CLIENT.get.mockImplementation(() => ({
    json: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))
  }))
}

function httpError(status) {
  const err = new Error(`HTTP ${status}`)
  err.response = { status }
  return err
}

async function openCard() {
  openProfilePopover({ userId: 'u1', anchor, name: 'Ada' })
  await flushPromises()
}

const card = () => document.body.querySelector('[data-testid="user-profile-popover"]')

beforeEach(() => {
  setActivePinia(createPinia())
  useUserStore().authenticated = true
  closeProfilePopover()
  anchor = document.createElement('button')
  document.body.appendChild(anchor)
  wrapper = mount(UserProfilePopover, {
    global: { plugins: [createTestI18n(MESSAGES)] }
  })
})

afterEach(() => {
  closeProfilePopover()
  wrapper.unmount()
  anchor.remove()
})

describe('UserProfilePopover', () => {
  it('draws nothing until something opens it', () => {
    expect(card()).toBeNull()
  })

  it('is a labelled, non-modal dialog named by the user', async () => {
    stubProfile(profile())
    await openCard()

    const root = card()
    expect(root.getAttribute('role')).toBe('dialog')
    expect(root.getAttribute('aria-modal')).toBe('false')
    const title = document.getElementById(root.getAttribute('aria-labelledby'))
    expect(title.textContent.trim()).toBe('Ada Lovelace')
  })

  it('fetches the profile of the opened user', async () => {
    stubProfile(profile())
    await openCard()

    expect(API_CLIENT.get).toHaveBeenCalledWith(PROFILE_URL)
  })

  it('shows the name it already knows while the profile loads', async () => {
    API_CLIENT.get.mockImplementation(() => ({ json: () => new Promise(() => {}) }))
    openProfilePopover({ userId: 'u1', anchor, name: 'Ada' })
    await flushPromises()

    expect(card().textContent).toContain('Ada')
    expect(card().textContent).toContain('Loading profile...')
  })

  it('renders exactly the fields the API returned, and nothing else', async () => {
    stubProfile(
      profile({ fields: { location: 'London', pronouns: 'she/her' }, email: 'ada@example.com' })
    )
    await openCard()

    expect(
      card().querySelector('[data-testid="user-profile-field-location"]').textContent
    ).toContain('London')
    expect(
      card().querySelector('[data-testid="user-profile-field-pronouns"]').textContent
    ).toContain('she/her')
    expect(card().querySelector('[data-testid="user-profile-field-jobTitle"]')).toBeNull()
    expect(card().textContent).not.toContain('ada@example.com')
  })

  it('never draws an empty field row', async () => {
    stubProfile(profile({ fields: { location: '' } }))
    await openCard()

    expect(card().querySelector('[data-testid="user-profile-field-location"]')).toBeNull()
  })

  it('uses the uploaded avatar, and falls back to the provider picture, then the initials', async () => {
    stubProfile(profile({ hasAvatar: true }))
    await openCard()
    expect(card().querySelector('img').getAttribute('src')).toBe('/_user/u1/avatar')

    closeProfilePopover()
    await flushPromises()
    stubProfile(profile({ avatarProviderUrl: 'https://idp.example/a.png' }))
    await openCard()
    expect(card().querySelector('img').getAttribute('src')).toBe('https://idp.example/a.png')

    closeProfilePopover()
    await flushPromises()
    stubProfile(profile())
    await openCard()
    expect(card().querySelector('img')).toBeNull()
    expect(card().querySelector('.w-avatar').textContent.trim()).toBe('AL')
  })

  it.each([
    [401, 'Sign in to view this profile.'],
    [404, 'This profile is not available.'],
    [500, 'This profile could not be loaded.']
  ])('answers a %i with one inline message, not a toast', async (status, message) => {
    stubProfile(httpError(status))
    await openCard()

    expect(card().querySelector('[data-testid="user-profile-error"]').textContent.trim()).toBe(
      message
    )
    expect(card().textContent).toContain('Ada')
  })

  it('moves focus into the card, and Escape closes it and returns focus to the trigger', async () => {
    stubProfile(profile())
    anchor.focus()
    await openCard()

    expect(document.activeElement).toBe(card())

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()

    expect(card()).toBeNull()
    expect(profilePopoverState.open).toBe(false)
    expect(document.activeElement).toBe(anchor)
  })

  it('closes from its close button and returns focus to the trigger', async () => {
    stubProfile(profile())
    await openCard()

    card().querySelector('.user-profile-popover-close').click()
    await flushPromises()

    expect(card()).toBeNull()
    expect(document.activeElement).toBe(anchor)
  })

  it('keeps Tab inside the card', async () => {
    stubProfile(profile())
    await openCard()

    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    card().dispatchEvent(ev)

    expect(ev.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(card().querySelector('button'))
  })

  it('closes on a press outside, but not on the card or its own anchor', async () => {
    stubProfile(profile())
    await openCard()

    card().dispatchEvent(new Event('pointerdown', { bubbles: true }))
    anchor.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(card()).not.toBeNull()

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(card()).toBeNull()
  })

  it('does not steal focus back after a press elsewhere moved it', async () => {
    stubProfile(profile())
    const other = document.createElement('input')
    document.body.appendChild(other)
    await openCard()

    other.focus()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()

    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('shows one card at a time, replaced when another user is opened', async () => {
    stubProfile(profile())
    await openCard()
    const second = document.createElement('button')
    document.body.appendChild(second)
    stubProfile(profile({ id: 'u2', name: 'Grace Hopper' }))

    openProfilePopover({ userId: 'u2', anchor: second })
    await flushPromises()

    expect(document.body.querySelectorAll('[data-testid="user-profile-popover"]')).toHaveLength(1)
    expect(card().textContent).toContain('Grace Hopper')
    second.remove()
  })

  it('drops a response that lands after the card was closed', async () => {
    let resolve
    API_CLIENT.get.mockImplementation(() => ({
      json: () => new Promise((r) => (resolve = r))
    }))
    await openCard()
    closeProfilePopover()
    await flushPromises()
    stubProfile(profile({ name: 'Second Person' }))
    await openCard()

    resolve(profile({ name: 'Stale Person' }))
    await flushPromises()

    expect(card().textContent).not.toContain('Stale Person')
    expect(card().textContent).toContain('Second Person')
  })
})
