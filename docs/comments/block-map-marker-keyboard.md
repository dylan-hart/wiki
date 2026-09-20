# blocks/block-map/component.js — marker `keyboard` option

The option is now `keyboard: Boolean(this.label)`, so the two-line comment plus `FIXME` above it
describe a defect that no longer exists.

Recommended change: replace the comment and FIXME with

```js
// -> Only a labelled marker is tabbable (Leaflet opens its popup on Enter); a bare pin is a picture
```

or delete it entirely (the `Boolean(this.label)` expression is close to self-explanatory; the
label-less case staying out of the tab order is the only non-obvious part).
