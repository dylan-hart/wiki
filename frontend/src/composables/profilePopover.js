import { markRaw, reactive } from 'vue'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

// Keep in sync with `PROFILE_PUBLIC_FIELDS` in `backend/models/users.ts`, the source of truth.
export const PROFILE_PUBLIC_FIELDS = ['location', 'jobTitle', 'pronouns']

export const profilePopoverState = reactive({
  open: false,
  userId: null,
  name: '',
  anchor: null,
  seq: 0
})

export function canOpenProfilePopover() {
  return useUserStore().authenticated || useSiteStore().guestsMayViewProfiles === true
}

export function openProfilePopover({ userId, anchor, name = '' }) {
  if (!userId || !canOpenProfilePopover()) {
    return false
  }
  if (profilePopoverState.open && profilePopoverState.anchor === anchor) {
    closeProfilePopover()
    return false
  }
  profilePopoverState.userId = userId
  profilePopoverState.name = name
  profilePopoverState.anchor = anchor ? markRaw(anchor) : null
  profilePopoverState.seq += 1
  profilePopoverState.open = true
  return true
}

export function closeProfilePopover() {
  profilePopoverState.open = false
}
