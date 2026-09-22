# Decision: page templates (table, model, API and `site:templates`)

Status: **Adopted** — OpenProject #3722, under Feature #3707.

## Decision

A site holds starter content for new pages in `pageTemplates`: `id`, `siteId`, `locale` (null means
every locale), `name`, `description`, `editor`, `content` (the source, not rendered HTML),
`createdBy` (`set null` on user delete), `createdAt`, `updatedAt`. `models/pageTemplates.ts` is a
thin CRUD class and `api/pageTemplates.ts` mounts it under `/sites/:siteId/page-templates`.

- **Reading** (`GET ?basePath=&locale=`) has no route-level permission. The handler asks
  `mayOnPage(req, 'write:pages', siteId, { path: basePath, locale })`, because a template is only
  useful to someone who could create a page at that path. It answers the all-locale templates plus
  those of `locale` (the site's primary locale when the query omits it). A caller holding
  `manage:sites` or `site:templates` on the site may omit `basePath` entirely to list every template
  of every locale, for the admin screen; an empty `basePath=` is the site root, not that mode.
- **Writing** (create, update, delete) is `maySiteAdmin` with `manage:sites` as the global half and
  `site:templates` as the site half. `site:templates` is the ninth entry of `SITE_PERMISSIONS`,
  offered by the group rule editor like the others and mirrored in `siteAdminAccess.js`'s
  `GLOBAL_FALLBACKS` as `manage:sites`.
- **Response shape** (what #3723 and #3724 consume): an array of
  `{ id, locale, name, description, editor, content, createdBy, createdAt, updatedAt }`, ordered by
  name. `content` is included so a picker needs no second request.

## Why

- **The unique index is over `coalesce(locale, '')`, not `locale`.** Postgres treats NULLs as
  distinct in a unique index, so `(siteId, locale, lower(name))` alone would let two all-locale
  templates share a name. The table's own spec said `(siteId, locale, lower(name))`; the coalesced
  form is that index with the null case actually enforced. A duplicate is a 409.
- **`editor` is one of `markdown`, `wysiwyg`, `code`, `asciidoc`.** `redirect` is a page with no
  body, so it has nothing to be a template of.
- **Sanitized on save, against the saving author's `write:scripts` and `write:styles`.** Stripped,
  not rejected, as a page save does. The permissions are evaluated at the site root of the
  template's locale (or the site's primary one), because a template has no path of its own: a rule
  scoped to a subtree does not count here, so this fails closed. Whatever a template carries is
  sanitized again, against the page author, when a page made from it is saved.
- **Markdown source is sanitized without entity-escaping its prose.** `sanitize-html` escapes `<`,
  `>` and `&` in text, which would rewrite every blockquote and comparison in a markdown template.
  `models/pageTemplates.ts#sanitizeSource` masks `&` before the pass, so every `&lt;`/`&gt;` the
  library emits is its own and can be undone in `textFilter`, then restores the `&`. The `code`
  editor's content is real HTML and takes the plain pass.
- **An edit that does not send `content` does not re-sanitize it.** A lower-privileged
  `site:templates` holder renaming a template must not strip a higher-privileged author's markup.
  Changing `editor` does re-run it, since the two sanitizers differ.
- **Deleting a site deletes its templates**, like its glossary terms: the foreign key has no cascade.

## What is deliberately left open

- **Markup that reads as an unknown tag is stripped from markdown source**: an autolink such as
  `<https://example.com>`, a generic such as `List<T>` outside a code span, and HTML shown inside a
  fenced code block. Only what `sanitizeOptions` allows survives, and sanitizing the source without
  parsing markdown cannot tell these from raw HTML. An author who needs one writes it as a link or
  a code span, or in a `code`-editor template.
- **No audit-log events** for template changes; the audit vocabulary is closed and shared.
- **No caching**: a template list is read when an author opens the new-page dialog, not per page view.
