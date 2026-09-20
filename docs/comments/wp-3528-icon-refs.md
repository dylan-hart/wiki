# WP 3528: recommended comment changes

The code change added and removed no comments. Recommended edits, per the comment rubric:

## Already removed with the code

- `frontend/src/components/EditorPickerDialog.vue`: the `FIXME:` above `EDITOR_ICONS` went with the
  local map it described (the map now lives in `frontend/src/helpers/editorIcons.js`).
- `frontend/src/components/ModuleConfigForm.vue`: the `TODO:` above `iconFor()` went with the
  fallback it described.

These two were deleted in the same edit because the marker and its code cannot outlive each other.

## Recommended additions

- `frontend/scripts/generate-icons.mjs`, above `MODULES_ROOT`:
  `The backend's module definitions name a per-prop, per-action and per-ref icon: that reaches frontend/src only as fetched module data, so the source scan cannot see it.`
- `frontend/scripts/generate-icons.mjs`, above `YAML_ICON`:
  `Nested icon: lines only; a module's own top-level icon: is an asset path, not an Iconify reference.`
- `backend/test/moduleDefinitionIcons.test.ts`, above `nestedIcons`:
  `WIcon draws nothing for a name without a <prefix>:, so a bare name is an empty plate.`

## Recommended edits to existing comments

- `frontend/src/helpers/moduleConfig.js` and `BlueprintIcon.vue` need nothing: both already describe an
  ordinary Iconify reference.
