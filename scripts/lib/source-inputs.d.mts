export const packageSourceInputs: string[]

export function deterministicInputDigest(
  workspaceRoot: string,
  inputs?: string[],
): Promise<string>
