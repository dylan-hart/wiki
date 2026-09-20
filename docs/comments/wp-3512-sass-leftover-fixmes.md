# WP 3512: comment changes recommended after the Sass-leftover fixes

The code fixes are in; these comments are now stale. Comment edits are left to a reviewer per project rules.

| File | Recommendation |
| --- | --- |
| `frontend/src/components/ImportBatchPageDialog.vue` (`FIXME: the &--over ...`, above `.import-batch-dropzone`) | Delete. The rules are written out in full now. |
| `frontend/src/components/ImportBatchPageDialog.vue` (`Written out in full rather than nested ...`, top of `<style>`) | Keep; it is now true of the whole block. |
| `frontend/src/components/PageDraftRestoreDialog.vue` (`FIXME: rgba(#fff, 0.08) ...`, above `.draft-diff`) | Delete the FIXME paragraph; keep the fixed-height/`overflow: hidden` explanation. |
| `frontend/src/components/PageSaveConflictDialog.vue` (same FIXME, above its diff pane rule) | Delete the FIXME paragraph. |
| `frontend/src/pages/Index.vue` (`FIXME: #{...} is Sass interpolation ...`, above `.w-separator`) | Delete. Both declarations are bare `var(--color-hairline...)` now. |
