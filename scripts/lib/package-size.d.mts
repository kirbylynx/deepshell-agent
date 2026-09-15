export interface SizeMetric {
  status: string
  bytes?: number
  files?: number
}

export function verifyReducedTree(
  current: SizeMetric,
  baseline: SizeMetric,
  label: string,
): { deltaBytes: number; deltaFiles: number }

export function verifyReducedFile(
  current: SizeMetric,
  baseline: SizeMetric,
  label: string,
): { deltaBytes: number }
