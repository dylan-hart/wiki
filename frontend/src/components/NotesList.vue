<template>
  <div class="notes-list flex flex-col">
    <div class="notes-list-header flex items-center justify-between gap-2 px-3 py-2">
      <span class="text-caption font-semibold uppercase">{{ t('notes.notes') }}</span>
      <w-btn
        flat
        round
        dense
        icon="la:plus"
        class="notes-list-add"
        :disabled="!canAdd"
        :aria-label="t('notes.addNote')"
        @click="emit('add')">
        <w-tooltip>{{ t('notes.addNote') }}</w-tooltip>
      </w-btn>
    </div>
    <div v-if="loading && notes.length < 1" class="notes-list-loading px-3 py-2 text-caption">
      <em>{{ t('notes.loading') }}</em>
    </div>
    <div v-else-if="notes.length < 1" class="notes-list-empty px-3 py-2 text-caption">
      <em>{{ t('notes.emptySection') }}</em>
    </div>
    <w-sortable
      tag="ul"
      class="notes-list-items"
      :list="notes"
      item-key="id"
      :options="sortableOptions"
      @update="onReorder">
      <template #item="{ element }">
        <li
          class="notes-list-item"
          :class="{ 'notes-list-item--active': element.id === modelValue }"
          :data-note-id="element.id">
          <w-input
            v-if="renamingId === element.id"
            v-model="renameValue"
            dense
            autofocus
            hide-bottom-space
            class="notes-list-rename"
            :aria-label="t('notes.noteTitle')"
            @keyup:enter="commitRename"
            @keydown.esc="cancelRename"
            @blur="commitRename" />
          <button
            v-else
            type="button"
            class="notes-list-select w-unstyled"
            :aria-current="element.id === modelValue ? 'true' : undefined"
            @click="emit('update:modelValue', element.id)">
            <span
              class="notes-list-label"
              :class="{ 'notes-list-label--excerpt': !element.title?.trim() }">
              {{ noteLabel(element) }}
            </span>
          </button>
          <w-btn
            flat
            round
            dense
            size="sm"
            icon="tabler:dots-vertical"
            class="notes-list-more"
            :aria-label="t('notes.noteActions')">
            <w-menu auto-close anchor="bottom right" self="top right">
              <w-list dense padding>
                <w-item clickable class="notes-list-rename-action" @click="startRename(element)">
                  <w-item-section side><w-icon name="tabler:pencil" /></w-item-section>
                  <w-item-section>
                    <w-item-label>{{ t('notes.renameNote') }}</w-item-label>
                  </w-item-section>
                </w-item>
                <w-item
                  v-for="section of otherSections"
                  :key="section.id"
                  clickable
                  class="notes-list-move-action"
                  :data-target-section-id="section.id"
                  @click="emit('move', { note: element, sectionId: section.id })">
                  <w-item-section side><w-icon name="tabler:folder-share" /></w-item-section>
                  <w-item-section>
                    <w-item-label>{{
                      t('notes.moveToSection', { section: sectionTitle(section) })
                    }}</w-item-label>
                  </w-item-section>
                </w-item>
                <w-item clickable class="notes-list-delete-action" @click="emit('delete', element)">
                  <w-item-section side><w-icon name="la:trash" color="negative" /></w-item-section>
                  <w-item-section>
                    <w-item-label>{{ t('notes.deleteNote') }}</w-item-label>
                  </w-item-section>
                </w-item>
              </w-list>
            </w-menu>
          </w-btn>
        </li>
      </template>
    </w-sortable>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { setNoteDragData } from '@/helpers/noteDrag'

const props = defineProps({
  notes: {
    type: Array,
    required: true
  },
  modelValue: {
    type: String,
    default: null
  },
  sections: {
    type: Array,
    default: () => []
  },
  sectionId: {
    type: String,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['update:modelValue', 'add', 'rename', 'delete', 'reorder', 'move'])

const { t } = useI18n()

const renamingId = ref(null)
const renameValue = ref('')

const sortableOptions = {
  group: 'notes-list',
  animation: 150,
  filter: '.notes-list-rename',
  preventOnFilter: false,
  setData: setNoteDragData
}

const canAdd = computed(() => Boolean(props.sectionId))

const otherSections = computed(() =>
  props.sections.filter((section) => section.id !== props.sectionId)
)

function noteLabel(note) {
  return note.title?.trim() || note.excerpt?.trim() || t('notes.untitledNote')
}

function sectionTitle(section) {
  return section.title?.trim() || t('notes.untitledSection')
}

function startRename(note) {
  renamingId.value = note.id
  renameValue.value = note.title ?? ''
}

function commitRename() {
  const noteId = renamingId.value
  if (!noteId) {
    return
  }
  renamingId.value = null
  const note = props.notes.find((n) => n.id === noteId)
  const title = renameValue.value.trim() || null
  if (note && title !== (note.title?.trim() || null)) {
    emit('rename', { note, title })
  }
}

function cancelRename() {
  renamingId.value = null
}

function onReorder(event) {
  const ids = props.notes.map((note) => note.id)
  ids.splice(event.newIndex, 0, ...ids.splice(event.oldIndex, 1))
  emit('reorder', ids)
}
</script>

<style>
.notes-list-items {
  list-style: none;
  margin: 0;
  padding: 0;
}
.notes-list-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-inline: 8px 4px;
  border-inline-start: 3px solid transparent;
  cursor: grab;
}
.notes-list-item:hover {
  background-color: rgba(0, 0, 0, 0.04);
}
.body--dark .notes-list-item:hover {
  background-color: rgba(255, 255, 255, 0.05);
}
.notes-list-item--active {
  border-inline-start-color: var(--color-primary);
  background-color: rgba(0, 0, 0, 0.06);
}
.body--dark .notes-list-item--active {
  background-color: rgba(255, 255, 255, 0.08);
}
.notes-list-select {
  flex: 1 1 auto;
  min-width: 0;
  padding-block: 8px;
  text-align: start;
  cursor: pointer;
}
.notes-list-label {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.notes-list-label--excerpt {
  opacity: 0.7;
}
.notes-list-rename {
  flex: 1 1 auto;
}
</style>
