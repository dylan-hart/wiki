# Decision: accept a changed lockfile integrity hash when SHA-pinning `twemoji-assets`

Status: **Adopted** — OpenProject #3170.

## Decision

`frontend/package.json`'s `twemoji-assets` dependency now points at
`https://codeload.github.com/jdecked/twemoji/tar.gz/b6b55fef1e8636b540a6d016a4729ca8cdf2e60b` — the
commit SHA that tag `v17.0.3` resolves to — instead of
`https://codeload.github.com/jdecked/twemoji/tar.gz/refs/tags/v17.0.3`. The regenerated
`package-lock.json` integrity hash for that entry **changed**
(`sha512-SQpW4KJell...` → `sha512-FsyhJKB9lVIAWRl...`), even though the underlying commit and file
contents are unchanged. We accept the new hash rather than treating the change as evidence the tag
moved.

## Why

WP 3170 assumed (reasonably, from the outside) that pinning the same commit by SHA instead of by tag
would produce a byte-identical tarball and therefore an unchanged lockfile integrity hash — and
instructed stopping to investigate if it didn't. It doesn't hold for GitHub's `codeload.github.com`
tarball service, verified directly rather than assumed:

```
$ curl -sL .../tar.gz/refs/tags/v17.0.3 | tar -tz | head -1
twemoji-17.0.3/
$ curl -sL .../tar.gz/b6b55fef1e8636b540a6d016a4729ca8cdf2e60b | tar -tz | head -1
twemoji-b6b55fef1e8636b540a6d016a4729ca8cdf2e60b/
```

`codeload` embeds the literal ref string used in the request URL as the archive's top-level directory
name. A tag-ref request and a commit-SHA request for the exact same commit therefore always produce
different tarball bytes — and thus different npm integrity hashes — regardless of whether the tag has
moved. Extracting both tarballs and diffing their contents confirms the file trees are byte-for-byte
identical (`diff -rq` exits 0, no output) once the differing top-level directory name is accounted
for; `gh api repos/jdecked/twemoji/git/ref/tags/v17.0.3` independently confirms the tag's `object.sha`
is exactly `b6b55fef1e8636b540a6d016a4729ca8cdf2e60b`, the same commit now pinned by URL.

So a changed integrity hash here is the _expected, permanent_ result of switching a codeload URL from
a tag ref to a SHA ref — not a signal of tag drift — and there is no way to SHA-pin this dependency
through `codeload.github.com` while also keeping the hash unchanged. The new hash is the correct one
for the new (SHA-pinned) URL and continues to make `npm ci` fail closed against any future tampering,
which is the actual property this pin exists to protect. Re-verifying that the pinned SHA still
matches the tag (rather than diffing hashes) is the right check on any future manual bump of this
dependency — see the note in `frontend/vite.config.js` next to `twemojiAssets()`.
