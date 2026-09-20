import type { AppShellFragments } from './appShell.ts'

interface RobotsSetting {
  index?: unknown
  follow?: unknown
}

export function robotsDirective(robots: unknown): string | undefined {
  if (!robots || typeof robots !== 'object') {
    return undefined
  }
  const { index, follow } = robots as RobotsSetting
  return `${index === false ? 'noindex' : 'index'}, ${follow === false ? 'nofollow' : 'follow'}`
}

export function robotsShellFragments(robots: unknown): AppShellFragments {
  const directive = robotsDirective(robots)
  return directive ? { head: `<meta name="robots" content="${directive}">` } : {}
}
