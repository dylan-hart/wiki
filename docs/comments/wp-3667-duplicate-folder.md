# Recommended comments for WP 3667 (`Tree#duplicateFolder`)

Not added to the code, per the comment policy. Apply on review.

## `backend/models/tree.ts`, above `duplicateFolder`

```ts
/**
 * Copies the folder's whole subtree (folders, pages, assets) to a destination as independent rows,
 * all in one transaction. Everything that reaches outside the database (page history, search,
 * webhooks, storage dispatch, renders) runs only after the commit, so a failure part-way leaves
 * nothing behind and announces nothing.
 *
 * @param id The folder to copy.
 * @param folderId Destination folder; takes precedence over `parentPath`.
 * @param parentPath Destination, created if missing. The site root when both are absent.
 * @param pathName Name of the copy's root folder. Defaults to the source's, so copying beside the
 *   source needs a new one.
 * @throws CustomError `treeFolderDuplicate` (409) if the destination already holds a folder or asset
 *   of that name; `treeReservedLocaleSegment` (400) for a root copy named after a locale code.
 */
```

Inline, at the descendant `select`:

```ts
// -> Read before the root copy is created: a destination inside the source would otherwise pick the
//    new folder up as one of its own descendants and copy it again
```

At the asset `INSERT ... SELECT`:

```ts
// -> Bytes and preview are copied inside postgres rather than loaded here, so a folder of large
//    files never sits in memory
```

At the `passwordHash` argument:

```ts
// -> The stored bcrypt hash travels as-is: dropping it would publish a protected page
```

## `backend/models/pages.ts`, on `insertPageRows` / `completePageCreate`

Above `insertPageRows`:

```ts
/**
 * The database half of `createPage`, split out so a caller creating several pages in one
 * transaction can commit them together and only then run `completePageCreate` for each.
 *
 * @param tx Every write goes through this instead of the ambient `CARDINAL.db`.
 * @param passwordHash An already-hashed password to store as-is, taking precedence over
 *   `input.password`.
 */
```

Above `completePageCreate`:

```ts
/** History, search, announcements, caches and the render: everything after the rows exist. */
```

The `if (!tx)` guard before the compensating delete deserves one line:

```ts
// -> Inside a caller's transaction the failed statement has aborted it, so a delete here would only
//    mask the real error; the caller's rollback removes the page row
```
