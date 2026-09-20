# Recommended comments: WP #3504 (public profile endpoint)

No code comments were added by this change. Recommended, per the rubric:

- `config.sample.yml` (header, "admin area owns" list): add `profileVisibility` beside `pageviews`,
  so the list matches `backend/base.yml`.
- `backend/api/users/index.ts` (doc on `routes`): add that `publicProfile.ts` is its own
  sub-plugin so `profile.ts`'s `requireSessionUser` hook stays off it; whether a guest may read it
  is the administrator's `profileVisibility.guestsMayView` choice.
- `backend/api/users/publicProfile.ts` (before the 404): unknown, inactive and system accounts share
  one 404 so the endpoint does not reveal which ids exist.
- `backend/models/users.ts#toPublicProfile`: the response is built from an allow-list of keys, never
  by copying the row, so a new column cannot leak.
