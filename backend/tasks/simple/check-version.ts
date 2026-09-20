import semver from 'semver'

export async function task(): Promise<void> {
  if (CARDINAL.config.offline) {
    // -> `debug`: this runs daily and says the same thing every time on a deployment that is
    //    deliberately offline.
    CARDINAL.logger.debug('boot', 'skipping version check, offline mode')
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
  // -> Spread, not replaced: `update` also holds `locales` (an operator's opt-out of the daily
  //    `updateLocales` sync, `base.yml`'s `update.locales`), which a bare assignment would discard,
  //    re-enabling locale syncing on an egress-restricted deployment regardless of what admin shows.
  CARDINAL.config.update = {
    ...CARDINAL.config.update,
    lastCheckedAt: new Date().toISOString(),
    version: strictVersion,
    versionDate: resp.published_at
  }
  await CARDINAL.configSvc.saveToDb(['update'])

  // -> Silent when already current: a daily "still up to date" is heartbeat, only a newer release is
  //    a state change. The failure path propagates instead of logging, so the scheduler writes the
  //    one record for it.
  const current = CARDINAL.version
  if (semver.valid(strictVersion) && semver.valid(current) && semver.gt(strictVersion, current)) {
    CARDINAL.logger.info('boot', 'update available', { current, latest: strictVersion })
  }
}
