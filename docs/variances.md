# Variances

<<<<<<< HEAD
This document records genuine, justified deviations from spec — decisions where the 3.x fork
intentionally does not reproduce something 2.5.x had, or does not build something a spec called for,
along with the reasoning. It is not a changelog and does not track resolved CI/lint/type issues;
those get fixed, not logged here.

## Storage targets: Box, Dropbox, Google Drive, OneDrive omitted (no 3.x storage module)

**Date:** 2026-08-17
**Feature:** #378 — Legacy Cloud Drive Targets (Box, Dropbox, Google Drive, OneDrive)
**Decision:** Cut. No `backend/modules/storage/{box,dropbox,gdrive,onedrive}/` module exists in this
fork, and none is planned. The fork's storage layer implements seven targets — azure, db, disk, gcs,
git, s3, sftp (`backend/modules/storage/`) — and intentionally stops there.

**Why this is a deviation:** 2.5.x's admin storage-target picker lists Box, Dropbox, Google Drive, and
OneDrive alongside the targets this fork carries forward. A straight port would reproduce all of them;
this fork does not.

**Reasoning:**

1. **2.5.x's own implementations of these four are non-functional stubs — no actual sync ever
   shipped upstream.** Pulled all four `storage.js` files live from `github.com/requarks/wiki@main`
   and confirmed byte-for-byte identity via `sha256sum`: every one exports the same eight-method
   object (`activated`, `deactivated`, `init`, `created`, `updated`, `deleted`, `renamed`,
   `getLocalLocation`), and every method is an empty `async () => {}`. Nothing reads or writes a
   single byte to any of these four providers in upstream 2.5.x — contrast `disk/storage.js` (real
   `fs-extra`/`tar-fs` backup logic) or `git/storage.js` (full `simple-git`-backed push/pull/conflict
   handling), both genuinely functional. There is no working behavior to preserve parity with; 2.5.x's
   "support" for these four is an admin picker that does nothing.
2. **No confirmed departmental usage.** An audit of every reasonably available source — this
   repository (no 2.5.x export/dump exists), OpenProject Epic 341 (Migration & Upgrade Path from
   2.5.x) and its full descendant tree including Feature 420 and Task #767 (the storage-target
   migration mapper, whose design explicitly enumerates the department's real storage footprint as
   the seven modules this fork already has, with no mention of these four), all OpenProject comments
   for a named migration-data-owner contact, and the two sibling branches most likely to carry
   captured source data — found no evidence of any kind that Box, Dropbox, Google Drive, or OneDrive
   is configured or in active use in the department's real 2.5.x instance. Absent that evidence,
   building working integrations for all four from scratch (their `definition.yml`s are also far
   thinner than this fork's `StorageDefinition` schema — no `assetDelivery`, `contentTypes`,
   `versioning`, or `actions` sections, so this would be new authoring, not porting) has no
   justification ahead of targets with confirmed use.

**Scope:** applies individually to all four — Box, Dropbox, Google Drive, and OneDrive — each audited
and verdicted separately; the finding was the same for all four.

**Reversible if:** a migration-data owner later surfaces concrete evidence of live departmental usage
for one of these four (e.g. a captured 2.5.x `storage` table dump with an enabled row for one of these
keys) — that target's cut should be revisited on its own; the evidence trail below documents exactly
what was and wasn't checked so the correction is cheap to make for that target only.

**Evidence trail:** full audit, source list, and per-target verdict table in
[`docs/superpowers/research/2026-08-17-legacy-cloud-drive-targets-audit.md`](superpowers/research/2026-08-17-legacy-cloud-drive-targets-audit.md)
(OpenProject Task #536). Posted back onto Feature #378's description in OpenProject as the traceable
decision record.

## TOTP drift window intentionally tighter than 2.5.x baseline (task 435, feature 356)

`backend/helpers/totp.ts` accepts a code within `allowedDrift = 1` step of the current 30-second
window (±30s, 90s total). Wiki.js 2.5.x's own default was wider: `node-2fa@1.1.2`'s `verifyToken()`
defaults its `window` argument to `4` when the caller omits it, and 2.5.x's
`server/models/users.js` calls `tfa.verifyToken(this.tfaSecret, code)` with no third argument — so
the 2.5.x baseline actually accepted ±4 steps, a ~270-second (4.5-minute) window, three times wider
each direction than this codebase.

This is deliberate, not a regression: ±30s is the conventional secure TOTP default (matches OWASP's
MFA guidance and most current libraries' recommended window), narrows the replay surface a leaked
code has, and comfortably covers realistic clock drift for NTP-synced devices. The wider 2.5.x
default reads as an unrevisited legacy value rather than a considered choice. `totp.ts`'s own header
comment already documents that these RFC 6238 parameters — including this one — are "not
configurable on purpose," so no per-instance override is offered either: widening it would let an
admin silently enlarge the replay window with nothing on the authenticator side to justify it.

Full analysis: `docs/security-reviews/2026-08-17-passkey-rpid-totp-drift.md`. Resolution: none
needed — this is the intended, permanent behavior. Revisit only if real-world deployments show ±30s
is too tight (e.g. a pattern of legitimate users failing TOTP due to drift), at which point this
entry should be replaced with whatever the new decision is, not just deleted.
