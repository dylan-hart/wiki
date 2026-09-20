# frontend/src/helpers/anchors.js

`scrollToAnchor`'s doc comment lacks the why the retry introduces. Suggested replacement:

```js
/**
 * For a page that is already settled — a click on the contents list, say. See
 * `scrollToAnchorWhenReady` for one that has only just been rendered.
 *
 * A block asked to reveal something does not show it in this tick: `block-tabs` sets the open panel
 * and Lit draws it in its own async update, so the target has no box yet when the event handler
 * returns. Hence a second attempt a frame later, and hence returning true before the scroll has
 * happened — callers use the result to decide whether to claim the click, and a target that had to
 * be revealed is still somewhere to go.
 *
 * @returns Whether there was a heading to scroll to
 */
```
