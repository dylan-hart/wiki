# WP #3635: AdminLocale.vue alias payload

Recommended comment (not added, per the no-comments rule): above the `aliases` loop in `save()` in
`frontend/src/pages/AdminLocale.vue`:

```js
// -> Sent whole (the backend replaces the map), so an emptied field is simply absent
```
