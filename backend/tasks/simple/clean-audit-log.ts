export async function task(): Promise<void> {
  const purged = await WIKI.models.auditLog.purge(WIKI.models.auditLog.getRetentionDays())
  if (purged > 0) {
    WIKI.logger.info('audit', 'purged audit log entries past the retention window', { purged })
  }
}
