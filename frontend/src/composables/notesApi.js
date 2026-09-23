function unwrapList(res, key) {
  if (Array.isArray(res)) {
    return res
  }
  return Array.isArray(res?.[key]) ? res[key] : []
}

function unwrapRow(res, key) {
  return res?.[key] ?? res
}

export function notesApi(siteId) {
  const base = `sites/${siteId}/notes`

  return {
    async listSections() {
      return unwrapList(await API_CLIENT.get(`${base}/sections`).json(), 'sections')
    },
    async createSection({ title }) {
      return unwrapRow(
        await API_CLIENT.post(`${base}/sections`, { json: { title } }).json(),
        'section'
      )
    },
    async updateSection(sectionId, { title }) {
      return API_CLIENT.put(`${base}/sections/${sectionId}`, { json: { title } }).json()
    },
    async deleteSection(sectionId) {
      return API_CLIENT.delete(`${base}/sections/${sectionId}`).json()
    },
    async reorderSections(ids) {
      return API_CLIENT.put(`${base}/sections/order`, { json: { ids } }).json()
    },

    async listNotes(sectionId) {
      return unwrapList(await API_CLIENT.get(base, { searchParams: { sectionId } }).json(), 'notes')
    },
    async getNote(noteId) {
      return unwrapRow(await API_CLIENT.get(`${base}/${noteId}`).json(), 'note')
    },
    async createNote({ sectionId, title, content }) {
      return unwrapRow(
        await API_CLIENT.post(base, { json: { sectionId, title, content } }).json(),
        'note'
      )
    },
    async updateNote(noteId, patch) {
      return API_CLIENT.put(`${base}/${noteId}`, { json: patch }).json()
    },
    async deleteNote(noteId) {
      return API_CLIENT.delete(`${base}/${noteId}`).json()
    },
    async reorderNotes(sectionId, ids) {
      return API_CLIENT.put(`${base}/order`, { json: { sectionId, ids } }).json()
    },

    async uploadImage(noteId, file) {
      const body = new FormData()
      body.append('file', file, file.name)
      return API_CLIENT.post(`${base}/${noteId}/images`, { body }).json()
    }
  }
}
