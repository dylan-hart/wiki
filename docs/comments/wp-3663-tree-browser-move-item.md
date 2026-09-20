# WP #3663: recommended comments for the `moveItem` picker mode

Not added to the code, per the comments policy. Add if wanted.

`frontend/src/components/TreeBrowserDialog.vue`, above `confirmDestination()`:

```js
// -> Same shape as the asset-move route's body: `folderId` wins there, `parentPath` is the folder
//    without surrounding slashes, and the root is `null` / `''`
```

`frontend/src/components/TreeBrowserDialog.vue`, on the `title` and `confirmLabel` props:

```js
/** `moveItem` only: supplied by the caller so folder duplicate can reuse the picker. */
```
