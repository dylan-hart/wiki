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
    // -> Spread over the existing object, not replaced: `update` also holds `locales` (an operator's
    //    opt-out of the daily `updateLocales` sync, `base.yml`'s `update.locales`), which a bare
    //    assignment here silently discarded on every run after the first, re-enabling locale syncing
    //    for an egress-restricted deployment regardless of what the admin area shows.
    WIKI.config.update = {
      ...WIKI.config.update,
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
