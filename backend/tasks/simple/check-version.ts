import semver from 'semver'

export async function task(): Promise<void> {
  if (WIKI.config.offline) {
    // -> `debug`: this runs daily and says the same thing every time on a deployment that is
    //    deliberately offline.
    WIKI.logger.debug('boot', 'skipping version check, offline mode')
    return
  }

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

  // -> Silent when this instance is already current (audit X11): the daily "still up to date" line
  //    was pure heartbeat. Only an actual newer release is a state change an operator wants told.
  //    The failure path is not logged here either — it propagates, and the scheduler writes the one
  //    record for it.
  const current = WIKI.version
  if (semver.valid(strictVersion) && semver.valid(current) && semver.gt(strictVersion, current)) {
    WIKI.logger.info('boot', 'update available', { current, latest: strictVersion })
  }
}
