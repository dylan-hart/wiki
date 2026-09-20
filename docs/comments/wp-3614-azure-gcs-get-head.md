# WP 3614: recommended comments

Comments not added in code (per the comment policy); apply if the rubric agrees.

- `backend/modules/storage/blobBase.ts`, above `get` in `BlobDriver`: `get`/`head` return null only
  for a genuinely missing object and throw for any other failure. The optional-until-siblings-land
  note from WP 3610 is now obsolete (`docs/comments/wp-3610-blob-read-handlers.md`, second bullet).
- `backend/modules/storage/gcs/storage.ts`, in `get`: `createReadStream` reports a missing object
  only as a later stream error, so the up-front `getMetadata` lookup is what turns a miss into null
  rather than a broken body.
- `backend/modules/storage/azure/storage.ts`, above `isBlobNotFound`, and
  `backend/modules/storage/gcs/storage.ts`, above `isObjectNotFound`: a missing container/bucket also
  carries a 404 but is a configuration failure, not a missing object, so it is excluded.
