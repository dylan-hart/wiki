<template>
  <teleport to="body">
    <!--
      -> `left-1/2 -translate-x-1/2` centers this stack on the viewport (OpenProject #1590's
         physical-positioning triage): centering is symmetric, so it lands in the same place either
         way, but `translate-x` is itself a physical transform that never mirrors under RTL -- so
         `start-1/2` here, still paired with the SAME leftward translate, would pull the stack off
         to one side instead of centering it. Left physical rather than "fixed" with logical, since
         swapping only half the pair would be worse than swapping neither.
    -->
    <div
      class="w-notifications fixed top-0 left-1/2 z-[9000] flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 p-2 pointer-events-none">
      <transition-group name="w-notification">
        <!--
          The repeat-count badge below deliberately overhangs this wrapper's bottom-left corner
          (`-bottom-1.5 -left-1.5`), so it has to sit OUTSIDE the clipped, rounded `.w-notification`
          box rather than inside it (OpenProject #3038) -- this wrapper, not `.w-notification`
          itself, is what `v-for`/`:key` and the transition-group's generated enter/leave/move
          classes apply to; those classes are keyed off `<transition-group>`'s `name` prop, not off
          any element's own `class` attribute, so moving them here changes nothing about how the
          leave/move transitions behave.
        -->
        <div
          v-for="n of queue"
          :key="n.id"
          class="w-notification-wrap pointer-events-auto relative w-full">
          <div
            role="alert"
            aria-live="polite"
            class="w-notification relative flex w-full flex-nowrap items-center gap-2.5 overflow-hidden rounded-control px-3 py-2.5"
            :class="n.classes">
            <w-icon :name="n.icon" size="sm" class="shrink-0" />
            <div class="min-w-0 flex-1 py-1">
              <div class="w-notification-title break-words">{{ n.message }}</div>
              <div v-if="n.caption" class="w-notification-caption break-words opacity-80">
                {{ n.caption }}
              </div>
            </div>
            <button
              v-if="n.action"
              type="button"
              class="w-notification-undo w-unstyled shrink-0 cursor-pointer border border-current/60 px-2 py-0.5 hover:bg-current/15"
              @click="runAction(n)">
              {{ n.action.label }}
            </button>
            <button
              type="button"
              :aria-label="t('common.actions.close')"
              class="w-unstyled shrink-0 cursor-pointer p-1 leading-none opacity-70 transition-opacity hover:opacity-100"
              @click="dismiss(n.id)">
              <w-icon name="tabler:x" size="xs" />
            </button>
            <!--
              Keyed on the count so a repeat replaces the element: a CSS animation does not restart
              when its element merely re-renders, so a merged toast would otherwise keep running the
              original countdown, empty the bar, and then sit there for the remainder of its
              restarted timer with nothing left to show.

              `start-0` (OpenProject #1590), not `left-0`: the bar's WIDTH keyframes from 100% to 0%
              while this edge stays put, so whichever edge it is anchored to is the edge the bar
              drains TOWARD as time runs out. `left-0` pinned that to the physical left always, which
              reads as depleting toward the trailing edge under RTL instead of the reading-end one --
              this is a spacing gutter's usual leading/trailing question, not a screen-position one,
              so it belongs with the rest of this component's already-logical classes, not the
              allowlist.

              `overflow-hidden` on `.w-notification` (OpenProject #3038) clips this bar's own square
              corners to whatever `--radius-control` currently resolves to -- 0 under Ledger (no
              visible change), a real radius under Cobalt, where the 3px-tall, full-width bar used
              to poke past the container's now-rounded bottom corners.
            -->
            <div
              v-if="n.timeout > 0"
              :key="`${n.id}-${n.count}`"
              class="w-notification-progress absolute bottom-0 start-0 h-[3px] bg-white/40"
              :style="{ animationDuration: `${n.timeout}ms` }" />
          </div>
          <!--
            How many times this notification has been raised while on screen. `aria-hidden`
            because the count is already spoken: each repeat re-fires the alert.

            Keyed on the count for the same reason as the progress bar: replacing the element is
            what restarts its animation, and the bounce is the whole point -- a number quietly
            changing from 2 to 3 in the corner is easy to miss.

            Drawn as Cardinal draws every other count -- Roboto Mono on the chrome slate -- rather
            than the orange chip it used to be. It sits on a toast that is already carrying its own
            status colour, so a second status hue there said nothing and competed with the first.

            A sibling of `.w-notification`, not a child of it: `.w-notification` now carries
            `overflow-hidden` (OpenProject #3038) and this badge deliberately overhangs its
            bottom-left corner, so nesting it inside would clip it the moment the bar-clipping fix
            landed.
          -->
          <span
            v-if="n.count > 1"
            :key="`${n.id}-count-${n.count}`"
            class="w-notification-count absolute -bottom-1.5 -left-1.5 flex h-4 min-w-4 items-center justify-center bg-slate px-1 font-mono text-[10px] leading-none font-semibold text-white"
            aria-hidden="true">
            {{ n.count }}
          </span>
        </div>
      </transition-group>
    </div>
  </teleport>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { dismiss, queue } from '@/composables/notify'

/**
 * Renders the notification stack. Mounted once, in App.vue -- notifications are pushed from
 * anywhere via `notify()` in `composables/notify.js`.
 *
 * Each toast's corner takes `--radius-control` -- `0` under Ledger (unchanged from before) and a
 * real value under Cobalt (`body.body--cobalt`, OpenProject #2767/#2772), matching "toasts ... take
 * `--radius-control`".
 */

// I18N

const { t } = useI18n()

/** Runs a notification's action (OpenProject #2073's undo-discard toast is the first caller), then
 * dismisses it -- one click both acts and clears the toast, rather than leaving it to auto-dismiss
 * or requiring a second click on the close button. */
function runAction(n) {
  n.action.onClick()
  dismiss(n.id)
}
</script>

<style scoped>
/* The container's own padding, shared so the leave rule below cannot drift away from it */
.w-notifications {
  --w-notifications-inset: 0.5rem;
}

/*
  Toast typography (cobalt-typography.md §3, "Shared primitives"). Explicit rather than the Material
  `text-body2`/`text-caption` utilities this used to carry -- those pull in `@theme static`'s type
  scale (14px/400/0.018em tracking and 12px/400/0.033em tracking respectively), which is exactly the
  "Material scale reaching a Cardinal role" the audit forbids, and the positive tracking on top of it
  violates the "no positive letter-spacing on Barlow body text" rule regardless of aesthetic. Sizes
  and weights are unchanged between Ledger and Cobalt; only each toast's own fill color (`n.classes`,
  `composables/notify.js`) varies.
*/
.w-notification-title {
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: normal;
}

.w-notification-caption {
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: normal;
}

.w-notification-undo {
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: normal;
}

.w-notification-progress {
  animation: w-notification-progress linear forwards;
}

.w-notification-count {
  animation: w-notification-count-bounce 0.45s var(--ease-standard);
}

/* Overshoot, settle back past the resting size, then land -- a spring rather than a pop */
@keyframes w-notification-count-bounce {
  0% {
    transform: scale(0.4);
  }
  45% {
    transform: scale(1.35);
  }
  70% {
    transform: scale(0.92);
  }
  100% {
    transform: scale(1);
  }
}

@keyframes w-notification-progress {
  from {
    width: 100%;
  }
  to {
    width: 0%;
  }
}

.w-notification-enter-active,
.w-notification-leave-active {
  transition:
    opacity 0.3s var(--ease-standard),
    transform 0.3s var(--ease-standard);
}
.w-notification-enter-from,
.w-notification-leave-to {
  opacity: 0;
  transform: translateY(-24px);
}
/*
  Takes the leaving toast out of flow, so the ones below it close the gap under TransitionGroup's
  move transition instead of jumping.

  The insets are pinned rather than left to the static position. An absolutely positioned child
  resolves its offsets against the nearest positioned ancestor's PADDING box, so a `w-full` toast
  grew by the container's padding the instant it left the flow -- a sideways jump part-way through
  the fade. These reproduce that padding, holding the leaving toast exactly where it already was.
*/
.w-notification-leave-active {
  position: absolute;
  inset-inline-start: var(--w-notifications-inset);
  inset-inline-end: var(--w-notifications-inset);
  width: auto;
}
.w-notification-move {
  transition: transform 0.3s var(--ease-standard);
}

@media (prefers-reduced-motion: reduce) {
  .w-notification-enter-active,
  .w-notification-leave-active,
  .w-notification-move {
    transition-duration: 0.01ms;
  }
  .w-notification-progress,
  .w-notification-count {
    animation: none;
  }
}
</style>
