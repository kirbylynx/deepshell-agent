export const packageSourceInputs: string[]
export const v013BaselineSourceInputs: string[]
export const v014BaselineSourceInputs: string[]
export const platformSourceInputs: Record<'darwin-arm64' | 'win32-x64', string[]>

export function deterministicInputDigest(
  workspaceRoot: string,
  inputs?: string[],
): Promise<string>

export function platformInputDigest(
  workspaceRoot: string,
  runtimePlatform: 'darwin-arm64' | 'win32-x64',
): Promise<string>

export function v013BaselineInputDigest(sourceRoot: string): Promise<string>
export function gitRevisionInputDigest(
  repositoryRoot: string,
  revision: string,
  inputs: string[],
): Promise<string>
