# frontend/index.html: temporal-polyfill preload comments (WP 3501)

The `__wikiTemporalPolyfillUrl` wiring is fixed, so these comments are now stale. No comment was
edited in the change itself.

1. **Delete the `FIXME:` paragraph** inside the `temporal-polyfill-preload:start` comment ("nothing
   substitutes `__TEMPORAL_POLYFILL_HREF__` ..."). The placeholder is gone; the script reads
   `window.__wikiTemporalPolyfillUrl`, which the plugin's inline script defines above it. Once it is
   deleted, `index.test.js` and `src/build/temporalPolyfillChunk.test.js` can drop their
   comment-stripping regex and assert `__TEMPORAL_POLYFILL_HREF__` is absent from the whole file.
2. **Move the "Substituted by `src/build/temporalPolyfillChunk.js` ..." comment** to sit directly
   above the `<!--temporal-polyfill-chunk-url-->` placeholder, which now precedes the preload block
   (the comment was left behind at the placeholder's old position). Add one clause: the placeholder
   must stay above the preload script so the URL is defined when it runs.
3. **Keep the marker comments** (`temporal-polyfill-preload:start`/`:end`); `index.test.js` anchors on them.
