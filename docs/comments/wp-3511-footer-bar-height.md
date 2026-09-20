# WP 3511: footer bar height sync

`frontend/src/css/tailwind.css`, the `--footer-bar-height: 96px` declaration under the Cobalt block:

- Delete the `TODO:` paragraph ("an unusually long unbroken value can still wrap past 96px ..."). It is resolved: `composables/footerBarHeight.js` (mounted by `FooterNav.vue`) writes the measured height inline on `body`.
- Keep the "conservative ESTIMATE" paragraph, reworded as the fallback: the value applies until the footer is measured, and whenever `ResizeObserver` is unavailable.

`frontend/src/pages/Index.vue`, near "`32.5px` is a measurement of the footer bar's rendered height, not a formula off `--footer-bar-height`, which is a much larger conservative text-wrap estimate": `--footer-bar-height` is now the measured height at runtime, so "much larger conservative text-wrap estimate" is only true of the fallback. Trim to name the fallback.

`frontend/src/composables/footerBarHeight.js` has no comments; one line on why ownership is tracked (a route swap can mount the incoming footer before the outgoing one's cleanup runs, and that cleanup must not clear the new value) would be worth adding.
