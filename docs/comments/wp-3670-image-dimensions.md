# Recommended comments for WP 3670 (image dimensions)

Per the comment rule, none were added in code. Suggested:

- `backend/helpers/images.ts`, `readImageDimensions`, above the `orientation >= 5 && orientation <= 8` branch:
  `// -> EXIF orientations 5-8 are a quarter turn, which is how a browser shows them, so width and height swap`
- `backend/helpers/images.ts`, `readImageDimensions`, above `pageHeight ?? height`:
  `// -> An animated image reports every frame stacked in \`height\`; \`pageHeight\` is one frame`
- `backend/models/assets.ts`, `replace()`, above the `meta:` update:
  `// -> Merges rather than replaces so any other key survives, and drops stale width/height when the new file has none`
