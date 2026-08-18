# Legacy Cloud Drive Targets — Departmental Usage Audit & Build/Cut Verdict

**Date:** 2026-08-17
**Feature:** #378 — Legacy Cloud Drive Targets (Box, Dropbox, Google Drive, OneDrive)
**Task:** #536 — Audit real departmental usage and finalize a per-target build-vs-cut verdict
**Status:** Complete. Verdict: **cut all four** (box, dropbox, gdrive, onedrive), pending correction only if
concrete contradicting evidence of live departmental usage later surfaces.

## 1. Baseline: upstream 2.5.x ships all four as functionally inert stubs

Independently re-verified against `github.com/requarks/wiki` (`main`, the live 2.5.x line — there is no
separate `2.x` branch) rather than trusting the Feature description's prior claim at face value:

```
$ shasum -a 256 server/modules/storage/{box,dropbox,gdrive,onedrive}/storage.js
5b6de058de82a004d6931f916504c2744bafec8c6595542537ffe8ec2a3b7ee9  box/storage.js
5b6de058de82a004d6931f916504c2744bafec8c6595542537ffe8ec2a3b7ee9  dropbox/storage.js
5b6de058de82a004d6931f916504c2744bafec8c6595542537ffe8ec2a3b7ee9  gdrive/storage.js
5b6de058de82a004d6931f916504c2744bafec8c6595542537ffe8ec2a3b7ee9  onedrive/storage.js
```

Byte-for-byte identical. All four export the same eight-method object (`activated`, `deactivated`, `init`,
`created`, `updated`, `deleted`, `renamed`, `getLocalLocation`), every method an empty `async () => {}`.
Nothing reads or writes a single byte to any of these four providers in upstream 2.5.x — contrast
`disk/storage.js` (real `fs-extra`/`tar-fs` backup logic) and `git/storage.js` (full `simple-git`-backed
push/pull/conflict handling), both genuinely functional.

Their `definition.yml`s are also thin relative to this fork's `StorageDefinition` schema
(`backend/models/storage.ts`): `dropbox` declares only `appKey`/`appSecret`; `box` only
`clientId`/`clientSecret`/`rootFolder`; `gdrive` and `onedrive` only `clientId`/`clientSecret`. None has
`assetDelivery`, `contentTypes`, `versioning`, or `actions` sections — the configuration surface would need
authoring from scratch, not porting.

**This is the default baseline every target must clear to justify real engineering**, per the parent epic's
parity-not-exceed constraint (docs/superpowers/specs/2026-08-16-wikijs-3-epic-roadmap-design.md): 2.5.x's
own "parity" for these four targets is an admin picker that does nothing. The only thing that overrides the
default cut is genuine, current departmental reliance on one of these four in the actual instance Epic 341
(Migration & Upgrade Path from 2.5.x) is migrating.

## 2. Departmental usage audit — sources checked

Per the task description, the requirement is to check *the source instance's actual storage
settings/export data*, not just theoretical 2.5.x support, and to cross-reference whoever owns the
migration data. The following were checked, in order of how directly they would carry that evidence:

1. **This repository** — searched for any 2.5.x export bundle, `storage` table dump, or department-instance
   config artifact anywhere under the working tree (`find . -iname '*migration*'`, `-iname '*export*'`,
   grep for `box`/`dropbox`/`gdrive`/`onedrive` outside `docs/`). None exists. No live source instance is
   reachable from this environment either (no configured 2.5.x host, no export file checked in).
2. **OpenProject Epic 341 (Migration & Upgrade Path from 2.5.x)** and its full descendant tree — the epic
   whose entire purpose is importing this exact department's 2.5.x data, including its `storage` table. Read
   in full (Feature 420 "Settings, Auth-Module & Storage Config Migration" and its five child tasks: #763
   field-level mapping spec, #764 site-settings mapper, #765 auth-strategy mapper, #767 storage-target
   mapper, #768 fixture tests/variances). None mentions box, dropbox, gdrive, or onedrive by name anywhere
   in title, description, or comments.
3. **Task #767 specifically** ("Storage-target mapper, scoped per created site") is the most direct source:
   it instructs the importer to *"explicitly enumerate all module directories under `modules/storage/`
   (azure, db, disk, gcs, git, s3, sftp) rather than assuming 1:1 parity with whatever keys the 2.5.x source
   used, flagging any 2.5.x storage key with no matching 3.0 module directory."* This is the task that would
   name box/dropbox/gdrive/onedrive as targets requiring a flagged mapping if the source department's
   `storage` table actually contained rows for them — it does not. The absence is not proof of absence in
   isolation, but combined with (1) and (2) below it is the strongest available signal.
4. **Feature 420's description** documents the generic 2.5.x `storage` table shape (`key`, `isEnabled`,
   `mode`, `config`, `syncInterval`, `state` — one row per enabled sync target), confirmed against
   `requarks/wiki`'s schema/migrations — i.e. the *shape* of the table, not a captured dump of this
   department's actual row contents. No task in this tree references an actual captured export or a
   specific set of enabled `key` values from the real instance.
5. **Migration-data ownership contact** — searched OpenProject comments across Feature 378, Epic 341,
   Feature 420, and Tasks #536/#706/#707/#709/#710/#712/#763/#767 for any note identifying a person or team
   who owns/can confirm the source instance's live storage configuration. None exists. No such contact is
   recorded anywhere in the tracker.
6. **Sibling in-flight branches** — `feature/source-connector-schema-mapping-spike` and
   `feature/content-dispatch-sync-engine` (read-only, per this run's instructions) were checked via
   `git log <branch>` for any commits beyond the common `scarlett` ancestor that might carry captured source
   data. Neither has diverged from `scarlett` yet — no work has landed on either.

**Finding: no evidence of any kind — export data, tracker record, or named contact — indicates any of
box, dropbox, gdrive, or onedrive is configured or in active use in the department's actual 2.5.x instance.**
The migration tooling design (Task #767) treats the department's real storage footprint as exactly the
seven modules this fork already implements (azure, db, disk, gcs, git, s3, sftp), with no fallback path
even sketched for the four legacy cloud-drive keys.

## 3. Per-target verdict

| Target | Upstream 2.5.x baseline | Departmental usage evidence | Verdict |
| --- | --- | --- | --- |
| **Box** | Inert stub (§1) | None found (§2) | **Cut** |
| **Dropbox** | Inert stub (§1) | None found (§2) | **Cut** |
| **Google Drive** | Inert stub (§1) | None found (§2) | **Cut** |
| **OneDrive** | Inert stub (§1) | None found (§2) | **Cut** |

No target clears the bar the parent epic sets: matching 2.5.x's own baseline (an admin picker that does
nothing) is not "parity" worth reproducing, and none has the overriding factor — genuine current
departmental reliance — that would justify real engineering ahead of it.

## 4. Disposition

- **This finding is posted back onto Feature #378's description** (OpenProject) as the traceable decision
  record, per the task's explicit requirement that the verdict not be an implicit omission.
- **Task #537** ("Record the cut decision in docs/variances.md for whichever targets don't clear the bar")
  is the correct place to formalize this as a `docs/variances.md` entry for all four targets — intentionally
  left to that task rather than duplicated here, since `docs/variances.md` records only genuine, justified
  deviations and this document is the evidence trail behind that entry, not the entry itself.
- **Task #538** ("Scope and implement real integration for any target the audit confirms is still needed")
  has no work to do under this verdict: zero targets confirmed as needed. That task should be closed as
  moot once #537 lands, rather than implement speculative integrations for targets with no evidenced use.
- **If a migration-data owner surfaces later** with concrete evidence contradicting this finding — e.g. a
  captured 2.5.x `storage` table dump showing an enabled row for one of these four keys — this verdict
  should be revisited for that target only; the audit trail above documents exactly what was and wasn't
  checked so the correction is cheap to make.

## 5. Collision note

Per this run's instructions: this Feature's eventual implementation task (#538) would touch
`backend/models/storage.ts` and/or `backend/modules/storage/*`, which is a known 4+-way collision point
across several other unmerged branches (`git-storage-target`, `cloud-blob-storage-targets`,
`sftp-storage-target`, `content-dispatch-sync-engine`, `disk-db-storage-targets`). This task (#536) itself
makes no code changes to those paths — it is audit-only — so it adds no new collision surface today, but
is recorded here so the eventual #538 work (if any target is ever confirmed) is flagged for the same
merge-time review list.
