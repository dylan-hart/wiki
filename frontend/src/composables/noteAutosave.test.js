import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createNoteAutosave } from './noteAutosave'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createNoteAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces edits into one save carrying the latest content', async () => {
    const save = vi.fn(async () => ({}))
    const autosave = createNoteAutosave({ save, delay: 500 })

    autosave.schedule('n1', { content: 'a' })
    await vi.advanceTimersByTimeAsync(300)
    autosave.schedule('n1', { content: 'ab' })
    await vi.advanceTimersByTimeAsync(300)
    expect(save).not.toHaveBeenCalled()
    expect(autosave.state.status).toBe('pending')

    await vi.advanceTimersByTimeAsync(300)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('n1', { content: 'ab' })
    expect(autosave.state.status).toBe('saved')
  })

  it('merges a title and a content edit into one patch', async () => {
    const save = vi.fn(async () => ({}))
    const autosave = createNoteAutosave({ save, delay: 100 })
    autosave.schedule('n1', { title: 'T' })
    autosave.schedule('n1', { content: 'body' })
    await vi.advanceTimersByTimeAsync(150)
    expect(save).toHaveBeenCalledWith('n1', { title: 'T', content: 'body' })
  })

  it('keeps at most one save in flight per note, and the latest content wins', async () => {
    const first = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({})
    const autosave = createNoteAutosave({ save, delay: 100 })

    autosave.schedule('n1', { content: 'one' })
    await vi.advanceTimersByTimeAsync(150)
    expect(save).toHaveBeenCalledTimes(1)
    expect(autosave.state.status).toBe('saving')

    autosave.schedule('n1', { content: 'two' })
    await vi.advanceTimersByTimeAsync(150)
    autosave.schedule('n1', { content: 'three' })
    await vi.advanceTimersByTimeAsync(150)
    expect(save).toHaveBeenCalledTimes(1)

    first.resolve({})
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)

    // -> The first save went out at 100ms; the next waits out the 3s minimum interval.
    await vi.advanceTimersByTimeAsync(2650)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('n1', { content: 'three' })
    expect(autosave.state.status).toBe('saved')
  })

  it('spaces saves of one note at least minInterval apart, however the pauses fall', async () => {
    const save = vi.fn(async () => ({}))
    const autosave = createNoteAutosave({ save, delay: 800, minInterval: 3000 })
    const sentAt = []
    save.mockImplementation(async () => {
      sentAt.push(Date.now())
      return {}
    })
    const start = Date.now()

    // -> A steady typist pausing just past the debounce, for 20 seconds.
    for (let i = 0; i < 20; i++) {
      autosave.schedule('n1', { content: `edit ${i}` })
      await vi.advanceTimersByTimeAsync(1000)
    }
    await vi.advanceTimersByTimeAsync(5000)

    expect(sentAt.length).toBeGreaterThan(1)
    expect(sentAt.length).toBeLessThanOrEqual(8)
    for (let i = 1; i < sentAt.length; i++) {
      expect(sentAt[i] - sentAt[i - 1]).toBeGreaterThanOrEqual(3000)
    }
    expect(save).toHaveBeenLastCalledWith('n1', { content: 'edit 19' })
    expect(autosave.hasPending()).toBe(false)
    expect(sentAt[0] - start).toBe(800)
  })

  it('keeps the interval per note, so another note saves on its own debounce', async () => {
    const save = vi.fn(async () => ({}))
    const autosave = createNoteAutosave({ save, delay: 800, minInterval: 3000 })

    autosave.schedule('n1', { content: 'a' })
    await vi.advanceTimersByTimeAsync(800)
    autosave.schedule('n2', { content: 'b' })
    await vi.advanceTimersByTimeAsync(800)

    expect(save.mock.calls.map(([id]) => id)).toEqual(['n1', 'n2'])
  })

  it('flush sends at once even inside the minimum interval', async () => {
    const save = vi.fn(async () => ({}))
    const autosave = createNoteAutosave({ save, delay: 100, minInterval: 3000 })

    autosave.schedule('n1', { content: 'a' })
    await vi.advanceTimersByTimeAsync(100)
    autosave.schedule('n1', { content: 'ab' })
    await autosave.flush('n1')

    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('n1', { content: 'ab' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('flush saves immediately without waiting for the debounce', async () => {
    const save = vi.fn(async () => ({}))
    const autosave = createNoteAutosave({ save, delay: 10_000 })
    autosave.schedule('n1', { content: 'x' })
    autosave.schedule('n2', { content: 'y' })
    await autosave.flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(autosave.hasPending()).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('flush of one note leaves the others on their timer', async () => {
    const save = vi.fn(async () => ({}))
    const autosave = createNoteAutosave({ save, delay: 1000 })
    autosave.schedule('n1', { content: 'x' })
    autosave.schedule('n2', { content: 'y' })
    await autosave.flush('n1')
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('n1', { content: 'x' })
    await vi.advanceTimersByTimeAsync(1100)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('flush waits for a save already in flight and then sends what came after it', async () => {
    const first = deferred()
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({})
    const autosave = createNoteAutosave({ save, delay: 100 })
    autosave.schedule('n1', { content: 'one' })
    await vi.advanceTimersByTimeAsync(150)
    autosave.schedule('n1', { content: 'two' })

    const flushed = autosave.flush('n1')
    first.resolve({})
    await flushed
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith('n1', { content: 'two' })
  })

  it('keeps a failed patch for the next attempt and reports the error', async () => {
    const onError = vi.fn()
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({})
    const autosave = createNoteAutosave({ save, delay: 100, onError })

    autosave.schedule('n1', { content: 'draft' })
    await vi.advanceTimersByTimeAsync(150)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(autosave.state.status).toBe('error')
    expect(autosave.hasPending()).toBe(true)

    await autosave.flush()
    expect(save).toHaveBeenLastCalledWith('n1', { content: 'draft' })
    expect(autosave.state.status).toBe('saved')
  })

  it('answers hasPending for one note without counting the others', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({})
    const autosave = createNoteAutosave({ save, delay: 100 })

    autosave.schedule('n1', { content: 'stuck' })
    await vi.advanceTimersByTimeAsync(150)
    autosave.schedule('n2', { content: 'queued' })

    expect(autosave.hasPending('n1')).toBe(true)
    expect(autosave.hasPending('n2')).toBe(true)
    expect(autosave.hasPending('n3')).toBe(false)

    await autosave.flush('n2')
    expect(autosave.hasPending('n2')).toBe(false)
    expect(autosave.hasPending('n1')).toBe(true)
    expect(autosave.hasPending()).toBe(true)
  })

  it('cancel drops a note that is about to be deleted', async () => {
    const save = vi.fn(async () => ({}))
    const autosave = createNoteAutosave({ save, delay: 100 })
    autosave.schedule('n1', { content: 'gone' })
    autosave.cancel('n1')
    await vi.advanceTimersByTimeAsync(200)
    expect(save).not.toHaveBeenCalled()
    expect(autosave.state.status).toBe('idle')
  })
})
