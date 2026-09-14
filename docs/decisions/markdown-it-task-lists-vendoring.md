# `markdown-it-task-lists` vendored in-tree instead of replaced

**Date:** 2026-09-14
**OpenProject:** #3168 (implementation), reaffirming the 2026-08-22 decision on #1180

## Decision

`markdown-it-task-lists` 2.1.1 is no longer an npm dependency. Its plugin is vendored verbatim,
converted to ESM, at `frontend/src/renderers/modules/markdown-it-task-lists.js` — the checkbox
markup it produces is unchanged, byte-for-byte, from the published package (pinned by
`markdown-it-task-lists.test.js`). The only functional change is moving its module-level mutable
option state into the plugin closure so two `MarkdownIt` instances configured differently no longer
share state.

## Why

`frontend/src/renderers/markdown.js` uses this plugin with `{ label: false, labelAfter: false }` for
GFM-style checkboxes. On 2026-08-22 (#1180), the option of switching to the actively-maintained
`@mdit/plugin-tasklist` was considered and declined: this plugin's HTML is small, frozen, and
already load-bearing for this fork's checkbox styling and the tiptap task-list editor extensions
that target it — the parity-testing cost of a swap outweighed the maintenance-status gain for 116
lines of source.

The package itself is genuinely stale (last published 2018-03-06, repo last pushed 2022-06, solo
maintainer, CJS, ISC licence) — see `docs/audits/2026-09-13-dependency-audit.md` §3/D — which is
exactly the shape of package this fork prefers to vendor rather than keep depending on: there is
nothing left for upstream to fix that matters here, and vendoring removes the CJS dependency, the
now-fixed shared-mutable-state bug, and one entry from `npm audit`'s surface, permanently.

## Why this is not a `docs/variances.md` entry

This is not a divergence from a public standard (GFM's task-list extension does not mandate any
particular HTML for a rendered checkbox) — it is a choice about which implementation renders that
markup, i.e. an implementation decision about this fork's own dependencies. Per `CLAUDE.md`'s
variances.md Discipline section, that belongs here, in `docs/decisions/`, not in `docs/variances.md`.
(An earlier form of this decision briefly lived in `docs/variances.md`, added by Task #1190; that
entry was removed in the 2026-09-14 variances.md cleanup for the same reason this note gives.)

## Revisit when

- Upstream `markdown-it-task-lists` ever resumes publishing a security fix that matters (unlikely,
  and moot regardless once vendored — this file would need the same fix applied directly), or
- The checkbox markup this fork depends on (styling, tiptap task-list extensions) changes enough
  that byte-identical output stops mattering, at which point `@mdit/plugin-tasklist` — or any other
  actively maintained alternative — is worth reconsidering on its own merits.
