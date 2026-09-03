# Decision Record: Delegated Per-Site Administration

**Date:** 2026-08-17
**Status:** Decided — gates Feature #409 tasks #682, #683, #684
**Author:** Task #679 (Feature #409, Epic #339 "Multi-Site Platform")
**Produces no code.** This is the design gate the rest of Feature #409 depends on.

## 1. The yes/no call

**Decision: build genuine per-site delegation.** Reject the "single `manage:sites` admin per
instance is an accepted constraint" alternative.

Reasoning:

- Multi-site is 3.0-native — 2.5.x never had more than one site per instance, so there is no
  legacy behavior to preserve and no migration-path argument for staying narrow (see CLAUDE.md's
  "Nothing here has to stay compatible" framing and the Epic's own charter to finish 3.0's
  multi-site ambition rather than settle for parity-only scope).
- The gap is already a live correctness defect, independent of this scope decision:
  `GroupEditOverlay.vue` offers a `manage:theme` permission with the hint "Can modify site theme
  settings," `AdminLayout.vue` uses it to show/hide the Theme nav link, but no backend route ever
  checks it — `AdminTheme.vue` saves through `PUT /sites/:siteId`, gated only on the coarser
  `manage:sites`. An administrator granted exactly what the UI describes as theme management sees
  the link, opens the page (GET is gated on the looser `read:sites`/`access:admin` OR), edits
  fields, and gets a 403 on Save. Task #681 fixes this specific bug directly; it does not by
  itself close the gap, because `manage:theme` is a **global** permission (checked via
  `config.permissions`, same tier as `manage:sites`/`manage:navigation`) — fixing it wires it up
  correctly but does not make it *site-scoped*. Building real delegation is what makes
  `manage:theme` (and the rest) actually mean "this site," not "every site."
- None of the nine site-scoped admin pages perform their own client-side permission check today —
  the only gate before an API call is `AdminLayout.vue`'s coarse `access:admin` check — so any
  user with bare admin-area access can already navigate to any site's settings pages by URL. That
  is a second, independent argument for closing the gap rather than documenting it away: the
  current state is not "no delegation," it is "delegation silently doesn't work as advertised."
- The building block the task description points at already half-exists in the schema:
  `GroupRule.sites: string[]` (`backend/models/groups.ts:19-27`) is stored today, editable today in
  `GroupEditOverlay.vue` (the multi-site picker at `frontend/src/components/GroupEditOverlay.vue:318-330`),
  and is silently a no-op — `ruleMatchesPage()` in `backend/helpers/pageRules.ts` checks
  `rule.locales` but never reads `rule.sites`, and `RulePageRef` (the object every `checkAccess()`
  caller builds) has no `siteId` field at all. So the field exists, is user-facing, and is
  currently dead weight for the one thing it looks like it should do. That is not a reason to
  build the feature by itself, but it means the "low-risk path" below has real prior art to build
  on rather than inventing new schema.

## 2. Low-risk path vs. a dedicated table/column

**Decision: the low-risk path.** Add `checkSiteAccess(actor, permission, siteId)` in
`backend/models/groups.ts`, parallel to `checkAccess()`, backed by a new path-less resolver in a
new `backend/helpers/siteRules.ts`, parallel to `resolvePageRule()` in `helpers/pageRules.ts`.
**No `db/schema.ts` change, no migration.**

Rejected alternative: a dedicated `siteAdmins` table (or a `siteId` column added to
`userGroups`/a new join table). That would be the more "obviously correct" relational shape, but:

- It duplicates a mechanism that already exists for exactly this shape of problem (grant this
  actor these permissions, scoped to a subset of sites) rather than reusing it.
- It introduces a *second* permission-checking code path (a table lookup) alongside the existing
  one (rule resolution against cached, in-memory group rules), doubling what
  `models/groups.reloadCache()` / the mental model in `helpers/pageRules.ts`'s header comment has
  to cover.
- Page rules already prove the pattern scales to "some groups, some sites, some permissions" — a
  site admin is not meaningfully different in shape from a page-rule grant, just without a path.

Design of the reused shape:

- **No `db/schema.ts` change.** `GroupRule.roles: string[]` becomes a shared vocabulary space: the
  existing closed `PAGE_PERMISSIONS` (checked via `checkAccess()`/path matching) **and** the new
  closed site-admin vocabulary (§3, checked via `checkSiteAccess()`/site-only matching) both live
  in the same array on the same rule row. A rule may grant either kind, both, or mix — nothing
  about the JSONB shape changes, so no `db-generate` migration is needed for this task or for #682.
- **`GroupRule.sites: string[]`** keeps its existing semantics: empty means "every site," non-empty
  means "only these site ids." This is exactly what the UI's multi-site picker already collects; it
  is only the *read* side (`checkSiteAccess`) that is new.
- **`GroupRule.path` / `match` / `locales` are ignored** by `checkSiteAccess()` entirely — a
  site-admin permission is not about a page, so there is nothing to match against. This has one UI
  consequence for task #684 to solve, noted here so it isn't rediscovered mid-implementation: the
  rule editor is built around "path + match + roles," and a rule that grants *only* site-admin
  permissions has no meaningful path to set. The two reasonable shapes are (a) let such a rule keep
  an unused/default path (`match: 'START', path: ''`, which trivially matches everything but is
  simply never consulted by `checkSiteAccess`), or (b) give the rule editor a distinct "site
  permissions" section that writes `roles`/`sites` on the same rule object without exposing
  path/match at all. Recommendation for #684: (b) — showing a page-rule admin an inert path field
  next to a site-permission picker invites confusion about what it does.
- **Resolution algorithm** (`resolveSiteRule`, mirrors `resolvePageRule`'s mode tier but drops the
  specificity/match-type tiers, since neither applies without a path):

  ```
  resolveSiteRule(rules, permission, siteId):
    candidates = rules.filter(r =>
      r.roles?.includes(permission) &&
      (r.sites.length === 0 || r.sites.includes(siteId))
    )
    if candidates.length === 0: return null       // nothing granted it -> denied
    return the candidate with the strongest mode,  // ALLOW < DENY < FORCEALLOW, same MODE_PRIORITY
           ties broken by first-in-array            // as helpers/pageRules.ts
  ```

  `checkSiteAccess(actor, permission, siteId)` bypasses this entirely for `manage:system` (same
  guard as `checkAccess()`), then returns `resolveSiteRule(...)?.mode !== 'DENY'`.
- **Nothing is granted by default** — the same invariant `helpers/pageRules.ts` documents for page
  rules holds here: a site-admin permission nobody wrote a rule for is denied, not implicitly
  available to whoever can reach the URL. This directly closes the "no client-side check + coarse
  `access:admin` gate" hole described in §1.

## 3. Closed vocabulary of site-admin permissions

**Decision: one permission per settings surface** (fine-grained, not a coarser grouping),
mirroring `PAGE_PERMISSIONS`'s granularity, the same one-shape-per-address-combination fragmentation
`backend/api/schemas/params.ts` now consolidates for path params. Namespaced `site:*` so
the strings cannot collide with the existing global `manage:*` tier (`manage:sites`,
`manage:theme`, `manage:navigation`, `manage:system` — see CLAUDE.md's Permissions section) or with
`PAGE_PERMISSIONS`'s `verb:pages` shape. This list is closed the same way `PAGE_PERMISSIONS` and
`GUEST_ROLES` are closed in `models/groups.ts` — nothing outside it may be invented ad hoc, per
CLAUDE.md.

```
SITE_PERMISSIONS = [
  'site:general',     // AdminGeneral.vue    -> title, description, company, license, footer, ...
  'site:theme',        // AdminTheme.vue      -> theme config (supersedes the broken global manage:theme
                        //                        for delegation purposes once #684 wires the UI to it —
                        //                        #681's fix to manage:theme itself is independent and
                        //                        stays as the instance-wide "every site" grant)
  'site:navigation',  // AdminNavigation.vue -> backend/api/navigation.ts's two /sites/:siteId/navigation/* routes
  'site:blocks',       // AdminBlocks.vue     -> backend/api/blocks.ts PUT/DELETE /sites/:siteId/blocks
  'site:approvals',   // AdminApprovals.vue  -> backend/api/approvals.ts's /sites/:siteId/approvals/rules routes
  'site:login',        // AdminLogin.vue      -> the `auth` / `authStrategies` keys of SITE_CONFIG_KEYS
                        //                        (distinct from the instance-wide `auth` admin page/AdminAuth.vue,
                        //                        which manages which strategy *modules* exist at all)
  'site:locale',        // AdminLocale.vue     -> the `locales` key of SITE_CONFIG_KEYS
  'site:editors'        // AdminEditors.vue    -> the `editors` key of SITE_CONFIG_KEYS
]
```

Why fine-grained rather than a coarser grouping (e.g. a single `site:manage` covering all eight,
or a two-way split like `site:content-config` / `site:security-config`):

- The whole point of this Feature is letting different people own different parts of one site — a
  department that wants to hand theme/branding to a designer without also handing them login
  provider configuration is exactly the delegation story motivating this Feature. A coarse grouping
  reproduces today's all-or-nothing problem one level down instead of solving it.
- The UI already presents these as eight separate concerns (eight distinct `Admin*.vue` pages,
  eight distinct sidebar entries) — the permission model should mirror what the interface already
  treats as separable, the same way `PAGE_PERMISSIONS` mirrors what the page-rule editor offers.
- `PAGE_PERMISSIONS` sets the precedent at ~15 entries for one resource (a page); eight for an
  entire site's settings surface is not disproportionate.

Known consequence for task #683 (wiring the nine routes), noted so it isn't rediscovered
mid-implementation rather than solved here: `general`, `theme`, `login`, `locale`, and `editors`
all currently write through the **same** route, `PUT /sites/:siteId` in `backend/api/sites.ts`,
which accepts a single body covering every key in `SITE_CONFIG_KEYS`. Five distinct permissions
gating one route means that route's handler — not just its `config.permissions` — has to check
the *actual keys present in the request body* against whichever `site:*` permissions the actor
holds for that site, rejecting a request that touches a key its permission doesn't cover, rather
than gating entry to the whole route on one permission. `blocks`, `navigation`, and `approvals`
don't have this problem — each already has its own dedicated route file, so route-level
`config.permissions`-style gating (adapted to call `checkSiteAccess()` instead of reading
`req.session.permissions`, since this is a page-rule-shaped check, not a global one — see
CLAUDE.md's "A page permission cannot be enforced by `config.permissions`" note, which applies
identically here) is sufficient.

## 4. `storage.ts` gating: stays instance-wide

**Decision: `manage:system`-only gating stays.** Storage targets are **not** added to the
delegable `site:*` vocabulary in §3, and `backend/api/storage.ts`'s four routes keep their current
`permissions: ['manage:system']` config unchanged.

Reasoning:

- The route's own schema description says why the requirement is already there: *"Configuration
  values include any credentials a module stores, hence the `manage:system` requirement."* That
  risk is structural, not hypothetical-until-a-module-ships: `modules/storage/*` is
  definition-only today (no `storage.ts` implementation exists yet, per CLAUDE.md), but the
  `StorageTargetInput` shape a target stores is exactly where a future S3/git/webdav module's
  access keys, deploy tokens, or connection strings will live. The gate has to be right before the
  first real module lands, not after.
- Delegating "administer this site's settings" should not implicitly mean "hand this person
  whatever external-system credentials the instance operator has wired up for it." Those are
  different trust boundaries: a site owner reasonably manages their own theme, navigation, and
  login providers without that implying they should hold literal secret material for
  infrastructure the instance operator (not the site owner) provisioned and is accountable for.
  This is the same reasoning that keeps `manage:system` a strictly global, non-page-rule-able
  permission elsewhere in the codebase (CLAUDE.md: *"`manage:system` bypasses every check
  everywhere"*) — credential-adjacent surfaces stay at the top tier, not inside the per-resource
  rule model.
- Every other `manage:system`-gated route family (`apiKeys.ts`, `authentication.ts`'s admin
  routes, `hooks.ts`, `mail.ts`, `scheduler.ts`) is instance infrastructure, not per-site content
  administration, even where a route happens to be scoped by `siteId` in its URL (as
  `authentication.ts:140`'s per-site auth-strategy config route is). `storage.ts` belongs in that
  same tier by the nature of what it stores, not by the accident of its URL shape starting with
  `/sites/:siteId/`.
- If a future module genuinely needs delegation (e.g. a site owner should be able to toggle *which
  already-configured* target is active for their site, without seeing or editing credentials),
  that is a narrower, later decision — split "which target is active" (delegable, no secrets) from
  "target configuration" (stays `manage:system`) — and is out of scope for this Feature. Recording
  it here rather than silently deciding it: this Feature does not attempt that split now.

## Summary for tasks #682–#684

| Task | What this record fixes for it |
| --- | --- |
| #682 (site-scoped permission check) | Implement `checkSiteAccess()` in `models/groups.ts` + `resolveSiteRule()` in new `helpers/siteRules.ts`, per the algorithm in §2. No schema migration. Add the closed `SITE_PERMISSIONS` list from §3 (suggested location: `backend/api/sites.ts`, mirroring where `PAGE_PERMISSIONS` lives relative to the resource it governs, or a shared constant if multiple route files need it — implementer's call). |
| #683 (wire the nine routes) | Use §3's per-surface mapping. Note the shared-route consequence for `sites.ts` (§3) — `general`/`theme`/`login`/`locale`/`editors` need body-key-level checks, not just route-level gating. `storage.ts` is explicitly excluded per §4 — leave its `manage:system` gating untouched. |
| #684 (frontend group editor + nav/page gating) | Expose `site:*` permissions in `GroupEditOverlay.vue`'s existing per-rule `sites` picker (§2) — likely as a new section alongside the page-rule roles list, per §2's UI note. Gate each `Admin*.vue` page and its `AdminLayout.vue` nav entry on the matching `site:*` permission for the current `siteid`, closing the "no client-side check" hole in §1. `manage:theme` (global, fixed by #681) and `site:theme` (new, site-scoped) are two different permissions — #684 should point the Theme nav link and `AdminTheme.vue`'s save call at `site:theme`, not at the now-fixed-but-still-global `manage:theme`. |
