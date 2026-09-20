# WP 3554: recommended comment changes

- `frontend/src/components/UploadPendingAssetsDialog.vue`, in `onMounted`: the line "The body is the
  file itself, not a multipart form; the locale is the server's to pick." is now wrong, since the
  request sends `locale: pageStore.locale`. Trim to: "The body is the file itself, not a multipart form."
- `frontend/src/stores/editor.js`, `clearPendingAssets`: optional one-line why, "Called wherever
  `isActive` goes false, never from an editor's unmount: an editor switch unmounts it mid-session."
