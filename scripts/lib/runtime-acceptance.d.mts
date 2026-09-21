export declare const runtimeOwnedFileLimit: number
export declare const minimumPerformanceRuns: number
export declare const minimumIdleSeconds: number
export declare const nativeCacheControlFiles: number

export declare function summarizeRuntimeAcceptance(
  evidence: Record<string, any>,
  expected: { applicationVersion: string; target: string; dshVersion: string; nodeVersion: string; seaSha256: string },
  onDevice: Record<string, any>,
): Record<string, any>
