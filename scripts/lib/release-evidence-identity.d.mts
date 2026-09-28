export function collectReleaseEvidenceIdentity(options?: {
  root?: string
  packageReportPath?: string
  packageManifestPath?: string
  expectedVersion?: string
}): Promise<Record<string, unknown>>

export function assertReleaseEvidenceIdentityMatchesReport(
  evidence: Record<string, unknown>,
  report: Record<string, unknown>,
  label: string,
): void

export function assertReleaseEvidenceIdentityMatchesExpected(
  evidence: Record<string, unknown>,
  expected: Record<string, unknown>,
  label: string,
): void
