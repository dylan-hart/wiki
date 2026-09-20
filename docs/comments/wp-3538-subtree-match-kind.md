# WP 3538 — comment changes SUBTREE makes stale or wants

Not applied in code (comment edits go through this directory).

## backend/helpers/pageRules.ts

- Header, tier 1 (BAND): `START / END / REGEX` becomes `START / SUBTREE / END / REGEX`.
- Header, tier 3 (MATCH TYPE): `START < END < REGEX` becomes `START < SUBTREE < END < REGEX`.
- Beside the SUBTREE case in `ruleMatchesPage`, one line of why: START is a raw prefix and
  `normalizeRulePaths` strips trailing slashes, so `foo/bar/` saves as `foo/bar` and matches
  `foo/barometer`; SUBTREE is the folder-boundary kind (`foo/bar` itself or `foo/bar/...`), and an
  empty path addresses the whole site like START.
- The "Page paths are stored lowercased" comment in `ruleMatchesPage` names START/EXACT/END; add SUBTREE.

## backend/models/groups.ts

- `normalizeRulePaths` doc: "the match kinds that compare directly against it" now includes SUBTREE.

## backend/api/schemas/group.ts

- The `START/END/EXACT compare path ...` comment above `groupRuleSchema['if']` should read
  `START/SUBTREE/END/EXACT`.
- The `match` description could say SUBTREE means "the path itself or anything under it", unlike
  START's bare prefix.

## frontend/src/components/GroupRulesEditor.vue

- `onRulePathInput` doc: `START/END/EXACT` becomes `START/SUBTREE/END/EXACT`.

## backend/models/groups.test.ts

- The comment above "groups.updateGroup rule tag normalization" says `START/END/EXACT`; add SUBTREE.
