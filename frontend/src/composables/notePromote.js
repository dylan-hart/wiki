import { defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import { dialog } from '@/composables/dialog'
import { notify } from '@/composables/notify'
import { apiErrorMessage } from '@/helpers/apiError'
import { localizedPagePath } from '@/helpers/pagePaths'
import { MarkdownRenderer } from '@/renderers/markdown'

import { useEditorStore } from '@/stores/editor'
import { useSiteStore } from '@/stores/site'

export function promoteDefaultTitle(note) {
  return (note?.title ?? '').trim() || (note?.excerpt ?? '').trim()
}

export function useNotePromote() {
  const { t } = useI18n()
  const router = useRouter()
  const siteStore = useSiteStore()
  const editorStore = useEditorStore()

  async function loadSource(note) {
    if (typeof note.content === 'string' && note.updatedAt) {
      return { content: note.content, updatedAt: note.updatedAt }
    }
    const fresh = await API_CLIENT.get(`sites/${siteStore.id}/notes/${note.id}`).json()
    return { content: fresh?.content ?? '', updatedAt: fresh?.updatedAt }
  }

  async function renderMarkdown(content, pagePath) {
    await editorStore.ensureConfigs()
    const md = new MarkdownRenderer(editorStore.editors.markdown ?? {})
    return md.render(content, { pagePath })
  }

  async function submit(note, { path, title }) {
    const source = await loadSource(note)
    const body = { path, title }
    if (source.updatedAt) {
      body.render = await renderMarkdown(source.content, path)
      body.noteUpdatedAt = source.updatedAt
    }
    return API_CLIENT.post(`sites/${siteStore.id}/notes/${note.id}/promote`, {
      json: body
    }).json()
  }

  async function finish(note, destination) {
    try {
      const result = await submit(note, destination)
      notify({ type: 'positive', message: t('notes.promote.success') })
      await router.push(localizedPagePath(result.path, result.locale, siteStore.localeRouting))
      return result
    } catch (err) {
      notify({
        type: 'negative',
        message: t('notes.promote.failed'),
        caption: apiErrorMessage(err, t('common.error.unexpected'))
      })
      return null
    }
  }

  function promote(note) {
    return new Promise((resolve) => {
      dialog({
        component: defineAsyncComponent(() => import('@/components/TreeBrowserDialog.vue')),
        componentProps: {
          mode: 'savePage',
          itemTitle: promoteDefaultTitle(note)
        }
      })
        .onOk(async (destination) => {
          resolve(await finish(note, destination))
        })
        .onCancel(() => resolve(null))
    })
  }

  return { promote }
}
