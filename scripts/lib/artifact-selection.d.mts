export function uniqueMatchingArtifact(
  names: string[],
  predicate: (name: string) => boolean,
  label: string,
): string | null

export function artifactVersionPattern(version: string): RegExp
export function artifactNameMatchesVersion(name: string, version: string): boolean
export function isWindowsNsisInstallerName(name: string, version: string): boolean
export function isMacosDmgName(name: string, version: string): boolean
export function selectWindowsNsisInstallerName(names: string[], version: string, label?: string): string | null
export function selectMacosDmgName(names: string[], version: string, label?: string): string | null
export function assertArtifactNameMatchesVersion(
  name: string,
  version: string,
  label: string,
  matcher?: (name: string, version: string) => boolean,
): void
