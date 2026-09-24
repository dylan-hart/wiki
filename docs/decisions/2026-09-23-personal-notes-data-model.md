# Decision: personal notes data model, and note images in their own table

Status: **Adopted**. OpenProject #3769, under Feature #3767.

## Decision

A user's notes on a site are three tables, all in `db/schema.ts`:

- `noteSections`: `id`, `siteId`, `userId`, `title`, `position`, `createdAt`, `updatedAt`.
- `notes`: `id`, `siteId`, `userId`, `sectionId`, `title` (nullable), `content`, `excerpt`,
  `position`, `createdAt`, `updatedAt`. `content` is the markdown that `EditorWysiwyg` saves for a
  page.
- `noteImages`: `id`, `siteId`, `userId`, `noteId`, `fileName`, `mimeType`, `fileSize`, `data`
  (bytea), `createdAt`.

Every `siteId`, `userId`, `sectionId` and `noteId` foreign key is `ON DELETE CASCADE`.
`models/notes.ts` (`CARDINAL.models.notes`) is the only thing that reads or writes these tables.
Every method takes `(siteId, userId, …)` and filters on both. A row that is missing, belongs to
another user, sits on another site, or is named by a malformed id answers `null` (or `false`), and
never throws. `helpers/notes.ts#notesEnabled(siteId)` is the one reader of `features.notes`. It
treats a site whose config has no `notes` key as on, and an unknown site as off.

## Why note images are not `assets` rows

An image dropped into a note has to stay readable by its owner only, and must never appear anywhere
in the page tree until the note is promoted. `assets` rows are the wrong home, for two reasons:

- **Every reader of `assets` would need a filter.** Those readers are storage sync
  (`modules/storage/*`), `models/contentSync.ts`, `models/export.ts`,
  `models/replicationExport.ts`, asset text extraction, OCR and embeddings, asset search, and the
  tree and file manager. One forgotten filter publishes a private image to a storage target or a
  search index. A separate table means none of them ever sees a note image, with no code to get
  wrong.
- **Account deletion.** `assets.authorId` has no cascade, and `api/users/admin.ts` refuses to
  delete a user who authored assets ("Reassign them first."). A user's notes and their images have
  to go with the account, which a cascading `noteImages.userId` does, and an `assets` row cannot do
  without changing how every other asset behaves on user deletion.

Storing the bytes in postgres (`bytea`) rather than on a storage target keeps a note image inside
the same transaction as its note. That lets promotion (#3771) delete the note and its images
atomically, and lets a cascade clean them up with no blob store to reconcile. Note images are
personal scratch material, not site content, so they do not need the large-file routing that
`helpers/blobTarget.ts` gives assets. Promotion copies them into real `assets` at the destination.

## Other choices

- **`excerpt` is stored, not computed on read.** It is the first non-empty line of `content`, with
  markdown stripped and fenced code and `::block` bodies skipped, at most 120 characters
  (`helpers/notes.ts#noteExcerpt`). The model rewrites it on every content write. A note list, and
  #3770's search results, then never load full content: a note holding a whiteboard can be about
  1 MiB.
- **Replication does not carry notes.** `models/replicationExport.ts` leaves all three tables out
  of a snapshot: a note is readable by its owner alone, and a snapshot by whoever holds it. A
  restore (`models/replicationImport.ts`) deletes every user and site on the target, so the cascade
  deletes every note there too. The replication routes' descriptions and the admin replication
  warning say so.
- **Deleting a site deletes the notes on it, by cascade.** `models/sites.ts#deleteSite` refuses a
  site that still holds pages or assets, but personal notes are not site content and do not block
  the delete. The cascade removes them and their images with the site, and `deleteSite` needs no
  extra step.
- **Reorder is all or nothing.** `reorderSections` and `reorderNotes` take ids in the new order.
  An id that is not the caller's, or not in the named section, or that appears twice, refuses the
  whole request and changes nothing. Owned ids the request leaves out keep their relative order
  after the listed ones, so a list that went stale during a create does not fail.
- **Moving a note** is `updateNote` with a new `sectionId`. A target section that is not the
  caller's refuses the whole update, including any other fields sent with it. A moved note goes to
  the end of its new section.
- **`features.notes` defaults to on**, both in the two seed blocks in `models/sites.ts` and for any
  existing site without the key. The site payload (`api/sites.ts#buildSitePayload`) always sends
  the resolved boolean, so the frontend never has to know about the missing-key case.
- **The reads and the delete that promotion needs (`getNote`, `listImages`, `getImage`,
  `deleteNote`) accept an optional `{ tx }`**, so #3771 can run them inside its page-creation
  transaction.
