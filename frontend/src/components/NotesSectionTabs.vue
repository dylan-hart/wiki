<template>
  <div class="notes-section-tabs flex items-center gap-2">
    <w-tabs
      class="min-w-0 flex-1"
      :model-value="modelValue"
      no-caps
      inline-label
      @update:model-value="select">
      <w-sortable
        class="flex flex-nowrap items-stretch gap-1"
        :list="sections"
        item-key="id"
        :options="sortableOptions"
        @update="onReorder">
        <template #item="{ element }">
          <div
            v-if="renamingId === element.id"
            class="notes-section-rename flex items-center"
            :data-section-id="element.id">
            <w-input
              v-model="renameValue"
              dense
              autofocus
              hide-bottom-space
              :aria-label="t('notes.sectionTitle')"
              @keyup:enter="commitRename"
              @keydown.esc="cancelRename"
              @blur="commitRename" />
          </div>
          <w-tab
            v-else
            :name="element.id"
            :label="sectionLabel(element)"
            class="notes-section-tab"
            :class="{ 'notes-section-tab--drop': dropTargetId === element.id }"
            :data-section-id="element.id"
            @dblclick="startRename(element)"
            @dragover="onDragOver($event, element)"
            @dragleave="onDragLeave(element)"
            @drop="onDrop($event, element)">
            <w-menu context-menu auto-close>
              <w-list dense padding>
                <w-item clickable @click="startRename(element)">
                  <w-item-section side><w-icon name="tabler:pencil" /></w-item-section>
                  <w-item-section>
                    <w-item-label>{{ t('notes.renameSection') }}</w-item-label>
                  </w-item-section>
                </w-item>
                <w-item clickable @click="emit('delete', element)">
                  <w-item-section side><w-icon name="la:trash" color="negative" /></w-item-section>
                  <w-item-section>
                    <w-item-label>{{ t('notes.deleteSection') }}</w-item-label>
                  </w-item-section>
                </w-item>
              </w-list>
            </w-menu>
          </w-tab>
        </template>
      </w-sortable>
    </w-tabs>
    <w-btn
      flat
      round
      dense
      icon="la:plus"
      class="notes-section-add"
      :aria-label="t('notes.addSection')"
      @click="emit('add')">
      <w-tooltip>{{ t('notes.addSection') }}</w-tooltip>
    </w-btn>
    <w-btn
      v-if="activeSection"
      flat
      round
      dense
      icon="tabler:dots-vertical"
      class="notes-section-more"
      :aria-label="t('notes.sectionActions')">
      <w-menu auto-close anchor="bottom right" self="top right">
        <w-list dense padding>
          <w-item clickable class="notes-section-more-rename" @click="startRename(activeSection)">
            <w-item-section side><w-icon name="tabler:pencil" /></w-item-section>
            <w-item-section>
              <w-item-label>{{ t('notes.renameSection') }}</w-item-label>
            </w-item-section>
          </w-item>
          <w-item
            clickable
            class="notes-section-more-delete"
            @click="emit('delete', activeSection)">
            <w-item-section side><w-icon name="la:trash" color="negative" /></w-item-section>
            <w-item-section>
              <w-item-label>{{ t('notes.deleteSection') }}</w-item-label>
            </w-item-section>
          </w-item>
        </w-list>
      </w-menu>
    </w-btn>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { NOTE_DRAG_TYPE } from '@/helpers/noteDrag'

const props = defineProps({
  sections: {
    type: Array,
    required: true
  },
  modelValue: {
    type: String,
    default: null
  }
})

const emit = defineEmits(['update:modelValue', 'add', 'rename', 'delete', 'reorder', 'move-note'])

const { t } = useI18n()

const renamingId = ref(null)
const renameValue = ref('')
const dropTargetId = ref(null)

const sortableOptions = {
  group: 'notes-sections',
  animation: 150,
  filter: '.notes-section-rename',
  preventOnFilter: false
}

const activeSection = computed(
  () => props.sections.find((section) => section.id === props.modelValue) ?? null
)

function sectionLabel(section) {
  return section.title?.trim() || t('notes.untitledSection')
}

function select(sectionId) {
  if (sectionId !== props.modelValue) {
    emit('update:modelValue', sectionId)
  }
}

function startRename(section) {
  renamingId.value = section.id
  renameValue.value = section.title ?? ''
}

function commitRename() {
  const sectionId = renamingId.value
  if (!sectionId) {
    return
  }
  renamingId.value = null
  const section = props.sections.find((s) => s.id === sectionId)
  const title = renameValue.value.trim()
  if (section && title && title !== section.title) {
    emit('rename', { section, title })
  }
}

function cancelRename() {
  renamingId.value = null
}

function onReorder(event) {
  const ids = props.sections.map((section) => section.id)
  ids.splice(event.newIndex, 0, ...ids.splice(event.oldIndex, 1))
  emit('reorder', ids)
}

function carriesNote(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes(NOTE_DRAG_TYPE)
}

function onDragOver(event, section) {
  if (!carriesNote(event)) {
    return
  }
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  dropTargetId.value = section.id
}

function onDragLeave(section) {
  if (dropTargetId.value === section.id) {
    dropTargetId.value = null
  }
}

function onDrop(event, section) {
  if (!carriesNote(event)) {
    return
  }
  event.preventDefault()
  dropTargetId.value = null
  const noteId = event.dataTransfer.getData(NOTE_DRAG_TYPE)
  if (noteId) {
    emit('move-note', { noteId, sectionId: section.id })
  }
}

defineExpose({ startRename })
</script>

<style>
.notes-section-tab--drop {
  outline: 2px dashed var(--color-primary);
  outline-offset: -2px;
}
</style>
