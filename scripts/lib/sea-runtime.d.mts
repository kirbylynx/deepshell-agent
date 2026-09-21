export function seaTarget(lock: any, target: string): string
export function seaRuntimeFinalizedAtPrepare(target: string): boolean
export function seaRuntimePaths(target: string): Record<string, string>
export function inventoryContentSha256(entries: any[]): string
export function isForeignTargetPath(target: string, path: string): boolean
export function stageSeaInput(target: string, destination: string): Promise<any[]>
export function applySeaCompatibilityTransforms(destination: string): Promise<string[]>
export function verifyPackagerPatch(lock: any): Promise<{ path: string, sha256: string }>
export function packagerArguments(input: string, output: string): string[]
export function replaceFileTransactionally(temporary: string, destination: string): Promise<void>
export function writeFileTransactionally(path: string, content: string | Uint8Array): Promise<void>
export function generateSeaInventories(target: string, outputDirectory: string, dshRoot?: string): Promise<any>
export function seedIsolatedSeaArchive(lock: any, target: string, isolatedHome: string): Promise<any>
export function runPackager(options: any): Promise<{ bytes: number, sha256: string }>
export function readSeaReceipt(path: string): Promise<any>
export function writeSeaRuntimeManifest(paths: Record<string, string>, receipt: any, finalizedForPackage?: boolean): Promise<any>
export function gitHeadAndDirty(): Promise<{ head: string, provisional: boolean }>
export function inventoryReceipt(inventory: any, file: string): any
