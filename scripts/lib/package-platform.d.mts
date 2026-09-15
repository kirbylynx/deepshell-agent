export interface PackageAdapter {
  platform: string
  runtimePlatform: () => string
  artifactKind: string
  artifactPath: string
  requiredArtifacts: string[]
  forbiddenArtifacts: string[]
  [key: string]: unknown
}

export function packageAdapter(
  platform: string,
  lock: { dsh: { entry: string } },
  artifactKind?: string,
  options?: Record<string, string>,
): PackageAdapter
