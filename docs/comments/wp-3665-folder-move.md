# Recommended comments for WP #3665 (folder move)

Per the comment policy, none were added to code. Suggested additions, each earning its place as a
non-obvious why:

- `backend/models/tree.ts`, `moveFolder`, above the deep-descendant `UPDATE`:
  `// -> nlevel(oldPath), not newPath: unlike a rename, the move changes the path's depth.`
- `backend/models/tree.ts`, `moveFolder`, above the `startsWith` check:
  `// -> Segment boundary ("oldPath."), so moving "docs" into "docs-archive" is still allowed.`
- `backend/models/tree.ts`, `moveFolder`, above the `getFolder(... createIfMissing)` call:
  `// -> Inside the transaction and after the subtree check, so a refused move leaves no new folders.`
- `backend/models/tree.ts`, `moveFolder`, above the `isUniqueViolation` catch:
  `// -> Closes the race the assertFolderNameFree probe cannot.`
- `backend/api/tree.ts`, move route, above the `startsWith` check:
  `// -> Refused before the permission walk so the answer does not depend on what the caller holds.`
