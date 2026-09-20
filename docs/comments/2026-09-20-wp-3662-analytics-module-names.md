# WP 3662: analytics modules named in comments

The `plausible`, `umami` and `fathom` modules now exist beside `google`, `gtm` and `matomo`, so two
comments that enumerate the modules are out of date. Comment edits are not made in code changes.

## `backend/base.yml` (security `cspDirectives` note)

Current:

> Deliberately NOT covered: theme HTML injection (`site.theme.injectHead`/`injectBody`) and
> the `google`/`gtm`/`matomo` analytics modules, which load scripts from their own origins.

Recommended: replace the enumeration with "the analytics modules". The list only goes stale, and
`ANALYTICS_SNIPPET_BUILDERS` in `helpers/analyticsSnippets.ts` is the authoritative one. The
three new modules load `script.js` from their vendor origin (or the operator's self-hosted host),
which the shipped `script-src 'self'` refuses, so the note applies to them equally; the default
policy is not loosened.

## `backend/api/schemas/site.ts` (analytics `providers` description)

Current: ``Keyed by provider key, e.g. `google`, `gtm`, `matomo`.``

Recommended: an example list is fine as is; optionally append `plausible`, `umami`, `fathom`, or
drop the enumeration.

## `frontend/src/stores/site.js` (analytics providers doc comment)

Current: ``Keyed by provider key (`google`, `gtm`, `matomo`, ...)``. Already ends in an ellipsis;
no change needed.
