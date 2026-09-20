# WP 3669: `duplicateItem` comment

`frontend/src/components/FileManager.vue`, above `duplicateItem`:

- Current: `/** Only a page can be duplicated: there is no endpoint behind a folder or an asset. */`
- Now false: a folder is duplicated through `POST sites/:siteId/tree/folders/:folderId/duplicate`.
- Recommendation: delete it (the switch shows which types are handled), or reduce it to
  `/** An asset has no duplicate endpoint. */`.
