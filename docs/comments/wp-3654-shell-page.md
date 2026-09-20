# Recommended comments: `backend/helpers/shellPage.ts` (OpenProject #3654)

No comments were written into the code. These are the whys worth adding.

- On `lookupShellPage`: null covers missing, unpublished, guest-unreadable and password-locked pages
  identically, so the shell can tell a crawler nothing a request for a nonexistent path would not.
  A locked page is null on purpose: the page API blanks its fields, so the shell must not publish its
  title or description in the head.
- On the `rulesAllow` call: same guests-group predicate as `models/pages.ts#listPagesForSitemap`;
  keep the two in step.
- On the query: one read on the `(siteId, locale, path)` unique index; sibling locale rows come back
  in the same result and become `translations`, so hreflang costs no second query.
- On the missing cache: deliberately uncached. A cached positive would outlive an unpublish or a rule
  change and keep serving that page's metadata to anonymous readers.
- On `|| 'home'`: the root URL addresses the page at path `home`, as `api/pages/read.ts` does.
