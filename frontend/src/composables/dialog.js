import { getCurrentInstance, markRaw, nextTick, onMounted, reactive, ref } from 'vue'

import WConfirmDialog from '@/components/shared/WConfirmDialog.vue'
import { log } from '@/helpers/log'

/** @type {Array<{ id: number, component: object, props: object, handlers: object }>} */
export const openDialogs = reactive([])

let seq = 0

export function dialog({ component, componentProps = {} }) {
  /*
    Loudly, because the failure is otherwise invisible: a `dialog({ title, message })` call mounts
    nothing, so `.onOk()` never fires and the button that opened it appears to do nothing at all.
  */
  if (!component) {
    log.error(
      'dialog',
      'dialog() requires a component; for a title/message confirmation, call confirm() instead',
      componentProps
    )
  }

  const id = ++seq
  const handlers = { ok: [], cancel: [], dismiss: [] }

  openDialogs.push({
    id,
    // -> A component definition is deeply-nested config, never reactive data; markRaw keeps Vue
    //    from walking it and avoids the "component was made reactive" warning
    component: markRaw(component),
    props: componentProps,
    handlers
  })

  const chain = {
    onOk(cb) {
      handlers.ok.push(cb)
      return chain
    },
    onCancel(cb) {
      handlers.cancel.push(cb)
      return chain
    },
    onDismiss(cb) {
      handlers.dismiss.push(cb)
      return chain
    }
  }
  return chain
}

export function closeDialog(id, okFired, payload) {
  const idx = openDialogs.findIndex((d) => d.id === id)
  if (idx < 0) {
    return
  }
  const { handlers } = openDialogs[idx]
  openDialogs.splice(idx, 1)

  if (okFired) {
    handlers.ok.forEach((cb) => cb(payload))
  } else {
    handlers.cancel.forEach((cb) => cb())
  }
  handlers.dismiss.forEach((cb) => cb())
}

/**
 * `opts` are `WConfirmDialog`'s props. `onOk` receives `true`, or the chosen value when `options`
 * is given.
 */
export function confirm(opts = {}) {
  return dialog({ component: WConfirmDialog, componentProps: opts })
}

/** Spread into a dialog component's `defineEmits()`; `closeDialog()` depends on both events. */
export const dialogComponentEmits = ['ok', 'hide']

/**
 * For a component opened via `dialog()`: bind `dialogVisible` as `v-model` and `onDialogHide` as
 * `@hide` on its root `<w-dialog>`.
 *
 * `autofocus` is a getter rather than the ref itself, so the call can be written above the ref's
 * own declaration and the component's sections stay in their usual order.
 *
 * @param {object} [opts]
 * @param {() => { focus?: Function } | null} [opts.autofocus] The control to focus on open.
 */
export function useDialogComponent({ autofocus } = {}) {
  const { emit } = getCurrentInstance()
  const dialogVisible = ref(false)

  // -> Mount hidden then flip on the next tick, so the open transition actually runs; mounting with
  //    `true` would snap the dialog into place with no animation
  onMounted(() =>
    nextTick(() => {
      dialogVisible.value = true

      /*
        Focus AFTER a second tick, which is why this lives here rather than in each dialog: `WDialog`
        renders its panel only while open, so flipping the flag above is what mounts the field. A
        dialog calling `focus()` from its own `onMounted` finds a null ref and silently does nothing.
      */
      if (autofocus) {
        nextTick(() => {
          autofocus()?.focus()
        })
      }
    })
  )

  return {
    dialogVisible,

    onDialogOK(payload) {
      emit('ok', payload)
      dialogVisible.value = false
    },

    onDialogCancel() {
      dialogVisible.value = false
    },

    /** Fires once the close transition has finished, not when the dialog starts closing. */
    onDialogHide() {
      emit('hide')
    }
  }
}
