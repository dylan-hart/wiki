# WBadge floating offset (OpenProject #3506)

The floating variant is now `end-0 translate-x-1/2 rtl:-translate-x-1/2`, so two comments describing
the old physical `right-0` pair are stale. Comments were not edited in the code change itself.

## frontend/src/components/shared/WBadge.vue, `classes` computed

Delete the whole `// -> The physical right-0 is deliberate ... TODO: correct the pair together ...`
block above the `props.floating` line. The TODO is done and the reasoning it records no longer holds.

## frontend/src/components/shared/WBadge.test.js

Delete the two-line `// -> The physical position is deliberate ...` comment above
`pins a floating badge to the inline-end top corner ...`. It contradicts the code.
