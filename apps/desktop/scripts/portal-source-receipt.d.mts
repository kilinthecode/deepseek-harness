/** Committed public inputs required to rebuild a local Portal presentation refresh. */
export interface PortalRefreshSource {
  readonly commit: string
  readonly lockSha256: string
  readonly packageManager: string
  readonly node: string
  readonly profile: 'portal'
}

/**
 * Require a clean source revision and a Portal build from that revision.
 * @param root - Git checkout containing the source and dependency lock.
 * @param environment - Public environment recorded by the client build.
 * @returns Rebuild inputs without private environment values.
 */
export function readPortalRefreshSource(root: string, environment: Record<string, string>): PortalRefreshSource
