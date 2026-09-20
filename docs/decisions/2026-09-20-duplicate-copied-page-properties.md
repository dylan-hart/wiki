# Decision: what Duplicate and "branch from this version" copy

Status: **Implemented.** OpenProject #3534 (triage candidate fold-3,
`docs/audits/2026-09-17-upstream-scarlett-fold-in-audit.md` §3 Tier 1 #3).

## Context

`pageDuplicate` (`stores/page.js`) passed only editor, title, path, content and description to
`pageCreate`, which hard-coded a published, browsable, searchable page. A duplicated draft therefore
came out published and a hidden page came out public. `PageHistoryOverlay.vue`'s `branchFrom` was
half-done with its own hand-written list.

## Decision

One list, `DUPLICATED_PAGE_PROPS` in `frontend/src/helpers/duplicatedPageProps.js`, and one picker,
`duplicatedPageProps(source)`, used by both paths. `pageCreate` takes the picked values as `carry`
and lays them over its create defaults.

Copied: description, icon, tags, relations, classification, publish state, browsable/searchable
flags, allowComments/allowContributions, show sidebar/tags/ToC and tocDepth.

Deliberately not copied:

- **`password`.** The API returns only `hasPassword`, never the value, so it cannot be copied
  client-side. A duplicate always starts unprotected.
- **`alias`.** Unique per site; a copy would collide.
- **`scriptCss` / `scriptJsLoad` / `scriptJsUnload`.** Gated by `write:scripts`/`write:styles`
  (Feature #3389). Copying unconditionally would 403 the duplicate for anyone without them, or
  attribute executable code to the duplicator. A duplicate of a scripted page silently lacks its
  behavior. Copying for holders of `write:scripts` is a possible follow-up if asked for.
- Identity and derived fields (id, path, title, timestamps, author, render, toc).

`publishStartDate`/`publishEndDate` are copied only when the copied `publishState` is `scheduled`. A
version that was scheduled now branches as scheduled with its dates rather than being downgraded to
a draft.

## Consequences

- `classification` is copied, so duplicating under a stricter parent is refused by the server
  (`classificationBelowFloor`) instead of quietly lowering the copy's classification.
- A published source still needs `publish:pages` at the destination to be created published.
