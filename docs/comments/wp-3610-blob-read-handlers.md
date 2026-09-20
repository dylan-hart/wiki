# WP 3610: recommended comments

Comments not added in code (per the comment policy); apply if the rubric agrees.

- `backend/models/storage.ts`, above `readAsset?` in `StorageModule`: `readAsset`/`headAsset` read an
  asset back from a target for read-through serving. A `null` result is always a genuine not-found; a
  failure to ask throws. Keyed exactly as the write handlers key it (`keyFor`).
- `backend/modules/storage/blobBase.ts`, above `get?` in `BlobDriver`: optional until azure and gcs
  implement them (sibling task). `blobStorageModule` throws a "not supported" error for a driver
  without them rather than returning null, so absence is never mistaken for not-found.
- `backend/modules/storage/s3/storage.ts`, above `isObjectNotFound`: `NoSuchBucket` also carries a
  404 but is a configuration failure, not a missing object, so it is excluded.
