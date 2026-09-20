import { compileTrustProxy, type TrustProxyFn } from '../../helpers/security.ts'

export function createLiveTrustProxy(): TrustProxyFn {
  let compiledFor: unknown = CARDINAL.config.security?.trustProxy ?? false
  let current = compileTrustProxy(compiledFor)

  return (addr, hop) => {
    const spec = CARDINAL.config.security?.trustProxy ?? false
    if (spec !== compiledFor) {
      try {
        current = compileTrustProxy(spec)
      } catch (err: any) {
        CARDINAL.logger.error(
          'http',
          'ignoring an invalid trustProxy setting; keeping the last valid one',
          { error: err }
        )
      }
      compiledFor = spec
    }
    return current(addr, hop)
  }
}
