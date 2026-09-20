# Recommended comments: OpenProject #3509 (user profile popover)

No code comments were added, per the repo rule. These are the whys worth recording, for whoever
applies them.

## `frontend/src/composables/profilePopover.js`

- On `PROFILE_PUBLIC_FIELDS`: the backend enum (`PROFILE_PUBLIC_FIELDS` in `backend/models/users.ts`)
  is the source of truth; keep this list in sync with it.
- On `profilePopoverState`: read only by `UserProfilePopover.vue`, the single host mounted in
  `App.vue`; nothing else writes it.
- On `openProfilePopover`: opening again from the same anchor closes the card, which makes a second
  click on the same avatar a toggle. The anchor also receives focus back on close, so pass something
  focusable. It works from a non-avatar anchor (a menu item) for the current user.

## `frontend/src/components/UserProfilePopover.vue`

- `POPOVER_Z`: above the `WMenu` layers (6500+), below tooltips (7000).
- `load()`: a response landing after the card was closed or replaced is dropped (the token check).
- `onTab`: the card is a small non-modal dialog whose only control is its close button, so Tab is
  kept on that button; Escape leaves.
- `restoreFocus()`: focus goes back to the trigger only when it was left with the card; a press
  elsewhere has already put it where the reader wanted it.
- The route watcher: navigating away leaves the trigger behind, and the card must not outlive it.
- The `aria-live="polite"` body: announces the loading to loaded/failed transition.

## `frontend/src/stores/site.js`

- On `guestsMayViewProfiles`: instance-wide, and the only way a guest's browser learns it, because
  `GET users/profile-visibility` needs `read:users`.

## `backend/api/schemas/site.ts` / `backend/api/sites.ts`

- The schema description already carries the why; nothing more is needed at the `buildSitePayload`
  line.
