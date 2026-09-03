/**
 * Reactive-property declarations shared by more than one block.
 */

/**
 * An attribute that means "off" when it says so.
 *
 * MDC writes every prop with a value -- `autoplay="false"` is what the block picker produces for a
 * toggle that was switched on and off again -- and Lit's own `Boolean` converter reads any string at
 * all as true, that one included. The picker never writes `"false"` for a prop still holding its
 * default, since it leaves such a prop out altogether, but a page written by hand can say it and
 * means it.
 *
 * Spread into a property declaration: `showIcons: { ...boolean, attribute: 'show-icons' }`. A prop
 * using this and defaulting to `false` should also declare `default: false` in `static definition`,
 * so the picker offers the toggle in the off position it actually starts in.
 */
export const boolean = {
  converter: {
    fromAttribute: (value) => value !== null && value !== 'false',
    toAttribute: (value) => (value ? 'true' : null)
  }
}
