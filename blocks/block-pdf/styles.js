import { css } from 'lit'

/**
 * `block-pdf`'s stylesheet, split out of `component.js`.
 *
 * The viewer is the largest block in this directory by a wide margin, and some 250 of its lines were
 * a single `css` template with no logic in it at all (BLK-F9). Two fragments rather than one, since
 * they come from different places and are maintained against different things: `viewerStyles` is
 * this block's own chrome, while `textLayerStyles` is lifted from pdf.js's own stylesheet and has to
 * keep tracking it.
 */

/** The space around a page, and between one page and the next. */
export const PAGE_GAP = 12

/** The viewer's own chrome: the raised box, the toolbar, the scroller and the pages in it. */
export const viewerStyles = css`
  :host {
    display: block;

    --pdf-canvas-bg: #f1f3f5;
  }
  :host([dark]) {
    --pdf-canvas-bg: #12161d;
  }

  /*
    One box, with the toolbar and the pages clipped to its corners. Border rather than a shadow
    (OpenProject #2875's ground rules: remove box-shadow on cards) -- var(--block-border)/
    var(--block-radius), same as every other block's own card.

    -> It also carries the gap below the block. On this element rather than :host: see block-index.
  */
  .viewer {
    margin-bottom: 16px;
    border: 1px solid var(--block-border);
    border-radius: var(--block-radius);
    overflow: hidden;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--block-border);
    background-color: var(--block-tint-bg);
    color: var(--block-caption-fg);
    font-size: 13px;
    line-height: 1;
  }

  .spacer {
    flex: 1 1 auto;
  }

  .tool {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .tool:hover:not(:disabled) {
    background-color: rgb(0 0 0 / 0.07);
    color: var(--block-accent-fg);
  }
  :host([dark]) .tool:hover:not(:disabled) {
    background-color: rgb(255 255 255 / 0.1);
  }
  .tool:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tool svg {
    width: 18px;
    height: 18px;
    fill: currentColor;
  }

  .pager {
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }

  /* -> A number input wide enough for four digits, without the spinner taking half of it */
  .pager input {
    width: 4ch;
    padding: 4px 2px;
    border: 1px solid var(--block-border);
    border-radius: 4px;
    background-color: rgb(255 255 255 / 0.6);
    color: inherit;
    font: inherit;
    text-align: center;
    appearance: textfield;
    -moz-appearance: textfield;
  }
  .pager input::-webkit-inner-spin-button,
  .pager input::-webkit-outer-spin-button {
    appearance: none;
    margin: 0;
  }
  :host([dark]) .pager input {
    background-color: rgb(0 0 0 / 0.25);
  }

  select {
    max-width: 9rem;
    padding: 4px 6px;
    border: 1px solid var(--block-border);
    border-radius: 4px;
    background-color: rgb(255 255 255 / 0.6);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  :host([dark]) select {
    background-color: rgb(0 0 0 / 0.25);
  }

  /*
    The scrolling surface.

    -> scrollbar-gutter keeps the width the pages are fitted to from changing the moment the
       scrollbar appears, which at "fit width" is a measurement that decides the very layout that
       brings the scrollbar in.
  */
  .scroller {
    position: relative;
    overflow: auto;
    scrollbar-gutter: stable;
    background-color: var(--pdf-canvas-bg);
  }

  .pages {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${PAGE_GAP}px;
    padding: ${PAGE_GAP}px;
    min-width: min-content;
  }

  .page {
    position: relative;
    flex: none;
    background-color: #fff;
    /*
      A hairline rather than the drop shadow this used to draw (OpenProject #2875's ground rules) --
      what a single page needs against the scroller's own background is definition, not elevation,
      the same trade block-kroki's/block-drawio's .sheet already made.
    */
    border: 1px solid var(--block-border);

    /* -> What pdf.js sizes the text layer against; see setLayerDimensions in its source. */
    --scale-factor: 1;
    --user-unit: 1;
    --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
    --scale-round-x: 1px;
    --scale-round-y: 1px;
  }

  .page canvas {
    display: block;
    width: 100%;
    height: 100%;
  }

  .status {
    padding: 2rem 1rem;
    color: var(--block-caption-fg);
    text-align: center;
    font-size: 13px;
  }

  .error {
    margin-bottom: 16px;
  }
`

/**
 * The text layer: a transparent copy of the page's words, positioned over the drawing so they can be
 * selected and searched for. Lifted from pdf.js's own stylesheet, which is 160 kB of viewer chrome
 * this block has no other use for.
 */
export const textLayerStyles = css`
  .textLayer {
    position: absolute;
    inset: 0;
    overflow: clip;
    z-index: 1;
    opacity: 1;
    line-height: 1;
    text-align: initial;
    letter-spacing: normal;
    word-spacing: normal;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    caret-color: CanvasText;

    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
  }

  .textLayer :is(span, br) {
    position: absolute;
    color: transparent;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
    user-select: text;
  }

  .textLayer > :not(.markedContent),
  .textLayer .markedContent span:not(.markedContent) {
    z-index: 1;

    --font-height: 0;
    --scale-x: 1;
    --rotate: 0deg;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
  }

  .textLayer .markedContent {
    display: contents;
  }

  .textLayer span[role='img'] {
    user-select: none;
    cursor: default;
  }

  .textLayer ::selection {
    background: color-mix(in srgb, AccentColor, transparent 50%);
    color: transparent;
  }

  .textLayer br::selection {
    background: transparent;
  }
`
