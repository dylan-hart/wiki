# WP 3589 — `blocks/block-tabs/component.js`

`_applyScrollMargin` doc comment: the margin is now set on each panel element as well as its
children (a `header` tab is anchored on the panel itself). Suggested replacement:

```
  /**
   * A target's own `scroll-margin-top` knows nothing about the strip standing above it, so
   * scrolling to one in a panel would push the tabs themselves off screen. Set on the panel and
   * its children (a `header` tab is anchored on the panel itself) because the content is slotted,
   * and measured because the strip wraps onto any number of rows.
   */
```
