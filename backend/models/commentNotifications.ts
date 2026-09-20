import { and, eq, inArray, sql } from 'drizzle-orm'
import { MAX_MENTION_CANDIDATES } from '../helpers/mentions.ts'
import { localizedPagePath } from '../helpers/localeRouting.ts'
import { pages as pagesTable, users as usersTable } from '../db/schema.ts'
import { escapeHtml } from './mail.ts'
import type { Comment } from './comments.ts'

class CommentNotifications {
  async notifyMentions({
    comment,
    authorName,
    previousContent
  }: {
    comment: Pick<Comment, 'id' | 'siteId' | 'pageId' | 'authorId' | 'content'>
    authorName: string
    previousContent?: string
  }): Promise<void> {
    try {
      const isEdit = previousContent !== undefined
      const mentioned = await CARDINAL.models.comments.resolveMentions(
        comment.siteId,
        comment.content
      )
      if (isEdit) {
        const before = await CARDINAL.models.comments.resolveMentions(
          comment.siteId,
          previousContent
        )
        for (const key of before.keys()) {
          mentioned.delete(key)
        }
      }
      if (mentioned.size < 1) {
        return
      }

      const recipients = await this.loadRecipients([...mentioned.keys()], comment.authorId)
      if (recipients.length < 1) {
        return
      }

      const page = await this.loadPage(comment.pageId)
      if (!page) {
        return
      }

      const alreadyMailed = new Set(
        (
          await CARDINAL.models.users.listEmailSubscribers(isEdit ? 'comment:edit' : 'comment:new')
        ).map((subscriber) => subscriber.id)
      )

      for (const recipient of recipients) {
        if (alreadyMailed.has(recipient.id)) {
          continue
        }
        await this.sendMention(comment, authorName, page, recipient)
      }
    } catch (err: any) {
      CARDINAL.logger.warn('hooks', 'notifying the users a comment mentions failed', {
        comment: comment.id,
        error: err
      })
    }
  }

  private async loadRecipients(
    handles: string[],
    authorId: string | null
  ): Promise<Array<{ id: string; email: string; prefs: unknown }>> {
    const rows = await CARDINAL.db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        prefs: usersTable.prefs
      })
      .from(usersTable)
      .where(
        and(
          inArray(sql`lower(${usersTable.handle})`, handles),
          eq(usersTable.isActive, true),
          eq(usersTable.isVerified, true),
          eq(usersTable.isSystem, false)
        )
      )
      .limit(MAX_MENTION_CANDIDATES)
    return rows.filter((row: any) => row.id !== authorId && Boolean(row.email))
  }

  private async loadPage(pageId: string) {
    const rows = await CARDINAL.db
      .select({
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification,
        title: pagesTable.title
      })
      .from(pagesTable)
      .where(eq(pagesTable.id, pageId))
      .limit(1)
    return rows[0] ?? null
  }

  private async sendMention(
    comment: Pick<Comment, 'id' | 'siteId'>,
    authorName: string,
    page: {
      path: string
      locale: string
      tags: string[] | null
      classification: string | null
      title: string
    },
    recipient: { id: string; email: string; prefs: unknown }
  ): Promise<void> {
    try {
      const actor = await CARDINAL.models.groups.actorForUserId(recipient.id)
      const ref = {
        path: page.path,
        siteId: comment.siteId,
        locale: page.locale,
        tags: page.tags ?? [],
        classification: page.classification ?? null
      }
      if (
        !CARDINAL.models.groups.checkAccess(actor, 'read:pages', ref) ||
        !CARDINAL.models.groups.checkAccess(actor, 'read:comments', ref)
      ) {
        return
      }

      const locale = (recipient.prefs as { locale?: string } | null)?.locale
      const locales = CARDINAL.sites[comment.siteId]?.config?.locales
      const link = CARDINAL.models.mail.buildLink(
        localizedPagePath(page.path, page.locale, locales),
        CARDINAL.models.mail.resolveMailBaseURL(comment.siteId)
      )
      const site = CARDINAL.sites[comment.siteId]?.config?.title || 'Wiki'
      const author = authorName || 'Someone'
      const params = { author, title: page.title, site, link }
      await CARDINAL.models.mail.send({
        to: recipient.email,
        kind: 'commentMention',
        userId: recipient.id,
        subject: await CARDINAL.models.locales.resolveString(
          locale,
          'mail.commentMention.subject',
          params
        ),
        text: await CARDINAL.models.locales.resolveString(
          locale,
          'mail.commentMention.text',
          params
        ),
        html: await CARDINAL.models.locales.resolveString(locale, 'mail.commentMention.html', {
          ...params,
          author: escapeHtml(author),
          title: escapeHtml(page.title),
          site: escapeHtml(site)
        })
      })
    } catch (err: any) {
      CARDINAL.logger.warn('hooks', 'sending the comment mention notification failed', {
        comment: comment.id,
        recipient: recipient.id,
        error: err
      })
    }
  }
}

export const commentNotifications = new CommentNotifications()
