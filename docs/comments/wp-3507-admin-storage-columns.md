# WP 3507: admin column stacking

## `frontend/src/pages/AdminStorage.vue`, comment above the inner `flex flex-wrap gap-4` row

Now stale: it says the infobox is a fixed 300px and the settings "take what is left". The settings
column now has a real `basis-80` minimum and the infobox is `w-[300px] max-w-full`, so the row
stacks instead of squeezing.

Suggested replacement:

```html
<!--
  Flex rather than the 12-column grid: `col-span-12` on the settings would take a whole grid row
  and push the infobox underneath. The settings column's `basis-80` (not `flex-1`, whose zero basis
  never wraps) is what makes the infobox drop below it when there is no room.
-->
```

## `frontend/src/pages/AdminAnalytics.vue` and `AdminAuth.vue`, `<!-- -> `min-w-0`, ... -->`

Still accurate (`min-w-0` is kept on the panel); no change needed.
