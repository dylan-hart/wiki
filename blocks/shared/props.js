/**
 * An attribute that means "off" when it says so. Lit's own `Boolean` converter reads any string at
 * all as true, `"false"` included -- and `autoplay="false"` is exactly what the block picker writes
 * for a toggle switched on and off again.
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
