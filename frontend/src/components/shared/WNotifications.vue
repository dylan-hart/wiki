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
        <div
          v-for="n of queue"
          :key="n.id"
          role="alert"
          aria-live="polite"
          class="w-notification pointer-events-auto relative flex w-full flex-nowrap items-center gap-2.5 px-3 py-2.5"
          :class="n.classes">
          <w-icon :name="n.icon" size="sm" class="shrink-0" />
          <div class="min-w-0 flex-1 py-1">
            <div class="text-body2 break-words">{{ n.message }}</div>
            <div v-if="n.caption" class="text-caption break-words opacity-80">{{ n.caption }}</div>
          </div>
          <button
            v-if="n.action"
            type="button"
            class="w-unstyled shrink-0 cursor-pointer border border-current/60 px-2 py-0.5 text-caption font-medium hover:bg-current/15"
            @click="runAction(n)">
            {{ n.action.label }}
          </button>
          <button
            type="button"
            :aria-label="t('common.actions.close')"
            class="w-unstyled shrink-0 cursor-pointer p-1 leading-none opacity-70 transition-opacity hover:opacity-100"
            @click="dismiss(n.id)">
            <w-icon name="mdi:close" size="xs" />
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
          -->
          <div
            v-if="n.timeout > 0"
            :key="`${n.id}-${n.count}`"
            class="w-notification-progress absolute bottom-0 start-0 h-[3px] bg-white/40"
            :style="{ animationDuration: `${n.timeout}ms` }" />
          <!--
            How many times this notification has been raised while on screen. `aria-hidden`
            because the count is already spoken: each repeat re-fires the alert.

            Keyed on the count for the same reason as the progress bar: replacing the element is
            what restarts its animation, and the bounce is the whole point -- a number quietly
            changing from 2 to 3 in the corner is easy to miss.

            Drawn as Cardinal draws every other count -- Roboto Mono on the chrome slate -- rather
            than the orange chip it used to be. It sits on a toast that is already carrying its own
            status colour, so a second status hue there said nothing and competed with the first.
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
