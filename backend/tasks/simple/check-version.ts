import semver from 'semver'

const DEFAULT_RELEASES_URL = 'https://api.github.com/repos/dylan-hart/wiki/releases'

interface Release {
  tag_name: string
  published_at: string
  draft?: boolean
}

export async function task(): Promise<void> {
  if (CARDINAL.config.offline) {
    // -> `debug`: this runs daily and says the same thing every time on a deployment that is
    //    deliberately offline.
    CARDINAL.logger.debug('boot', 'skipping version check, offline mode')
    return
  }

  const feed = CARDINAL.config.update?.releasesUrl || DEFAULT_RELEASES_URL
  const versionResp = await fetch(`${feed}?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!versionResp.ok) {
    throw new Error(
      `Checking for latest version failed: ${versionResp.status} ${versionResp.statusText}`
    )
  }
  const releases = (await versionResp.json()) as Release[]
  const current = CARDINAL.version
  const includePrereleases = semver.prerelease(current) !== null
  const newest = releases
    .filter((r) => !r.draft && typeof r.tag_name === 'string' && semver.valid(r.tag_name))
    .map((r) => ({ version: semver.valid(r.tag_name) as string, publishedAt: r.published_at }))
    .filter((r) => includePrereleases || semver.prerelease(r.version) === null)
    .sort((a, b) => semver.rcompare(a.version, b.version))[0]
  if (!newest) {
    CARDINAL.logger.debug('boot', 'version check found no usable release', { feed })
    return
  }
  const strictVersion = newest.version
  // -> Spread, not replaced: `update` also holds `locales` (an operator's opt-out of the daily
  //    `updateLocales` sync, `base.yml`'s `update.locales`), which a bare assignment would discard,
  //    re-enabling locale syncing on an egress-restricted deployment regardless of what admin shows.
  CARDINAL.config.update = {
    ...CARDINAL.config.update,
    lastCheckedAt: new Date().toISOString(),
    version: strictVersion,
    versionDate: newest.publishedAt
  }
  await CARDINAL.configSvc.saveToDb(['update'])

  // -> Silent when already current: a daily "still up to date" is heartbeat, only a newer release is
  //    a state change. The failure path propagates instead of logging, so the scheduler writes the
  //    one record for it.
  if (semver.valid(strictVersion) && semver.valid(current) && semver.gt(strictVersion, current)) {
    CARDINAL.logger.info('boot', 'update available', { current, latest: strictVersion })
  }
}
