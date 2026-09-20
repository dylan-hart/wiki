<template>
  <div class="loader-generic">
    <div />
  </div>
</template>

<script setup>
/**
 * The `loadingComponent` for wherever a shell is on screen before its content is — the overlays and
 * side panels, whose open transition is already running when the chunk is fetched, and the markdown
 * editor. Without it those shells stand empty and then snap to a full screen of content.
 */
</script>

<style>
/*
  Both hosts covered at once: a dialog panel is a flex column, so `flex: 1` claims the height, while
  the editor slot is a plain block of definite height, so `height: 100%` claims it there. Whichever
  applies, the other is inert.
*/
.loader-generic {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;

  > div {
    background-color: rgba(0, 0, 0, 0.75);
    width: 64px;
    height: 64px;
    position: relative;

    &:before {
      content: '';
      box-sizing: border-box;
      position: absolute;
      top: 50%;
      left: 50%;
      width: 24px;
      height: 24px;
      margin-top: -12px;
      margin-left: -12px;
      border-radius: 50%;
      border-top: 2px solid #fff;
      border-right: 2px solid transparent;
      animation: loadergenericspinner 0.6s linear infinite;
    }
  }
}

/*
  A panel waiting on its content shows nothing of itself, so what is on screen is the dimmed backdrop
  and this spinner -- not an overlay that has apparently opened empty. The surfaces being suppressed
  are declared per host, so there is no one rule to sit in front of and `!important` is what makes
  this independent of them.
*/
.w-dialog-panel:has(> .loader-generic) {
  background: none !important;
  box-shadow: none !important;
}

@keyframes loadergenericspinner {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .loader-generic > div:before {
    animation-duration: 2s;
  }
}
</style>
