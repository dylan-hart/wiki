<template>
  <teleport to="body">
    <!--
      -> `left-1/2 -translate-x-1/2` centers this stack on the viewport. Deliberately physical:
         `translate-x` never mirrors under RTL, so a logical `start-1/2` paired with the same
         leftward translate would pull the stack off to one side instead of centering it.

      -> `bottom-0`, not `top-0`: anchored at the top, the stack could sit over the searchbar.
    -->
    <div
      class="w-notifications fixed bottom-0 left-1/2 z-[9000] flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 p-2 pointer-events-none">
      <transition-group name="w-notification">
        <!--
          A wrapper so the repeat-count badge can overhang the bottom-left corner from OUTSIDE
          `.w-notification`'s `overflow-hidden` box. The transition-group's generated classes key
          off its `name` prop, not off any element's own `class`, so hosting `v-for`/`:key` here
          rather than on the toast changes nothing about the enter/leave/move transitions.
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
              when its element merely re-renders, so a merged toast would keep running the original
              countdown, empty the bar, and sit there for the rest of its restarted timer.

              `start-0`, not `left-0`: the bar's width keyframes from 100% to 0% while this edge
              stays put, so the anchored edge is the one it drains TOWARD -- a leading/trailing
              question rather than a screen-position one, which must mirror under RTL.
            -->
            <div
              v-if="n.timeout > 0"
              :key="`${n.id}-${n.count}`"
              class="w-notification-progress absolute bottom-0 start-0 h-[3px] bg-white/40"
              :style="{ animationDuration: `${n.timeout}ms` }" />
          </div>
          <!--
            `aria-hidden` because the count is already spoken: each repeat re-fires the alert.

            Keyed on the count for the same reason as the progress bar -- replacing the element is
            what restarts the bounce, and a number quietly changing in the corner is easy to miss.
            Neutral slate rather than a status hue, since the toast beneath it already carries one.
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
 * Mounted once, in App.vue -- notifications are pushed from anywhere via `notify()` in
 * `composables/notify.js`.
 */

const { t } = useI18n()

/** Dismisses as well as acting, so one click does both rather than leaving the toast on screen. */
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
  Stated explicitly rather than with the `text-body2`/`text-caption` utilities: those pull in
  `@theme static`'s Material type scale, whose positive tracking is not allowed on Barlow body text.
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
  transform: translateY(24px);
}
/*
  Out of flow, so the toasts below close the gap under TransitionGroup's move transition instead of
  jumping. The insets are pinned because an absolutely positioned child resolves its offsets against
  the ancestor's PADDING box, so a `w-full` toast would grow by that padding and jump sideways
  part-way through the fade; these reproduce it, holding the leaving toast where it already was.
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
