# WP #3508 recommended comment changes

## frontend/src/logicalSpacing.test.js

Delete the `// TODO: ml-auto/mr-auto (and -px) escape this pattern ...` two-line comment above
`UTILITY_PATTERN`: the pattern now matches `auto` and `px`, so the TODO is resolved.

## frontend/src/i18nSourceGate.test.js

The TODO above the removed `ALLOWED_NOTIFY_MESSAGES` constant was deleted together with the constant
it annotated; nothing else to change.
