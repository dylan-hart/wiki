# WP 3485: HeaderNav.vue comment updates (recommended, not applied)

- `lastNonGraphPath` doc comment: it is now only the fallback exit target, used when
  `graphStore.selectedPath` is unset. Reword "where the Graph button returns to on exit" to say so, and
  keep the note that it is independent of the graph's `path` query param and defaults to `/` for a
  session that lands on `/_graph`.
- `onGraphNavClick()` doc comment: add why `graphStore.selectedPath` is read synchronously before
  `router.push` (`Graph.vue`'s unmount clears it), and that a selected folder path may resolve to a
  not-yet-existing page.
