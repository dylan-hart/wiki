import { and, asc, eq, isNull, or } from 'drizzle-orm'
import sanitizeHtml from 'sanitize-html'
import { pageTemplates as pageTemplatesTable } from '../db/schema.ts'
import { CustomError, isUniqueViolation } from '../helpers/common.ts'
import { blockAllowances, sanitizeOptions } from '../helpers/htmlSanitizePolicy.ts'
import { assertLocaleActive } from '../helpers/localeRouting.ts'
import type { RenderPermissions } from '../helpers/htmlSanitizePolicy.ts'

export type PageTemplate = Omit<typeof pageTemplatesTable.$inferSelect, 'siteId'>

export const TEMPLATE_EDITORS = ['markdown', 'wysiwyg', 'code', 'asciidoc'] as const

export interface PageTemplateInput {
  name: string
  description?: string
  editor?: string
  locale?: string | null
  content?: string
}

export type PageTemplatePatch = Partial<PageTemplateInput>

const MASK = '\uE000'

const templateColumns = {
  id: pageTemplatesTable.id,
  locale: pageTemplatesTable.locale,
  name: pageTemplatesTable.name,
  description: pageTemplatesTable.description,
  editor: pageTemplatesTable.editor,
  content: pageTemplatesTable.content,
  createdBy: pageTemplatesTable.createdBy,
  createdAt: pageTemplatesTable.createdAt,
  updatedAt: pageTemplatesTable.updatedAt
}

function normalizeName(name: string | undefined): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) {
    throw new CustomError('pageTemplateEmptyName', 'A template name cannot be empty.', 400)
  }
  return trimmed
}

function normalizeEditor(editor: string | undefined): string {
  const value = editor ?? 'markdown'
  if (!(TEMPLATE_EDITORS as readonly string[]).includes(value)) {
    throw new CustomError(
      'pageTemplateInvalidEditor',
      `A template's editor must be one of ${TEMPLATE_EDITORS.join(', ')}.`,
      400
    )
  }
  return value
}

function normalizeLocale(siteId: string, locale: string | null | undefined): string | null {
  if (locale === undefined || locale === null || locale === '') {
    return null
  }
  assertLocaleActive(siteId, locale)
  return locale
}

function sanitizeSource(html: string, options: sanitizeHtml.IOptions): string {
  const masked = html.replaceAll('&', MASK)
  const cleaned = sanitizeHtml(masked, {
    ...options,
    textFilter: (text) => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>')
  })
  return cleaned.replaceAll(MASK, '&')
}

class PageTemplates {
  async list(siteId: string, locale?: string | null): Promise<PageTemplate[]> {
    const where = locale
      ? and(
          eq(pageTemplatesTable.siteId, siteId),
          or(isNull(pageTemplatesTable.locale), eq(pageTemplatesTable.locale, locale))
        )
      : eq(pageTemplatesTable.siteId, siteId)
    return CARDINAL.db
      .select(templateColumns)
      .from(pageTemplatesTable)
      .where(where)
      .orderBy(asc(pageTemplatesTable.name))
  }

  async get(siteId: string, templateId: string): Promise<PageTemplate | null> {
    const rows = await CARDINAL.db
      .select(templateColumns)
      .from(pageTemplatesTable)
      .where(and(eq(pageTemplatesTable.siteId, siteId), eq(pageTemplatesTable.id, templateId)))
      .limit(1)
    return rows[0] ?? null
  }

  async sanitizeContent(
    siteId: string,
    content: string,
    editor: string,
    permissions: RenderPermissions
  ): Promise<string> {
    const enabledBlocks = await CARDINAL.models.blocks.getEnabledKeys(siteId)
    const customBlocks = await CARDINAL.models.blocks.getCustomBlockDefinitions(siteId)
    const options = sanitizeOptions(
      permissions,
      blockAllowances(enabledBlocks, customBlocks),
      CARDINAL.sites?.[siteId]?.config?.allowedUrlSchemes
    )
    return editor === 'code' ? sanitizeHtml(content, options) : sanitizeSource(content, options)
  }

  async create(
    siteId: string,
    input: PageTemplateInput,
    authorId: string | null,
    permissions: RenderPermissions
  ): Promise<PageTemplate> {
    const name = normalizeName(input.name)
    const editor = normalizeEditor(input.editor)
    const locale = normalizeLocale(siteId, input.locale)
    const content = await this.sanitizeContent(siteId, input.content ?? '', editor, permissions)

    try {
      const rows = await CARDINAL.db
        .insert(pageTemplatesTable)
        .values({
          siteId,
          locale,
          name,
          description: (input.description ?? '').trim(),
          editor,
          content,
          createdBy: authorId
        })
        .returning(templateColumns)
      return rows[0]!
    } catch (err: any) {
      throw this.translateUnique(err)
    }
  }

  async update(
    siteId: string,
    templateId: string,
    patch: PageTemplatePatch,
    permissions: RenderPermissions
  ): Promise<PageTemplate> {
    const existing = await this.get(siteId, templateId)
    if (!existing) {
      throw new CustomError('pageTemplateNotFound', 'This template does not exist.', 404)
    }

    const values: Partial<typeof pageTemplatesTable.$inferInsert> = { updatedAt: new Date() }
    if (patch.name !== undefined) {
      values.name = normalizeName(patch.name)
    }
    if (patch.description !== undefined) {
      values.description = patch.description.trim()
    }
    if (patch.editor !== undefined) {
      values.editor = normalizeEditor(patch.editor)
    }
    if (patch.locale !== undefined) {
      values.locale = normalizeLocale(siteId, patch.locale)
    }
    const editor = values.editor ?? existing.editor
    if (patch.content !== undefined || (values.editor && values.editor !== existing.editor)) {
      values.content = await this.sanitizeContent(
        siteId,
        patch.content ?? existing.content,
        editor,
        permissions
      )
    }

    try {
      const rows = await CARDINAL.db
        .update(pageTemplatesTable)
        .set(values)
        .where(and(eq(pageTemplatesTable.siteId, siteId), eq(pageTemplatesTable.id, templateId)))
        .returning(templateColumns)
      if (!rows[0]) {
        throw new CustomError('pageTemplateNotFound', 'This template does not exist.', 404)
      }
      return rows[0]
    } catch (err: any) {
      throw this.translateUnique(err)
    }
  }

  async delete(siteId: string, templateId: string): Promise<void> {
    const rows = await CARDINAL.db
      .delete(pageTemplatesTable)
      .where(and(eq(pageTemplatesTable.siteId, siteId), eq(pageTemplatesTable.id, templateId)))
      .returning({ id: pageTemplatesTable.id })
    if (!rows[0]) {
      throw new CustomError('pageTemplateNotFound', 'This template does not exist.', 404)
    }
  }

  private translateUnique(err: any): unknown {
    if (isUniqueViolation(err)) {
      return new CustomError(
        'pageTemplateDuplicateName',
        'A template with this name already exists for this locale.',
        409
      )
    }
    return err
  }
}

export const pageTemplates = new PageTemplates()
