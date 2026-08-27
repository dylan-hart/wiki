export async function task(): Promise<void> {
  if (WIKI.config.offline) {
    WIKI.logger.info('Skipping version check: this instance is in offline mode.')
    return
  }

  WIKI.logger.info('Checking for latest version...')

  try {
    const versionResp = await fetch('https://api.github.com/repos/requarks/wiki/releases/latest', {
      signal: AbortSignal.timeout(15_000)
    })
    if (!versionResp.ok) {
      throw new Error(
        `Checking for latest version failed: ${versionResp.status} ${versionResp.statusText}`
      )
    }
    const resp = (await versionResp.json()) as { tag_name: string; published_at: string }
    const strictVersion =
      resp.tag_name.indexOf('v') === 0 ? resp.tag_name.substring(1) : resp.tag_name
    WIKI.logger.info(`Latest version is ${resp.tag_name}.`)
    WIKI.config.update = {
      lastCheckedAt: new Date().toISOString(),
      version: strictVersion,
      versionDate: resp.published_at
    }
    await WIKI.configSvc.saveToDb(['update'])

    WIKI.logger.info('Checked for latest version: [ COMPLETED ]')
  } catch (err: any) {
    WIKI.logger.error('Checking for latest version: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
