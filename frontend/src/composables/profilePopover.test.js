import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import {
  PROFILE_PUBLIC_FIELDS,
  canOpenProfilePopover,
  closeProfilePopover,
  openProfilePopover,
  profilePopoverState
} from './profilePopover'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

let userStore
let siteStore

beforeEach(() => {
  setActivePinia(createPinia())
  userStore = useUserStore()
  siteStore = useSiteStore()
  closeProfilePopover()
  profilePopoverState.userId = null
  profilePopoverState.anchor = null
})

describe('canOpenProfilePopover()', () => {
  it('refuses a guest by default', () => {
    expect(canOpenProfilePopover()).toBe(false)
  })

  it('allows a guest once the instance setting is on', () => {
    siteStore.guestsMayViewProfiles = true

    expect(canOpenProfilePopover()).toBe(true)
  })

  it('always allows an account holder', () => {
    userStore.authenticated = true

    expect(canOpenProfilePopover()).toBe(true)
  })
})

describe('openProfilePopover()', () => {
  it('does nothing for a guest who may not view profiles', () => {
    const opened = openProfilePopover({ userId: 'u1', anchor: document.createElement('button') })

    expect(opened).toBe(false)
    expect(profilePopoverState.open).toBe(false)
  })

  it('does nothing without a user id', () => {
    userStore.authenticated = true

    expect(openProfilePopover({ userId: null, anchor: document.createElement('button') })).toBe(
      false
    )
    expect(profilePopoverState.open).toBe(false)
  })

  it('records the user, the name shown meanwhile and the anchor', () => {
    userStore.authenticated = true
    const anchor = document.createElement('button')

    expect(openProfilePopover({ userId: 'u1', anchor, name: 'Ada Lovelace' })).toBe(true)

    expect(profilePopoverState).toMatchObject({ open: true, userId: 'u1', name: 'Ada Lovelace' })
    expect(profilePopoverState.anchor).toBe(anchor)
  })

  it('replaces the card open for another user, keeping one popover at a time', () => {
    userStore.authenticated = true
    const first = document.createElement('button')
    const second = document.createElement('button')
    openProfilePopover({ userId: 'u1', anchor: first })
    const seq = profilePopoverState.seq

    openProfilePopover({ userId: 'u2', anchor: second })

    expect(profilePopoverState.userId).toBe('u2')
    expect(profilePopoverState.anchor).toBe(second)
    expect(profilePopoverState.seq).toBeGreaterThan(seq)
    expect(profilePopoverState.open).toBe(true)
  })

  it('closes when the same anchor is activated again', () => {
    userStore.authenticated = true
    const anchor = document.createElement('button')
    openProfilePopover({ userId: 'u1', anchor })

    expect(openProfilePopover({ userId: 'u1', anchor })).toBe(false)

    expect(profilePopoverState.open).toBe(false)
  })

  it('opens for the current user from a non-avatar anchor', () => {
    userStore.authenticated = true
    userStore.id = 'me'
    const menuItem = document.createElement('a')

    expect(openProfilePopover({ userId: userStore.id, anchor: menuItem })).toBe(true)
    expect(profilePopoverState.userId).toBe('me')
  })
})

describe('PROFILE_PUBLIC_FIELDS', () => {
  it('is the closed three-key list the backend enum allows', () => {
    expect(PROFILE_PUBLIC_FIELDS).toEqual(['location', 'jobTitle', 'pronouns'])
  })
})
