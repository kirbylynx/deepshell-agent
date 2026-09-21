export interface PackageBaselineFixture {
  baselineVersion: string
  canonicalSource: {
    tag: string
    peeledCommit: string
    baselineSourceInputSha256: string
  }
  measurement: { algorithm: string }
  artifacts?: Record<string, any>
  sourceTrees?: Record<string, any>
}

export function packageBaselinePath(workspaceRoot: string, version: string): string
export function loadPackageBaseline(workspaceRoot: string, version: string): Promise<PackageBaselineFixture>
export function packageBaselineArtifact(fixture: PackageBaselineFixture, artifactKind: string): any
export function packageBaselineSourceTree(fixture: PackageBaselineFixture, runtimePlatform: string, subject: string): any
