export interface WindowsAcceptanceUnfixedDefect {
  id: string
  summary: string
}

export interface RecordedWindowsAcceptance {
  recorded: true
  status: string
  record: string
  scope: string
  unfixed: WindowsAcceptanceUnfixedDefect[]
}

export interface UnrecordedWindowsAcceptance {
  recorded: false
  status: string
}

export const windowsAcceptance: Record<string, {
  status: string
  record: string
  scope: string
  unfixed: WindowsAcceptanceUnfixedDefect[]
}>

export function acceptanceFor(
  version: string,
): RecordedWindowsAcceptance | UnrecordedWindowsAcceptance

export function windowsNotesLine(version: string): string

export function windowsManifestFields(version: string): {
  windowsStatus: string
  windowsAcceptanceRecord: string | null
  windowsAcceptanceScope: string | null
}
