# WP #3660 recommended code comments

No comments were added in code. Recommended, for the maintainer to apply:

- `backend/helpers/analyticsSnippets.ts`, above `ANALYTICS_SNIPPET_BUILDERS`: the builders emit
  inline `<script>` elements, which the shipped `script-src 'self'` refuses under
  `security.enforceCsp`. The server renders them regardless; `base.yml` deliberately does not
  loosen the default. Keep in sync with `frontend/src/helpers/analyticsProviders.js` until the
  client path is removed (an enabled provider loads twice until then).
- `backend/helpers/analyticsSnippets.ts`, above `jsLiteral`: `<` is escaped to `<` so a value
  containing `</script` cannot close the element; U+2028/U+2029 are escaped so the literal stays
  valid in older parsers.
- `backend/core/http/siteRouting.ts`, at the `mergeShellFragments(...)` call: one merged insertion
  is load-bearing (a second `insertIntoAppShell` would find `</body>` inside the first fragment's
  markup), and analytics precede theme so the admin's raw `injectHead` cannot swallow them.
