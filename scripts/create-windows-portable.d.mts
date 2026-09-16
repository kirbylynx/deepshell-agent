export const PORTABLE_ROOT_NAME: string
export function portablePaths(packageRoot: string, version: string): {
  stageBase: string
  stagingParent: string
  stagingPath: string
  extractParent: string
  extractedPath: string
  archivePath: string
}
export const portableAllowlist: Array<{ target: string; source: string; kind: 'file' | 'directory' }>
export const portableTopLevelEntries: string[]
export function assertPortableLayout(entries: string[], label?: string): void
export function assertPortableTargetPath(target: string): void
export function assertSafePortableStageBase(stageBase: string, packageRoot?: string): void
export function createWindowsPortable(): Promise<void>
