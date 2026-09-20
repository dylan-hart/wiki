# WP #3623 comment suggestions

## `backend/models/mail.ts`, `MailKind` doc comment

The comment says the union is "one member per `send*` wrapper below, plus `approval` for the one
template composed outside this file". `commentMention` is now a second member composed outside this
file (`models/commentNotifications.ts`).

Suggested replacement for that sentence: "one member per `send*` wrapper below, plus `approval` and
`commentMention` for the templates composed outside this file (`models/approvalNotifications.ts`,
`models/commentNotifications.ts`)."

## `backend/models/mail.test.ts`, "every MailKind but approval is covered by a wrapper above"

The test title and its inner comment say only `approval` has no wrapper; the `Record` type now also
excludes `commentMention`. Suggested title: "every MailKind composed inside this model is covered by
a wrapper above", with the comment naming both exclusions.

## `backend/models/commentNotifications.ts`

Added without comments, per the task. Two whys a reader could not re-derive from the code, if wanted:

- A mentioned user already subscribed to `comment:new` (on create) or `comment:edit` (on edit) is
  skipped because `Hooks.emit()` already mails them for that same comment.
- `read:pages` is checked as well as `read:comments` because the mail names the page, so a reader who
  may see comments but not the page must not learn its title from it.
