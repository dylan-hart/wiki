# Approvals manual verification pass (Task 533)

Feature 373 "Approval workflow verification and edge-case closure". This records a manual,
HTTP-level verification pass against a real running instance — `curl` against a booted
`node backend`, not the DB-backed `node --test` suites in `backend/models/approvals.test.ts` (which
already cover the staleness race, reviewer-notification trigger, additive rule matching, and guest
multi-submission at the model layer; see those tests and Tasks 526/527/529/531 for that coverage).
The point of this pass is the parts those tests cannot see: real JSON Schema validation, real
session/permission plumbing, real HTTP status codes, on `backend/api/approvals.ts` and
`backend/models/approvals.ts` as they actually run together.

**Result: every item below passed on the first pass. No code changes were required — this task's
deliverable is the verification record itself**, per the task description's instruction to keep the
checklist as "the record of what 'verified' means for this Feature" even when nothing needed fixing.

## Environment

- `node backend` (Node v26.7.0, native `Temporal`) booted from the repo root against a throwaway
  `postgres:17` container (`wiki-test-db-533`, port 56033, removed after).
- Scratch config (`port: 3080`, `dataPath: ./data/task-533-scratch`, both gitignored) — the e2e
  suite's port/config were left alone since `openproject-mcp` already holds port 3000 on this
  machine.
- One site (the seeded default), one page (`docs/getting-started`, tags `howto` + `featured`,
  `allowContributions: true`), three scratch groups (`Submitters533`, `Reviewers533`,
  `ReviewPagesHolder533` — the last granted `review:pages` via a page rule but never named in any
  approval rule's `reviewerGroups`), three scratch users, plus the seeded admin
  (`manage:system`) and the seeded Guests group (given a scoped `read:pages` ALLOW on `docs` so
  anonymous requests could reach the page at all — its default rule denies read site-wide).
- All scratch rules/users/groups/pages, the container, and the process were torn down at the end of
  the pass; nothing scratch is committed except this document (data/assets dirs are gitignored).

## 1. `validateRule` — empty-path handling by match mode

`POST /sites/:siteId/approvals/rules` with an empty `path`, one call per mode:

| Mode | Expected | Got |
|---|---|---|
| START | 200, rule created (empty path = whole site) | 200, created — PASS |
| EXACT | 400 `approvalRuleEmptyPath` "A path is required." | 400, same — PASS |
| END | 400 `approvalRuleEmptyPath` "A path is required." | 400, same — PASS |
| REGEX | 400 `approvalRuleEmptyPath` "A path is required." | 400, same — PASS |
| TAG | 400 `approvalRuleEmptyPath` "At least one tag is required." | 400, same — PASS |
| TAGALL | 400 `approvalRuleEmptyPath` "At least one tag is required." | 400, same — PASS |

Bonus checks on the same route, all PASS: an unparseable REGEX path (`(unclosed`) → 400
`approvalRuleInvalidRegex` with the JS engine's own message; a whitespace-only `name` → 400
`approvalRuleEmptyName`; empty `submitterGroups` → 400 `approvalRuleNoSubmitters`; empty
`reviewerGroups` → 400 `approvalRuleNoReviewers`.

## 2. `matchesPage` — actual matching, all six modes

One rule created per case (`POST .../approvals/rules`), matching checked via
`GET .../pages/:pageId/suggestions/self`'s `canSubmit` as the submitter, then the rule deleted
before the next case — against page `docs/getting-started`, tags `howto`+`featured`:

| Mode | Rule path | Expect | Got |
|---|---|---|---|
| START | `docs` | match | PASS |
| START | `docz` | no match | PASS |
| EXACT | `docs/getting-started` | match | PASS |
| EXACT | `docs/getting-star` | no match | PASS |
| END | `-started` | match | PASS |
| END | `notend` | no match | PASS |
| REGEX | `^docs/.*-started$` | match | PASS |
| REGEX | `^other/.*$` | no match | PASS |
| TAG | `howto` | match | PASS |
| TAG | `nonexistent-tag` | no match | PASS |
| TAG | `nonexistent-tag,howto` (any-of) | match | PASS |
| TAGALL | `howto,featured` (all-of) | match | PASS |
| TAGALL | `howto,nonexistent-tag` (all-of, one missing) | no match | PASS |

13/13 PASS.

## 3. Authenticated submitter: single open suggestion per page, replace-on-resubmit

`PUT .../pages/:pageId/suggestions/self` as `Submitter533`, twice with different content:

- Both responses returned the **same submission id**.
- `createdAt` unchanged, `updatedAt` advanced, `content` was the second submission's — confirmed via
  `GET .../suggestions/self?withContent=true`.
- The reviewer's queue (`GET .../approvals/submissions`) showed **exactly one** row for the page
  throughout, not two.

PASS — matches `saveSubmission`'s `onConflictDoUpdate` on `(pageId, authorId)`.

## 4. Guest submitter: name/email validation, independent rows

Anonymous `PUT .../pages/:pageId/suggestions/self`:

| Case | Expect | Got |
|---|---|---|
| No `guestName`, no `guestEmail` | 400 `suggestionGuestNameMissing` | PASS |
| `guestName` set, `guestEmail: "not-an-email"` | 400 `suggestionGuestEmailInvalid` | PASS |
| `guestName` set, `guestEmail` omitted entirely | 400 `suggestionGuestEmailInvalid` | PASS |
| `guestName: "   "` (whitespace only), valid email | 400 `suggestionGuestNameMissing` | PASS |

Independent-row behavior: three anonymous submissions to the same page — Guest A, Guest B, then
**Guest A again with the identical name and email** — all three landed as three separate rows in
the reviewer's queue (three distinct ids), not a two-row or a replace. PASS — confirms guests never
hit the `authorId`-scoped partial unique index that authenticated resubmission relies on.

## 5. `allowContributions` veto: blocks submission, does not retract a pending review

1. With `allowContributions: true`, `Submitter533` submitted a suggestion (accepted, queued).
2. Flipped the page to `allowContributions: false` (`PATCH .../pages/:pageId`).
3. `GET .../suggestions/self` for that submitter now returned `canSubmit: false` — the veto blocks
   a **new** submission attempt, matching `findSubmitRule`'s `!page.allowContributions` short
   circuit.
4. The reviewer's queue (`GET .../approvals/submissions`) **still contained** the already-pending
   submission from step 1, unchanged — matching the deliberate comment in
   `getReviewableSubmissions` that `allowContributions` governs whether a suggestion may be *made*,
   not whether an existing one stays reviewable.

PASS on both halves of the asymmetry the task called out.

## 6. `reviewsAll` — `manage:system` and `review:pages`-holding reviewers, named in no rule

Rule's `reviewerGroups` named only `Reviewers533`. Neither the seeded admin (`manage:system`) nor
`ReviewPagesHolder533` (holds `review:pages` via a page rule, never added to `Reviewers533` or any
other rule's `reviewerGroups`) is a member of that group.

- Both saw the pending submission in `GET .../approvals/submissions` and in the per-page
  `GET .../pages/:pageId/submissions` (`canReview: true`, submission listed).
- Both could open it via `GET .../approvals/submissions/:id` (200, not 404).
- `ReviewPagesHolder533` approved it via `POST .../approvals/submissions/:id/approve` — 200, and the
  submission was gone from every queue afterward, confirming the whole write path works through the
  `review:pages` route, not just the read side.
- Sanity check: `Submitter533` (no review standing at all) saw an empty queue.

PASS on every leg, including the full approve write for the `review:pages` path specifically (the
task named this as the less-obvious of the two `reviewsAll` routes to check, since `manage:system`
is exercised incidentally by every other admin-driven check above).

## Outcome

Zero mismatches. No fix was needed in `backend/api/approvals.ts` or `backend/models/approvals.ts` —
prior tasks on this branch (526 staleness, 527 notification trigger, 529 additive matching, 531
guest-row disambiguation) had already closed the gaps a pass like this would normally turn up. This
document is the record that the pass was run and exactly what it covered.
