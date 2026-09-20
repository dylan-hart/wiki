# WP #3668: comments recommended for the folder duplicate route

Recommended additions to `backend/api/tree.ts`, `POST /sites/:siteId/tree/folders/:folderId/duplicate`.
No code comments were added; each one below carries a why the code does not show.

- Above the `schema` (repo convention for path-bound permissions, matches the rename/delete routes):
  `// -> No route-level permissions: page permissions are path-bound, checked in the handler`
- Above the `mayOnFolder(..., 'manage:pages', ...)` ancestor loop:
  `// -> The model creates whatever part of parentPath is missing, and a rule matches on path, so each folder it would create is a write of its own`
- Above the into-self refusal:
  `// -> Compared on whole segments, so copying a into ab is not copying it into itself`
- Above the `listDescendants` walk:
  `// -> Everything is judged before the one model call: it does no permission check of its own and copies in a single transaction, so nothing partial is left behind`
- Above the `unlockedFor` / `getPage` locked check:
  `// -> A locked page's body is withheld from anyone who has not entered its password, and the copy would hand it over`

Notes for the integrator:

- The rename route, the delete route and this one each walk `listDescendants` inline. No shared
  descendant-permission walker was extracted; #3665's move route may want the same walk.
- The request body must be an object; a client with no fields sends `{}`.
