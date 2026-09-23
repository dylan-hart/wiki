import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { apiErrorMessage } from '@/helpers/apiError'
import { log } from '@/helpers/log'

import { notify } from '@/composables/notify'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

const CHECKBOX = 'input.task-list-item-checkbox'
const MARKER = /^\[([ xX])\] /

export async function taskItemText(markdown, index) {
  const { default: MarkdownIt } = await import('markdown-it')
  const tokens = new MarkdownIt({ html: true }).parse(markdown, {})
  let ordinal = 0
  for (let i = 2; i < tokens.length; i++) {
    const token = tokens[i]
    if (
      token.type !== 'inline' ||
      tokens[i - 1].type !== 'paragraph_open' ||
      tokens[i - 2].type !== 'list_item_open' ||
      !MARKER.test(token.content)
    ) {
      continue
    }
    if (ordinal === index) {
      return token.content.slice(4)
    }
    ordinal++
  }
  return null
}

export function renderWithTaskState(render, index, checked) {
  const template = document.createElement('template')
  template.innerHTML = render
  const box = template.content.querySelectorAll(CHECKBOX)[index]
  if (!box) {
    return null
  }
  if (checked) {
    box.setAttribute('checked', '')
  } else {
    box.removeAttribute('checked')
  }
  return template.innerHTML
}

export function useTaskToggle(container) {
  const { t } = useI18n()
  const editorStore = useEditorStore()
  const pageStore = usePageStore()
  const siteStore = useSiteStore()
  const userStore = useUserStore()

  const canTick = computed(
    () =>
      Boolean(pageStore.id) &&
      pageStore.editor === 'markdown' &&
      !pageStore.isLocked &&
      !pageStore.notFound &&
      !editorStore.isActive &&
      userStore.pagePermissions.includes('write:pages')
  )

  function boxes() {
    return [...(container.value?.querySelectorAll(CHECKBOX) ?? [])]
  }

  function syncBoxes() {
    for (const box of boxes()) {
      box.disabled = !canTick.value
    }
  }
  watch([() => pageStore.render, canTick, container], syncBoxes, {
    flush: 'post',
    immediate: true
  })

  let queue = Promise.resolve()

  async function tick(index, checked) {
    if (!pageStore.contentLoaded) {
      await pageStore.pageLoadSource()
    }
    const text = await taskItemText(pageStore.content, index)
    if (text === null) {
      throw Object.assign(new Error(t('common.page.taskConflict')), { conflict: true })
    }
    const resp = await API_CLIENT.put(
      `sites/${siteStore.id}/pages/${pageStore.id}/tasks/${index}`,
      { json: { checked, text, expectedUpdatedAt: pageStore.updatedAt } }
    ).json()
    const render = renderWithTaskState(pageStore.render, index, checked)
    pageStore.$patch({
      updatedAt: resp?.updatedAt ?? pageStore.updatedAt,
      content: '',
      contentLoaded: false,
      ...(render === null ? {} : { render })
    })
  }

  function revert(index, checked) {
    const box = boxes()[index]
    if (box) {
      box.checked = !checked
    }
  }

  function onContentChange(ev) {
    const box = ev.target
    if (!box?.matches?.(CHECKBOX) || !canTick.value) {
      return
    }
    const index = boxes().indexOf(box)
    if (index < 0) {
      return
    }
    const checked = box.checked
    queue = queue.then(async () => {
      try {
        await tick(index, checked)
      } catch (err) {
        revert(index, checked)
        const conflict = err?.conflict || err?.response?.status === 409
        if (!conflict) {
          log.warn('page', 'could not update the task', err)
        }
        notify({
          type: 'negative',
          message: conflict ? t('common.page.taskConflict') : apiErrorMessage(err)
        })
      }
    })
  }

  return { onContentChange }
}
