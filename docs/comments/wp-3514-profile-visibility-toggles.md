# WP #3514 recommended comments

No code comments were added, per the repo rule. Recommended, for review:

- `frontend/src/pages/ProfileInfo.vue`, `save()`, above `publicFields: state.config.publicFields`:
  `// -> The reader's own list only, never the forced one merged in: a forced field is a display override, and un-forcing it later must reveal their own choice.`
- `frontend/src/pages/ProfileInfo.vue`, above `PUBLIC_FIELD_KEYS`:
  `// -> Mirrors backend/models/users.ts PROFILE_PUBLIC_FIELDS; the API answers 400 to any other key, email included.`
- `frontend/src/components/ProfileVisibilityToggle.vue`, above `isOn`:
  `// -> A forced field draws on and locked whatever the model holds; the lock is display-only and never written back.`
