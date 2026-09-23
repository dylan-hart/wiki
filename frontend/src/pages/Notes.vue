<template>
  <w-page class="notes-page">
    <div v-if="!userStore.authenticated" class="notes-page-message notes-page-guest">
      <w-icon name="tabler:notes" size="xl" />
      <p>{{ t('notes.signInRequired') }}</p>
      <w-btn color="primary" icon="tabler:login" :label="t('notes.signIn')" to="/login" />
    </div>
    <div v-else-if="!notesEnabled" class="notes-page-message notes-page-disabled">
      <w-icon name="tabler:notes" size="xl" />
      <p>{{ t('notes.disabled') }}</p>
    </div>
    <template v-else>
      <div class="notes-page-top">
        <notes-section-tabs
          ref="sectionTabs"
          class="min-w-0 flex-1"
          :sections="state.sections"
          :model-value="state.activeSectionId"
          @update:model-value="selectSection"
          @add="addSection"
          @rename="renameSection"
          @delete="deleteSection"
          @reorder="reorderSections"
          @move-note="moveNote" />
        <span
          class="notes-save-indicator"
          :class="`notes-save-indicator--${autosave.state.status}`"
          role="status"
          aria-live="polite">
          <template v-if="saveIndicator">
            <w-icon :name="saveIndicator.icon" size="16px" />
            <span>{{ saveIndicator.label }}</span>
          </template>
        </span>
      </div>
      <div class="notes-page-body">
        <aside class="notes-page-sidebar">
          <notes-list
            :notes="state.notes"
            :model-value="state.current?.id ?? null"
            :sections="state.sections"
            :section-id="state.activeSectionId"
            :loading="state.notesLoading"
            @update:model-value="openNote"
            @add="addNote"
            @rename="renameNote"
            @delete="deleteNote"
            @reorder="reorderNotes"
            @move="moveNoteFromList" />
        </aside>
        <section class="notes-page-editor">
          <template v-if="state.current">
            <div class="notes-page-header">
              <w-input
                class="notes-page-title"
                :model-value="state.current.title ?? ''"
                :placeholder="titlePlaceholder"
                :aria-label="t('notes.noteTitle')"
                hide-bottom-space
                @update:model-value="onTitleInput" />
              <w-btn
                flat
                color="primary"
                icon="tabler:file-arrow-right"
                class="notes-page-promote"
                :label="t('notes.promote.action')"
                :loading="state.promoting"
                @click="promoteCurrent" />
            </div>
            <editor-wysiwyg
              :key="state.current.id"
              class="notes-page-wysiwyg"
              :content="state.current.content ?? ''"
              :upload-file="uploadFile"
              :autofocus="state.focusBody"
              @update:content="onContentInput" />
          </template>
          <div v-else-if="state.noteLoading" class="notes-page-message">
            <em>{{ t('notes.loading') }}</em>
          </div>
          <div v-else-if="state.loaded" class="notes-page-message notes-page-empty">
            <p>{{ state.sections.length ? t('notes.pickOrAdd') : t('notes.noSections') }}</p>
            <w-btn
              color="primary"
              icon="la:plus"
              class="notes-page-empty-add"
              :label="t('notes.addNote')"
              @click="createQuickNote" />
          </div>
        </section>
      </div>
    </template>
  </w-page>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'

import EditorWysiwyg from '@/components/EditorWysiwyg.vue'
import NotesList from '@/components/NotesList.vue'
import NotesSectionTabs from '@/components/NotesSectionTabs.vue'

import { confirm } from '@/composables/dialog'
import { useMeta } from '@/composables/meta'
import { createNoteAutosave } from '@/composables/noteAutosave'
import { notesApi } from '@/composables/notesApi'
import { useNotePromote } from '@/composables/notePromote'
import { notify } from '@/composables/notify'

import { noteExcerpt } from '@/helpers/noteExcerpt'

import { useSiteStore } from '@/stores/site'
import { useUserStore } from '@/stores/user'

const LAST_SECTION_KEY_PREFIX = 'notes.lastSection.'

const route = useRoute()
const router = useRouter()

const siteStore = useSiteStore()
const userStore = useUserStore()

const { t } = useI18n()

useMeta(() => {
  const siteTitle = siteStore.title
  return {
    title: t('notes.title'),
    titleTemplate: (title) => `${title} - ${siteTitle}`
  }
})

const sectionTabs = ref(null)

const state = reactive({
  loaded: false,
  sections: [],
  activeSectionId: null,
  notes: [],
  notesLoading: false,
  current: null,
  noteLoading: false,
  focusBody: false,
  promoting: false
})

const notesEnabled = computed(() => siteStore.features?.notes !== false)

const api = computed(() => notesApi(siteStore.id))

const autosave = createNoteAutosave({
  save: async (noteId, patch) => {
    const saved = await api.value.updateNote(noteId, patch)
    if (saved?.updatedAt && state.current?.id === noteId) {
      state.current.updatedAt = saved.updatedAt
    }
    return saved
  },
  onError: () => {
    notify({ type: 'negative', message: t('notes.saveFailed') })
  }
})

const { promote } = useNotePromote({ beforeSubmit: flushBeforePromote })

const saveIndicator = computed(() => {
  switch (autosave.state.status) {
    case 'pending':
    case 'saving':
      return { icon: 'tabler:cloud-upload', label: t('notes.saving') }
    case 'saved':
      return { icon: 'tabler:cloud-check', label: t('notes.saved') }
    case 'error':
      return { icon: 'tabler:alert-triangle', label: t('notes.saveFailed') }
    default:
      return null
  }
})

const titlePlaceholder = computed(
  () => noteExcerpt(state.current?.content) || t('notes.titlePlaceholder')
)

function lastSectionKey() {
  return `${LAST_SECTION_KEY_PREFIX}${siteStore.id}`
}

function readLastSection() {
  try {
    return localStorage.getItem(lastSectionKey())
  } catch {
    return null
  }
}

function writeLastSection(sectionId) {
  try {
    localStorage.setItem(lastSectionKey(), sectionId)
  } catch {
    return
  }
}

function listEntry(noteId) {
  return state.notes.find((note) => note.id === noteId) ?? null
}

async function loadSections() {
  state.sections = await api.value.listSections()
}

async function loadNotes(sectionId) {
  state.notesLoading = true
  try {
    const notes = await api.value.listNotes(sectionId)
    if (state.activeSectionId === sectionId) {
      state.notes = notes
    }
  } finally {
    state.notesLoading = false
  }
}

let openSeq = 0

async function openNote(noteId, { focus = false } = {}) {
  if (state.current?.id === noteId) {
    return
  }
  const seq = ++openSeq
  await autosave.flush()
  state.current = null
  state.noteLoading = true
  state.focusBody = focus
  try {
    const note = await api.value.getNote(noteId)
    if (note && seq === openSeq) {
      state.current = { ...note, content: note.content ?? '' }
    }
  } catch {
    notify({ type: 'negative', message: t('notes.loadFailed') })
  } finally {
    state.noteLoading = false
  }
}

async function selectSection(sectionId, { openFirst = true } = {}) {
  if (!sectionId) {
    return
  }
  await autosave.flush()
  openSeq += 1
  state.activeSectionId = sectionId
  state.current = null
  state.notes = []
  writeLastSection(sectionId)
  try {
    await loadNotes(sectionId)
  } catch {
    notify({ type: 'negative', message: t('notes.loadFailed') })
    return
  }
  if (openFirst && state.notes.length > 0 && state.activeSectionId === sectionId) {
    await openNote(state.notes[0].id)
  }
}

async function addSection() {
  try {
    const section = await api.value.createSection({ title: t('notes.newSectionTitle') })
    state.sections.push(section)
    await selectSection(section.id, { openFirst: false })
    await nextTick()
    sectionTabs.value?.startRename(section)
  } catch {
    notify({ type: 'negative', message: t('notes.createFailed') })
  }
}

async function addNote() {
  if (!state.activeSectionId) {
    return
  }
  const sectionId = state.activeSectionId
  try {
    await autosave.flush()
    const note = await api.value.createNote({ sectionId })
    if (state.activeSectionId !== sectionId) {
      return
    }
    state.notes.push({ ...note })
    openSeq += 1
    state.focusBody = true
    state.current = { ...note, title: note.title ?? null, content: note.content ?? '' }
  } catch {
    notify({ type: 'negative', message: t('notes.createFailed') })
  }
}

async function createQuickNote() {
  try {
    let sectionId = state.sections.some((s) => s.id === state.activeSectionId)
      ? state.activeSectionId
      : (state.sections[0]?.id ?? null)
    if (!sectionId) {
      const section = await api.value.createSection({ title: t('notes.defaultSectionTitle') })
      state.sections.push(section)
      sectionId = section.id
    }
    if (sectionId !== state.activeSectionId) {
      await selectSection(sectionId, { openFirst: false })
    }
    await addNote()
  } catch {
    notify({ type: 'negative', message: t('notes.createFailed') })
  }
}

async function renameSection({ section, title }) {
  const previous = section.title
  section.title = title
  try {
    await api.value.updateSection(section.id, { title })
  } catch {
    section.title = previous
    notify({ type: 'negative', message: t('notes.saveFailed') })
  }
}

function deleteSection(section) {
  confirm({
    title: t('notes.deleteSectionTitle'),
    message: t('notes.deleteSectionConfirm', {
      title: section.title?.trim() || t('notes.untitledSection')
    }),
    destructive: true,
    persistent: true
  }).onOk(async () => {
    try {
      if (state.activeSectionId === section.id) {
        for (const note of state.notes) {
          autosave.cancel(note.id)
        }
      }
      await api.value.deleteSection(section.id)
      state.sections = state.sections.filter((s) => s.id !== section.id)
      if (state.activeSectionId === section.id) {
        state.activeSectionId = null
        state.current = null
        state.notes = []
        if (state.sections.length > 0) {
          await selectSection(state.sections[0].id)
        }
      }
    } catch {
      notify({ type: 'negative', message: t('notes.deleteFailed') })
    }
  })
}

async function reorderSections(ids) {
  const byId = new Map(state.sections.map((s) => [s.id, s]))
  state.sections = ids.map((id) => byId.get(id)).filter(Boolean)
  try {
    await api.value.reorderSections(ids)
  } catch {
    notify({ type: 'negative', message: t('notes.reorderFailed') })
    await loadSections().catch(() => {})
  }
}

function onTitleInput(value) {
  if (!state.current) {
    return
  }
  const title = value.trim() ? value : null
  state.current.title = title
  const entry = listEntry(state.current.id)
  if (entry) {
    entry.title = title
  }
  autosave.schedule(state.current.id, { title })
}

function onContentInput(content) {
  if (!state.current) {
    return
  }
  state.current.content = content
  const entry = listEntry(state.current.id)
  if (entry) {
    entry.excerpt = noteExcerpt(content)
  }
  autosave.schedule(state.current.id, { content })
}

async function renameNote({ note, title }) {
  note.title = title
  if (state.current?.id === note.id) {
    state.current.title = title
  }
  autosave.schedule(note.id, { title })
  await autosave.flush(note.id)
}

function deleteNote(note) {
  confirm({
    title: t('notes.deleteNoteTitle'),
    message: t('notes.deleteNoteConfirm', {
      title: note.title?.trim() || note.excerpt?.trim() || t('notes.untitledNote')
    }),
    destructive: true,
    persistent: true
  }).onOk(async () => {
    autosave.cancel(note.id)
    try {
      await api.value.deleteNote(note.id)
    } catch {
      notify({ type: 'negative', message: t('notes.deleteFailed') })
      return
    }
    const index = state.notes.findIndex((n) => n.id === note.id)
    state.notes = state.notes.filter((n) => n.id !== note.id)
    if (state.current?.id === note.id) {
      state.current = null
      const next = state.notes[Math.min(index, state.notes.length - 1)]
      if (next) {
        await openNote(next.id)
      }
    }
  })
}

async function reorderNotes(ids) {
  const sectionId = state.activeSectionId
  const byId = new Map(state.notes.map((n) => [n.id, n]))
  const kept = ids.filter((id) => byId.has(id))
  state.notes = kept.map((id) => byId.get(id))
  try {
    await api.value.reorderNotes(sectionId, kept)
  } catch {
    notify({ type: 'negative', message: t('notes.reorderFailed') })
    await loadNotes(sectionId).catch(() => {})
  }
}

async function moveNote({ noteId, sectionId }) {
  if (!sectionId || sectionId === state.activeSectionId || !listEntry(noteId)) {
    return
  }
  const fromSectionId = state.activeSectionId
  state.notes = state.notes.filter((n) => n.id !== noteId)
  try {
    await autosave.flush(noteId)
    await api.value.updateNote(noteId, { sectionId })
  } catch {
    notify({ type: 'negative', message: t('notes.moveFailed') })
    if (state.activeSectionId === fromSectionId) {
      await loadNotes(fromSectionId).catch(() => {})
    }
    return
  }
  if (state.current?.id === noteId) {
    state.current = null
    if (state.notes.length > 0) {
      await openNote(state.notes[0].id)
    }
  }
  notify({
    type: 'positive',
    message: t('notes.moved', {
      section:
        state.sections.find((s) => s.id === sectionId)?.title?.trim() || t('notes.untitledSection')
    })
  })
}

function moveNoteFromList({ note, sectionId }) {
  return moveNote({ noteId: note.id, sectionId })
}

async function uploadFile(file) {
  const noteId = state.current?.id
  if (!noteId) {
    return null
  }
  if (!file.type?.startsWith('image/')) {
    notify({ type: 'warning', message: t('notes.imagesOnly') })
    return null
  }
  try {
    const uploaded = await api.value.uploadImage(noteId, file)
    return uploaded?.url ? { url: uploaded.url, name: file.name } : null
  } catch {
    notify({ type: 'negative', message: t('notes.imageUploadFailed') })
    return null
  }
}

async function flushBeforePromote(note) {
  await autosave.flush(note.id)
  if (autosave.hasPending(note.id)) {
    throw new Error(t('notes.saveFailed'))
  }
}

async function promoteCurrent() {
  const note = state.current
  if (!note || state.promoting) {
    return
  }
  state.promoting = true
  try {
    const result = await promote(note)
    if (result) {
      autosave.cancel(note.id)
      state.notes = state.notes.filter((n) => n.id !== note.id)
      if (state.current?.id === note.id) {
        state.current = null
      }
    }
  } finally {
    state.promoting = false
  }
}

async function consumeNewQuery() {
  if (route.query.new !== '1') {
    return
  }
  const { new: _new, ...query } = route.query
  await router.replace({ query })
  await createQuickNote()
}

async function load() {
  if (!userStore.authenticated || !notesEnabled.value || !siteStore.id) {
    return
  }
  try {
    await loadSections()
  } catch {
    notify({ type: 'negative', message: t('notes.loadFailed') })
    return
  }
  const remembered = readLastSection()
  const initial = state.sections.some((s) => s.id === remembered)
    ? remembered
    : (state.sections[0]?.id ?? null)
  const wantsNew = route.query.new === '1'
  if (initial) {
    await selectSection(initial, { openFirst: !wantsNew })
  }
  state.loaded = true
  await consumeNewQuery()
}

watch(
  () => route.query.new,
  (value) => {
    if (value === '1' && state.loaded) {
      consumeNewQuery()
    }
  }
)

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    autosave.flush()
  }
}

function onBeforeUnload(event) {
  if (autosave.hasPending()) {
    autosave.flush()
    event.preventDefault()
  }
}

onBeforeRouteLeave(async () => {
  await autosave.flush()
})

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('beforeunload', onBeforeUnload)
  load()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('beforeunload', onBeforeUnload)
  autosave.flush()
  autosave.dispose()
})

defineExpose({ state, autosave })
</script>

<style>
.notes-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.notes-page-top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-grey-4);
}
.body--dark .notes-page-top {
  border-bottom-color: var(--color-dark-1);
}
.notes-save-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 6rem;
  justify-content: flex-end;
  font-size: 12px;
  opacity: 0.7;
  white-space: nowrap;
}
.notes-save-indicator--error {
  color: var(--color-negative);
  opacity: 1;
}
.notes-page-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}
.notes-page-sidebar {
  flex: 0 0 260px;
  overflow-y: auto;
  border-inline-end: 1px solid var(--color-grey-4);
}
.body--dark .notes-page-sidebar {
  border-inline-end-color: var(--color-dark-1);
}
.notes-page-editor {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
}
.notes-page-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px 0;
}
.notes-page-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 1.4rem;
}
.notes-page-promote {
  flex: 0 0 auto;
}
.notes-page-wysiwyg {
  flex: 1 1 auto;
}
.notes-page-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 16px;
  text-align: center;
  opacity: 0.85;
}
@media (max-width: 599px) {
  .notes-page-body {
    flex-direction: column;
  }
  .notes-page-sidebar {
    flex: 0 0 auto;
    max-height: 35vh;
    border-inline-end: none;
    border-bottom: 1px solid var(--color-grey-4);
  }
}
</style>
