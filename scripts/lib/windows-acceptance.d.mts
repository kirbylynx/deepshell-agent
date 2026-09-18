export interface WindowsAcceptanceUnfixedDefect {
  id: string
  summary: string
}

export interface RecordedWindowsAcceptance {
  recorded: true
  record: string
  statusCode?: string
  summary?: string
  scope: string
  unfixed: WindowsAcceptanceUnfixedDefect[]
}

export interface UnrecordedWindowsAcceptance {
  recorded: false
}

export const WindowsStatusCode: {
  readonly AcceptedOnDevice: 'accepted-on-device'
  readonly PartiallyAcceptedOnDevice: 'partially-accepted-on-device'
  readonly NotRecorded: 'not-recorded-for-this-version'
}

export const windowsStatusCodes: readonly string[]

export const windowsAcceptance: Record<string, {
  record: string
  statusCode?: string
  summary?: string
  scope: string
  unfixed: WindowsAcceptanceUnfixedDefect[]
}>

export function acceptanceFor(
  version: string,
): RecordedWindowsAcceptance | UnrecordedWindowsAcceptance

export function windowsNotesLine(version: string): string

export function windowsManifestFields(version: string): {
  windowsStatusCode: string
  windowsStatusSummary: string
  windowsAcceptanceRecord: string | null
  windowsAcceptanceScope: string | null
}
