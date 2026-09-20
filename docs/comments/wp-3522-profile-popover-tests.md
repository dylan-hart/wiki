# WP #3522 recommended comments

No code comments were added, per the repo rule. Recommended, for review:

- `e2e/tests/profile-popover.spec.js`, above `test.describe.configure({ mode: 'serial' })`:
  `// -> One shared page, comment, watcher and pair of accounts for every flow; each test resets the profile state it depends on.`
- `e2e/helpers/profile.js`, above `apiFetch`:
  `// -> In-page fetch, not page.request: the same-origin gate 403s a state-changing request that lacks a genuine Origin/Sec-Fetch-Site pair.`
- `e2e/helpers/profile.js`, above `grantGuestsRead`:
  `// -> The seeded Guests rule DENYs read:pages everywhere; a narrower ALLOW on this spec's page is what lets a guest see the page at all. Returns the restore call.`
- `e2e/helpers/profile.js`, above `pageIdOf`:
  `// -> The page id is read off the page view's own fetch (a hex path hash) rather than recomputed, so the spec cannot drift from pagePathHash.`
- `frontend/src/profilePopoverLocale.test.js`, above `SURFACES`:
  `// -> The readonly-profile surfaces; a static t() key missing from backend/locales/en.json would render as the raw key in a fresh locale.`
