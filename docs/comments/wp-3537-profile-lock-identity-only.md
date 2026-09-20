# WP 3537: comment recommendations

`features.profile` now locks only the identity fields (`PROFILE_IDENTITY_FIELDS` in
`backend/api/users/profile.ts`); display preferences stay writable.

- `backend/api/users/profile.ts`, `isProfileEditable`: the JSDoc says the feature is "turned off where
  user data comes from an external identity provider". Reword to say it gates only the identity
  fields (name, first/last name, location, job title, pronouns) and the avatar routes, not display
  preferences.
- `frontend/src/pages/ProfilePreferences.vue`, block comment above `commonStore`: "a save PUTs the
  whole object, so each ... carries the other's fields through unmodified" is now true only while
  `identityEditable` is set. On a locked site the identity fields are omitted from the PUT, because
  the server refuses a body carrying them.
