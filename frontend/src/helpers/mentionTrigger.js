const MENTION_CHAR = /[A-Za-z0-9._-]/

export const MENTION_QUERY_MAX_LENGTH = 32

export function findMentionTrigger(text, caret) {
  let start = caret
  while (start > 0 && MENTION_CHAR.test(text[start - 1])) {
    start -= 1
  }
  if (start === 0 || text[start - 1] !== '@') {
    return null
  }
  const at = start - 1
  if (at > 0 && MENTION_CHAR.test(text[at - 1])) {
    return null
  }
  const query = text.slice(start, caret)
  if (query.length < 1 || query.length > MENTION_QUERY_MAX_LENGTH) {
    return null
  }
  let end = caret
  while (end < text.length && MENTION_CHAR.test(text[end])) {
    end += 1
  }
  return { start: at, end, query }
}
